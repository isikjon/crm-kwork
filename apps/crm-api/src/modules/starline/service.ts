import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HttpError } from "../../core/http/errors.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";

const STARLINE_APP_BASE_URL = "https://id.starline.ru";
const STARLINE_WEB_BASE_URL = "https://developer.starline.ru";
const STARLINE_TIMEZONE = "Europe/Moscow";
const SLNET_TTL_MS = 23 * 60 * 60_000;
const DEVICES_TTL_MS = 5 * 60 * 1000;

type StarLineStatusCode =
  | "online"
  | "offline"
  | "not_configured"
  | "not_found"
  | "ambiguous"
  | "missing_article"
  | "error";

type StarLineAuthSession = {
  userId: string;
  slnetCookie: string;
};

type CachedBox<T> = {
  value: T | null;
  expiresAt: number;
  inFlight: Promise<T> | null;
};

export type StarLineCredentials = {
  appId: string;
  appSecret: string;
  userLogin: string;
  userPassword: string;
};

export type StarLineDeviceSummary = {
  deviceId: string;
  name: string;
  alias?: string;
  online: boolean;
  lastSeenTs?: number;
  activityRaw: string;
  activityLabel: string;
};

type StarLineAppCodeResponse = {
  state?: number;
  desc?: {
    code?: string;
    message?: string;
  };
};

type StarLineAppTokenResponse = {
  state?: number;
  desc?: {
    token?: string;
    message?: string;
  };
};

type StarLineUserLoginResponse = {
  state?: number;
  desc?: {
    user_token?: string;
    message?: string;
  };
};

type StarLineSlnetResponse = {
  user_id?: string;
  code?: number;
  codestring?: string;
};

type StarLineDevicesResponse = {
  devices?: Array<{
    activity?: string;
    device_id?: string | number;
    name?: string;
    online?: string | number;
  }>;
  code?: number;
  codestring?: string;
};

type StarLineDeviceListResponse = {
  code?: number;
  codestring?: string;
  data?: {
    devices?: Array<{
      device_id?: string | number;
      alias?: string;
      status?: string | number;
      pos?: {
        ts?: string | number;
      } | null;
    }>;
  };
};

type OrderStarLineRow = {
  id: string;
  bikeUnit: {
    title: string;
    article?: string | null;
    bikeModel?: {
      article?: string | null;
    } | null;
  };
};

export interface StarLineSnapshot {
  article: string;
  bikeName: string;
  status: StarLineStatusCode;
  deviceId?: string;
  deviceName?: string;
  lastSeenAt?: string;
  lastSeenLabel?: string;
  detail?: string;
}

const authSessionCache = new Map<string, CachedBox<StarLineAuthSession>>();
const deviceListCache = new Map<string, CachedBox<StarLineDeviceSummary[]>>();

function md5Hex(value: string) {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function sha1Hex(value: string) {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

function normalizeText(value: string | undefined) {
  return (value ?? "").toLocaleLowerCase().replaceAll("ё", "е").trim();
}

function normalizeSearchText(value: string | undefined) {
  return normalizeText(value).replace(/[^a-zа-я0-9]+/gi, "");
}

export function hasFullStarLineCredentials(credentials: StarLineCredentials | null): credentials is StarLineCredentials {
  return Boolean(
    credentials?.appId.trim()
    && credentials.appSecret.trim()
    && credentials.userLogin.trim()
    && credentials.userPassword.trim()
  );
}

function buildScopeKey(tenantId: string, credentials: StarLineCredentials) {
  const secretHash = createHash("sha1")
    .update([
      credentials.appSecret.trim(),
      credentials.userPassword.trim()
    ].join(":"))
    .digest("hex")
    .slice(0, 12);

  return `${tenantId}:${credentials.appId.trim()}:${credentials.userLogin.trim().toLocaleLowerCase()}:${secretHash}`;
}

function formatStarLineTimestamp(value: number | undefined) {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return "";
  }

  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: STARLINE_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const encodings = ["latin1", "utf8"] as const;

  for (const encoding of encodings) {
    const text = buffer.toString(encoding).trim();
    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // try next encoding
    }
  }

  throw new HttpError(502, "StarLine returned invalid JSON");
}

function extractSlnetCookie(response: Response) {
  const rawHeaders = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const combined = rawHeaders.length ? rawHeaders : [response.headers.get("set-cookie") ?? ""];

  for (const item of combined) {
    const match = item.match(/(?:^|[;,\s])slnet=([^;,\s]+)/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  throw new HttpError(502, "StarLine did not return slnet cookie");
}

async function fetchStarLineJson<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const data = await readJsonResponse<T>(response);
  return { response, data };
}

async function readCachedBox<T>(box: CachedBox<T>, ttlMs: number, loader: () => Promise<T>) {
  if (box.value && box.expiresAt > Date.now()) {
    return box.value;
  }

  if (!box.inFlight) {
    box.inFlight = loader()
      .then((value) => {
        box.value = value;
        box.expiresAt = Date.now() + ttlMs;
        return value;
      })
      .finally(() => {
        box.inFlight = null;
      });
  }

  return box.inFlight;
}

function trimTrailingClosers(raw: string) {
  let candidate = raw.trimEnd();

  while (candidate.length > 0) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      const lastChar = candidate[candidate.length - 1];
      if (lastChar !== "}" && lastChar !== "]") {
        break;
      }
      candidate = candidate.slice(0, -1).trimEnd();
    }
  }

  return raw;
}

async function loadCredentialsFromLegacyConfig(): Promise<StarLineCredentials | null> {
  const configPath = path.join(env.LEGACY_CRM_DATA_DIR, "config.local.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(trimTrailingClosers(raw)) as {
      starline?: {
        appId?: string;
        appSecret?: string;
        userLogin?: string;
        userPassword?: string;
      };
    };

    return {
      appId: String(parsed.starline?.appId ?? "").trim(),
      appSecret: String(parsed.starline?.appSecret ?? "").trim(),
      userLogin: String(parsed.starline?.userLogin ?? "").trim(),
      userPassword: String(parsed.starline?.userPassword ?? "").trim()
    };
  } catch {
    return null;
  }
}

export async function loadStarLineCredentials(tenantId: string, options?: { includeLegacyFallback?: boolean }) {
  const integration = await prisma.integration.findFirst({
    where: {
      tenantId,
      kind: "STARLINE",
      status: "CONNECTED"
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      externalAccountId: true,
      secretKey: true,
      login: true,
      password: true
    }
  });

  const integrationCredentials: StarLineCredentials | null = integration
    ? {
        appId: String(integration.externalAccountId ?? "").trim(),
        appSecret: String(integration.secretKey ?? "").trim(),
        userLogin: String(integration.login ?? "").trim(),
        userPassword: String(integration.password ?? "").trim()
      }
    : null;

  if (hasFullStarLineCredentials(integrationCredentials)) {
    return integrationCredentials;
  }

  if (options?.includeLegacyFallback === false) {
    return integrationCredentials;
  }

  const legacyCredentials = await loadCredentialsFromLegacyConfig();
  if (hasFullStarLineCredentials(legacyCredentials)) {
    return legacyCredentials;
  }

  return integrationCredentials ?? legacyCredentials;
}

async function getAppToken(credentials: StarLineCredentials) {
  const codeUrl = new URL("/apiV3/application/getCode", STARLINE_APP_BASE_URL);
  codeUrl.searchParams.set("appId", credentials.appId);
  codeUrl.searchParams.set("secret", md5Hex(credentials.appSecret));

  const { data: codeData } = await fetchStarLineJson<StarLineAppCodeResponse>(codeUrl.toString());
  const code = String(codeData.desc?.code ?? "").trim();
  if (codeData.state !== 1 || !code) {
    throw new HttpError(502, `StarLine app code failed (${String(codeData.desc?.message ?? "unknown")})`);
  }

  const tokenUrl = new URL("/apiV3/application/getToken", STARLINE_APP_BASE_URL);
  tokenUrl.searchParams.set("appId", credentials.appId);
  tokenUrl.searchParams.set("secret", md5Hex(`${credentials.appSecret}${code}`));

  const { data: tokenData } = await fetchStarLineJson<StarLineAppTokenResponse>(tokenUrl.toString());
  const appToken = String(tokenData.desc?.token ?? "").trim();
  if (tokenData.state !== 1 || !appToken) {
    throw new HttpError(502, `StarLine app token failed (${String(tokenData.desc?.message ?? "unknown")})`);
  }

  return appToken;
}

async function getSlnetSessionFresh(credentials: StarLineCredentials): Promise<StarLineAuthSession> {
  const appToken = await getAppToken(credentials);
  const body = new URLSearchParams({
    login: credentials.userLogin,
    pass: sha1Hex(credentials.userPassword),
    user_ip: "0.0.0.0"
  });

  const { data: loginData } = await fetchStarLineJson<StarLineUserLoginResponse>(
    new URL("/apiV3/user/login", STARLINE_APP_BASE_URL).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        token: appToken
      },
      body: body.toString()
    }
  );

  const userToken = String(loginData.desc?.user_token ?? "").trim();
  const loginMessage = normalizeText(loginData.desc?.message);
  if (loginData.state === 2 || loginMessage.includes("sms")) {
    throw new HttpError(422, "StarLine requires SMS confirmation and cannot sync automatically");
  }

  if (loginMessage.includes("captcha")) {
    throw new HttpError(422, "StarLine requested captcha for this account");
  }

  if (loginData.state !== 1 || !userToken) {
    throw new HttpError(422, `StarLine login failed (${String(loginData.desc?.message ?? "unknown")})`);
  }

  const { response, data: slnetData } = await fetchStarLineJson<StarLineSlnetResponse>(
    new URL("/json/v2/auth.slid", STARLINE_WEB_BASE_URL).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        slid_token: userToken
      })
    }
  );

  if (Number(slnetData.code ?? 0) !== 200 || !String(slnetData.user_id ?? "").trim()) {
    throw new HttpError(502, `StarLine web auth failed (${String(slnetData.codestring ?? "unknown")})`);
  }

  return {
    userId: String(slnetData.user_id ?? "").trim(),
    slnetCookie: extractSlnetCookie(response)
  };
}

async function getSlnetSession(tenantId: string, credentials: StarLineCredentials) {
  const key = buildScopeKey(tenantId, credentials);
  const box = authSessionCache.get(key) ?? {
    value: null,
    expiresAt: 0,
    inFlight: null
  };
  authSessionCache.set(key, box);
  return readCachedBox(box, SLNET_TTL_MS, () => getSlnetSessionFresh(credentials));
}

async function listDevicesFresh(tenantId: string, credentials: StarLineCredentials) {
  const session = await getSlnetSession(tenantId, credentials);
  const baseUrl = new URL(`/json/v1/user/${encodeURIComponent(session.userId)}/devices`, STARLINE_WEB_BASE_URL);
  const listUrl = new URL(`/json/v1/user/${encodeURIComponent(session.userId)}/deviceList`, STARLINE_WEB_BASE_URL);
  listUrl.searchParams.set("status", "true");
  listUrl.searchParams.set("alias", "true");
  listUrl.searchParams.set("pos", "true");

  const headers = {
    Cookie: `slnet=${session.slnetCookie}`
  };

  const [{ data }, { data: listData }] = await Promise.all([
    fetchStarLineJson<StarLineDevicesResponse>(baseUrl.toString(), { headers }),
    fetchStarLineJson<StarLineDeviceListResponse>(listUrl.toString(), { headers })
  ]);

  if (Number(data.code ?? 0) !== 200) {
    throw new HttpError(502, `StarLine devices failed (${String(data.codestring ?? "unknown")})`);
  }

  if (Number(listData.code ?? 0) !== 200) {
    throw new HttpError(502, `StarLine deviceList failed (${String(listData.codestring ?? "unknown")})`);
  }

  const extraById = new Map<string, {
    alias?: string;
    online?: boolean;
    lastSeenTs?: number;
    activityLabel?: string;
  }>();

  for (const row of listData.data?.devices ?? []) {
    const deviceId = String(row.device_id ?? "").trim();
    if (!deviceId) {
      continue;
    }

    const lastSeenTsRaw = Number(row.pos?.ts ?? 0);
    const lastSeenTs = Number.isFinite(lastSeenTsRaw) && lastSeenTsRaw > 0 ? lastSeenTsRaw : undefined;
    extraById.set(deviceId, {
      alias: String(row.alias ?? "").trim() || undefined,
      online: String(row.status ?? "").trim() === "1" || Number(row.status ?? 0) === 1,
      lastSeenTs,
      activityLabel: formatStarLineTimestamp(lastSeenTs)
    });
  }

  const devices = new Map<string, StarLineDeviceSummary>();

  for (const row of data.devices ?? []) {
    const deviceId = String(row.device_id ?? "").trim();
    const extra = extraById.get(deviceId);
    const activityRaw = String(row.activity ?? "").trim();
    devices.set(deviceId, {
      deviceId,
      name: String(row.name ?? "").trim() || String(extra?.alias ?? "").trim(),
      alias: extra?.alias,
      online: extra?.online ?? (String(row.online ?? "").trim() === "1" || Number(row.online ?? 0) === 1),
      lastSeenTs: extra?.lastSeenTs,
      activityRaw,
      activityLabel: extra?.activityLabel || activityRaw || "Нет данных"
    });
  }

  for (const row of listData.data?.devices ?? []) {
    const deviceId = String(row.device_id ?? "").trim();
    if (!deviceId || devices.has(deviceId)) {
      continue;
    }

    const alias = String(row.alias ?? "").trim();
    const lastSeenTsRaw = Number(row.pos?.ts ?? 0);
    const lastSeenTs = Number.isFinite(lastSeenTsRaw) && lastSeenTsRaw > 0 ? lastSeenTsRaw : undefined;
    devices.set(deviceId, {
      deviceId,
      name: alias || deviceId,
      alias: alias || undefined,
      online: String(row.status ?? "").trim() === "1" || Number(row.status ?? 0) === 1,
      lastSeenTs,
      activityRaw: lastSeenTs ? String(lastSeenTs) : "",
      activityLabel: formatStarLineTimestamp(lastSeenTs) || "Нет данных"
    });
  }

  return [...devices.values()].filter((device) => device.deviceId && device.name);
}

async function listDevices(tenantId: string, credentials: StarLineCredentials) {
  const key = buildScopeKey(tenantId, credentials);
  const box = deviceListCache.get(key) ?? {
    value: null,
    expiresAt: 0,
    inFlight: null
  };
  deviceListCache.set(key, box);
  return readCachedBox(box, DEVICES_TTL_MS, () => listDevicesFresh(tenantId, credentials));
}

function getBikeCandidate(row: OrderStarLineRow) {
  const article = String(row.bikeUnit.article ?? row.bikeUnit.bikeModel?.article ?? "").trim();
  return {
    article,
    bikeName: String(row.bikeUnit.title ?? "").trim()
  };
}

export function findMatchingStarLineDevices(devices: StarLineDeviceSummary[], article: string) {
  const normalizedArticle = normalizeSearchText(article);
  if (!normalizedArticle) {
    return [];
  }

  const exact: StarLineDeviceSummary[] = [];
  const partial: StarLineDeviceSummary[] = [];

  for (const device of devices) {
    const normalizedFields = [
      normalizeSearchText(device.name),
      normalizeSearchText(device.alias)
    ].filter(Boolean);

    if (!normalizedFields.length) {
      continue;
    }

    if (normalizedFields.some((field) => field === normalizedArticle || field.endsWith(normalizedArticle))) {
      exact.push(device);
      continue;
    }

    if (normalizedFields.some((field) => field.includes(normalizedArticle))) {
      partial.push(device);
    }
  }

  return exact.length ? exact : partial;
}

export async function testStarLineConnection(credentials: StarLineCredentials) {
  const devices = await listDevicesFresh("__gps_test__", credentials);

  return {
    ok: true,
    deviceCount: devices.length,
    devices
  };
}

export async function loadStarLineDevicesForTenant(tenantId: string, credentials: StarLineCredentials) {
  return listDevices(tenantId, credentials);
}

export function formatStarLineLastSeen(value: number | undefined) {
  return formatStarLineTimestamp(value);
}

export async function enrichOrdersWithStarLine<T extends OrderStarLineRow>(
  tenantId: string,
  rows: T[]
): Promise<Array<T & { starline: StarLineSnapshot | null }>> {
  if (!rows.length) {
    return rows.map((row) => ({ ...row, starline: null }));
  }

  const candidates = new Map(rows.map((row) => [row.id, getBikeCandidate(row)]));
  const credentials = await loadStarLineCredentials(tenantId);

  if (!hasFullStarLineCredentials(credentials)) {
    return rows.map((row) => {
      const candidate = candidates.get(row.id);
      if (!candidate) {
        return { ...row, starline: null };
      }

      return {
        ...row,
        starline: {
          article: candidate.article,
          bikeName: candidate.bikeName,
          status: candidate.article ? "not_configured" : "missing_article",
          detail: candidate.article
            ? "StarLine еще не подключен в новой CRM"
            : "У велосипеда нет артикула для автопривязки GPS"
        }
      };
    });
  }

  try {
    const devices = await listDevices(tenantId, credentials);

    return rows.map((row) => {
      const candidate = candidates.get(row.id);
      if (!candidate) {
        return { ...row, starline: null };
      }

      if (!candidate.article) {
        return {
          ...row,
          starline: {
            article: candidate.article,
            bikeName: candidate.bikeName,
            status: "missing_article",
            detail: "У велосипеда нет артикула для автопривязки GPS"
          }
        };
      }

      const matched = findMatchingStarLineDevices(devices, candidate.article);
      if (!matched.length) {
        return {
          ...row,
          starline: {
            article: candidate.article,
            bikeName: candidate.bikeName,
            status: "not_found",
            detail: "Устройство по артикулу не найдено"
          }
        };
      }

      if (matched.length > 1) {
        return {
          ...row,
          starline: {
            article: candidate.article,
            bikeName: candidate.bikeName,
            status: "ambiguous",
            detail: `Найдено несколько GPS-устройств (${matched.length})`
          }
        };
      }

      const device = matched[0];
      return {
        ...row,
        starline: {
          article: candidate.article,
          bikeName: candidate.bikeName,
          status: device.online ? "online" : "offline",
          deviceId: device.deviceId,
          deviceName: device.name || device.alias || candidate.bikeName,
          lastSeenAt: device.lastSeenTs ? String(device.lastSeenTs) : undefined,
          lastSeenLabel: device.online ? "" : device.activityLabel,
          detail: device.online ? "GPS в сети" : undefined
        }
      };
    });
  } catch {
    return rows.map((row) => {
      const candidate = candidates.get(row.id);
      if (!candidate) {
        return { ...row, starline: null };
      }

      return {
        ...row,
        starline: {
          article: candidate.article,
          bikeName: candidate.bikeName,
          status: "error",
          detail: "Не удалось загрузить статус StarLine"
        }
      };
    });
  }
}
