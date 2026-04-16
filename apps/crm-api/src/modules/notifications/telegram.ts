import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";

type TransactionClient = Prisma.TransactionClient;
type NotificationDbClient = TransactionClient | PrismaClient;

type TelegramIntegrationRow = {
  id: string;
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  label: string;
  baseUrl: string | null;
  externalAccountId: string | null;
  secretKey: string | null;
  accessToken: string | null;
  lastCheckedAt: Date | null;
  lastErrorText: string | null;
};

type TelegramQrFlow = {
  id: string;
  tenantId: string;
  createdAt: number;
  apiId: number;
  apiHash: string;
  token: Buffer;
  expiresAt: number;
  session: StringSession;
  client: TelegramClient;
};

type QrResolutionResult =
  | { status: "ok" }
  | { status: "pending"; token: Buffer; expiresAt: number };

const TELEGRAM_BASE_URL = "https://telegram.org";
const TELEGRAM_NETWORK_TIMEOUT_MS = 25_000;
const FLOW_TTL_MS = 10 * 60_000;
const MAX_CONNECT_DRAIN_ROWS = 24;
const MAX_NOTIFICATION_DRAIN_ROWS = 24;
const LIVE_NOTIFICATION_SCENARIO_TYPES = ["DEAL_CREATED", "PAYMENT_RECEIVED"] as const;

const activeQrFlows = new Map<string, TelegramQrFlow>();
const activeDispatches = new Set<string>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HttpError(504, message));
    }, timeoutMs);

    promise
      .then((result) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(result);
      })
      .catch((error) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        reject(error);
      });
  });
}

function parseApiId(rawValue: unknown): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "Укажите корректный Telegram API ID.");
  }

  return parsed;
}

function normalizeApiHash(rawValue: unknown): string {
  const apiHash = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!apiHash) {
    throw new HttpError(400, "Укажите Telegram API Hash.");
  }

  return apiHash;
}

function normalizeFlowId(rawValue: unknown): string {
  const flowId = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!flowId) {
    throw new HttpError(400, "Не указан flowId.");
  }

  return flowId;
}

function normalizeNotificationRecipient(recipient: string) {
  const trimmed = recipient.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith("@")) {
    return trimmed;
  }

  return /^[a-zA-Z0-9_]{3,}$/.test(trimmed) ? `@${trimmed}` : trimmed;
}

function encodeLoginToken(token: Buffer) {
  return token.toString("base64url");
}

function resolveQrExpiresAt(rawValue: unknown) {
  const now = Date.now();
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return now + FLOW_TTL_MS;
  }

  if (parsed > 1_000_000_000) {
    return Math.max(now + 30_000, Math.trunc(parsed * 1000));
  }

  return now + Math.max(30_000, Math.trunc(parsed * 1000));
}

function resolveTelegramAccountLabel(user: Api.User | null | undefined) {
  if (!user) {
    return "Telegram";
  }

  const firstName = String(user.firstName ?? "").trim();
  const lastName = String(user.lastName ?? "").trim();
  const username = String(user.username ?? "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (fullName && username) {
    return `${fullName} · @${username.replace(/^@/, "")}`;
  }

  if (fullName) {
    return fullName;
  }

  if (username) {
    return `@${username.replace(/^@/, "")}`;
  }

  return "Telegram";
}

function mapTelegramRuntimeError(error: unknown): HttpError {
  const message = typeof (error as { message?: unknown } | null)?.message === "string"
    ? String((error as { message?: unknown }).message)
    : typeof (error as { errorMessage?: unknown } | null)?.errorMessage === "string"
      ? String((error as { errorMessage?: unknown }).errorMessage)
      : error instanceof Error
        ? error.message
        : "Telegram error";
  const normalized = message.toLocaleLowerCase();

  if (
    message.includes("AUTH_KEY_UNREGISTERED")
    || message.includes("SESSION_REVOKED")
    || message.includes("SESSION_EXPIRED")
    || message.includes("USER_DEACTIVATED")
  ) {
    return new HttpError(401, "Сессия Telegram больше не действует. Подключите аккаунт заново.");
  }

  if (
    message.includes("AUTH_TOKEN_INVALID")
    || message.includes("AUTH_TOKEN_EXPIRED")
    || message.includes("AUTH_TOKEN_ALREADY_ACCEPTED")
  ) {
    return new HttpError(410, "QR-сессия Telegram устарела. Получите новый QR.");
  }

  if (message.includes("SESSION_PASSWORD_NEEDED")) {
    return new HttpError(409, "Telegram просит пароль 2FA.");
  }

  if (message.includes("PASSWORD_HASH_INVALID")) {
    return new HttpError(400, "Неверный пароль 2FA Telegram.");
  }

  if (/FLOOD_WAIT_\d+/.test(message)) {
    const seconds = Number(message.match(/FLOOD_WAIT_(\d+)/)?.[1] ?? 0);
    const suffix = seconds > 0 ? ` Подождите ${seconds} сек.` : "";
    return new HttpError(429, `Telegram временно ограничил действия.${suffix}`);
  }

  if (
    normalized.includes("not connected")
    || normalized.includes("connection")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("websocket")
    || normalized.includes("fetch failed")
    || normalized.includes("econn")
    || normalized.includes("enetunreach")
  ) {
    return new HttpError(502, "Telegram недоступен по сети. Повторите попытку позже.");
  }

  return error instanceof HttpError
    ? error
    : new HttpError(502, `Ошибка Telegram: ${message}`);
}

async function disposeQrFlow(flow: TelegramQrFlow | null | undefined) {
  if (!flow) {
    return;
  }

  try {
    await flow.client.disconnect();
  } catch {
    // ignore disconnect failures
  }
}

async function cancelTenantQrFlow(tenantId: string) {
  const flow = activeQrFlows.get(tenantId) ?? null;
  if (!flow) {
    return;
  }

  activeQrFlows.delete(tenantId);
  await disposeQrFlow(flow);
}

async function cleanupTenantQrFlow(tenantId: string) {
  const flow = activeQrFlows.get(tenantId) ?? null;
  if (!flow) {
    return null;
  }

  if (Date.now() - flow.createdAt <= FLOW_TTL_MS) {
    return flow;
  }

  activeQrFlows.delete(tenantId);
  await disposeQrFlow(flow);
  return null;
}

async function switchClientDc(client: TelegramClient, dcIdRaw: unknown) {
  const dcId = Number(dcIdRaw);
  if (!Number.isInteger(dcId) || dcId <= 0) {
    throw new HttpError(502, "Telegram вернул некорректный DC для авторизации.");
  }

  const switcher = client as unknown as { _switchDC?: (newDc: number) => Promise<boolean> };
  if (typeof switcher._switchDC !== "function") {
    throw new HttpError(502, "Клиент Telegram не поддерживает переключение DC.");
  }

  await withTimeout(
    switcher._switchDC(dcId),
    TELEGRAM_NETWORK_TIMEOUT_MS,
    "Telegram не отвечает при переключении DC. Повторите попытку позже."
  );
}

async function resolveQrLoginToken(client: TelegramClient, initial: Api.auth.TypeLoginToken): Promise<QrResolutionResult> {
  let current: Api.auth.TypeLoginToken = initial;

  for (let hop = 0; hop < 4; hop += 1) {
    if (current instanceof Api.auth.LoginTokenSuccess) {
      return { status: "ok" };
    }

    if (current instanceof Api.auth.LoginToken) {
      return {
        status: "pending",
        token: Buffer.from(current.token),
        expiresAt: resolveQrExpiresAt(current.expires)
      };
    }

    if (current instanceof Api.auth.LoginTokenMigrateTo) {
      await switchClientDc(client, current.dcId);
      current = await withTimeout(
        client.invoke(new Api.auth.ImportLoginToken({
          token: current.token
        })),
        TELEGRAM_NETWORK_TIMEOUT_MS,
        "Telegram не отвечает при переключении QR-авторизации. Повторите попытку позже."
      );
      continue;
    }

    break;
  }

  throw new HttpError(502, "Telegram вернул неподдерживаемый ответ при QR-авторизации.");
}

async function refreshQrFlowToken(flow: TelegramQrFlow): Promise<QrResolutionResult> {
  const exported = await withTimeout(
    flow.client.invoke(new Api.auth.ExportLoginToken({
      apiId: flow.apiId,
      apiHash: flow.apiHash,
      exceptIds: []
    })),
    TELEGRAM_NETWORK_TIMEOUT_MS,
    "Telegram не отвечает при обновлении QR. Повторите попытку позже."
  );

  return resolveQrLoginToken(flow.client, exported);
}

async function findLatestTelegramIntegration(db: NotificationDbClient, tenantId: string) {
  return db.integration.findFirst({
    where: {
      tenantId,
      kind: "TELEGRAM"
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      id: true,
      status: true,
      label: true,
      baseUrl: true,
      externalAccountId: true,
      secretKey: true,
      accessToken: true,
      lastCheckedAt: true,
      lastErrorText: true
    }
  });
}

function mapTelegramConnection(row: TelegramIntegrationRow | null) {
  const apiId = String(row?.externalAccountId ?? "").trim();
  const apiHash = String(row?.secretKey ?? "").trim();
  const accessToken = String(row?.accessToken ?? "").trim();

  return {
    kind: "TELEGRAM" as const,
    status: row?.status ?? "DISCONNECTED",
    connected: Boolean(apiId && apiHash && accessToken),
    configured: Boolean(apiId && apiHash),
    label: row?.label?.trim() || null,
    apiId: apiId || null,
    baseUrl: row?.baseUrl?.trim() || TELEGRAM_BASE_URL,
    lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
    lastErrorText: row?.lastErrorText ?? null
  };
}

async function getTelegramConnectionSnapshotByTenantId(db: NotificationDbClient, tenantId: string) {
  const integration = await findLatestTelegramIntegration(db, tenantId);
  return mapTelegramConnection(integration);
}

async function upsertTelegramIntegration(
  db: NotificationDbClient,
  params: {
    tenantId: string;
    status?: "CONNECTED" | "DISCONNECTED" | "ERROR";
    label?: string | null;
    apiId?: string | null;
    apiHash?: string | null;
    session?: string | null;
    lastErrorText?: string | null;
    checkedAt?: Date;
  }
) {
  const existing = await findLatestTelegramIntegration(db, params.tenantId);
  const checkedAt = params.checkedAt ?? new Date();
  const data = {
    kind: "TELEGRAM" as const,
    status: params.status ?? existing?.status ?? "DISCONNECTED",
    label: params.label?.trim() || existing?.label?.trim() || "Telegram",
    baseUrl: TELEGRAM_BASE_URL,
    externalAccountId: params.apiId === undefined ? (existing?.externalAccountId ?? null) : (params.apiId?.trim() || null),
    secretKey: params.apiHash === undefined ? (existing?.secretKey ?? null) : (params.apiHash?.trim() || null),
    accessToken: params.session === undefined ? (existing?.accessToken ?? null) : (params.session?.trim() || null),
    lastCheckedAt: checkedAt,
    lastErrorText: params.lastErrorText ?? null
  };

  if (existing) {
    return db.integration.update({
      where: {
        id: existing.id
      },
      data
    });
  }

  return db.integration.create({
    data: {
      tenantId: params.tenantId,
      ...data
    }
  });
}

async function resolveTelegramQrApiSettings(params: {
  tenantId: string;
  apiId?: string | null;
  apiHash?: string | null;
}) {
  const apiIdInput = params.apiId?.trim() ?? "";
  const apiHashInput = params.apiHash?.trim() ?? "";

  if (apiIdInput && apiHashInput) {
    return {
      apiId: parseApiId(apiIdInput),
      apiHash: normalizeApiHash(apiHashInput)
    };
  }

  const existing = await findLatestTelegramIntegration(prisma, params.tenantId);
  const apiIdStored = String(existing?.externalAccountId ?? "").trim();
  const apiHashStored = String(existing?.secretKey ?? "").trim();

  if (apiIdStored && apiHashStored) {
    return {
      apiId: parseApiId(apiIdStored),
      apiHash: normalizeApiHash(apiHashStored)
    };
  }

  throw new HttpError(400, "Укажите Telegram API ID и API Hash.");
}

function resolveRuntimeCredentials(row: TelegramIntegrationRow | null) {
  const apiId = String(row?.externalAccountId ?? "").trim();
  const apiHash = String(row?.secretKey ?? "").trim();
  const session = String(row?.accessToken ?? "").trim();

  if (!apiId || !apiHash || !session) {
    return null;
  }

  return {
    integrationId: row?.id ?? null,
    apiId: parseApiId(apiId),
    apiHash: normalizeApiHash(apiHash),
    session,
    label: row?.label?.trim() || null
  };
}

async function withTelegramClient<T>(params: {
  apiId: number;
  apiHash: string;
  session: string;
  worker: (client: TelegramClient) => Promise<T>;
}) {
  const session = new StringSession(params.session);
  const client = new TelegramClient(session, params.apiId, params.apiHash, {
    connectionRetries: 3
  });

  try {
    await withTimeout(
      client.connect(),
      TELEGRAM_NETWORK_TIMEOUT_MS,
      "Telegram не отвечает при подключении. Повторите попытку позже."
    );

    return await params.worker(client);
  } catch (error) {
    throw mapTelegramRuntimeError(error);
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect failures
    }
  }
}

async function resolveTelegramAccountLabelFromSession(params: {
  apiId: number;
  apiHash: string;
  session: string;
}) {
  try {
    return await withTelegramClient({
      apiId: params.apiId,
      apiHash: params.apiHash,
      session: params.session,
      worker: async (client) => {
        const me = await client.getMe();
        return resolveTelegramAccountLabel(me);
      }
    });
  } catch {
    return "Telegram";
  }
}

async function finalizeQrConnected(flow: TelegramQrFlow, source: "saved" | "saved_immediately") {
  const sessionValue = flow.session.save().trim();
  if (!sessionValue) {
    throw new HttpError(500, "Не удалось получить Telegram String Session.");
  }

  const accountLabel = await withTimeout(
    flow.client.getMe(),
    TELEGRAM_NETWORK_TIMEOUT_MS,
    "Telegram не отвечает при завершении подключения. Повторите попытку позже."
  ).then((user) => resolveTelegramAccountLabel(user)).catch(() => "Telegram");

  await upsertTelegramIntegration(prisma, {
    tenantId: flow.tenantId,
    status: "CONNECTED",
    label: accountLabel || "Telegram",
    apiId: String(flow.apiId),
    apiHash: flow.apiHash,
    session: sessionValue,
    lastErrorText: null,
    checkedAt: new Date()
  });

  activeQrFlows.delete(flow.tenantId);
  await disposeQrFlow(flow);
  await drainQueuedTelegramNotificationsForTenant({
    tenantId: flow.tenantId,
    limit: MAX_CONNECT_DRAIN_ROWS
  });

  return {
    status: "ok" as const,
    source,
    connection: await getTelegramConnectionSnapshotByTenantId(prisma, flow.tenantId)
  };
}

async function sendTelegramNotificationWithClient(client: TelegramClient, params: {
  recipient: string;
  messageText: string;
  attachmentFilePath: string | null;
}) {
  const recipient = normalizeNotificationRecipient(params.recipient);
  const attachmentPath = params.attachmentFilePath?.trim() || "";

  if (attachmentPath) {
    try {
      await fs.access(attachmentPath);
      await client.sendFile(recipient, {
        file: attachmentPath,
        caption: params.messageText,
        forceDocument: false,
        workers: 1
      });
      return;
    } catch {
      // fall back to text-only send when attachment is unavailable
    }
  }

  await client.sendMessage(recipient, {
    message: params.messageText
  });
}

function mapDispatchResult(params: {
  id: string;
  status: "SENT" | "FAILED" | "SKIPPED";
  errorMessage?: string | null;
}) {
  return {
    id: params.id,
    status: params.status,
    errorMessage: params.errorMessage ?? null
  };
}

export async function startTelegramQrConnection(params: {
  tenantSlug: string;
  apiId?: string | null;
  apiHash?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  await cleanupTenantQrFlow(tenant.id);

  const { apiId, apiHash } = await resolveTelegramQrApiSettings({
    tenantId: tenant.id,
    apiId: params.apiId,
    apiHash: params.apiHash
  });

  await cancelTenantQrFlow(tenant.id);

  await upsertTelegramIntegration(prisma, {
    tenantId: tenant.id,
    apiId: String(apiId),
    apiHash,
    checkedAt: new Date()
  });

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });

  try {
    await withTimeout(
      client.connect(),
      TELEGRAM_NETWORK_TIMEOUT_MS,
      "Telegram не отвечает при подключении. Повторите попытку позже."
    );

    const exported = await withTimeout(
      client.invoke(new Api.auth.ExportLoginToken({
        apiId,
        apiHash,
        exceptIds: []
      })),
      TELEGRAM_NETWORK_TIMEOUT_MS,
      "Telegram не ответил при создании QR. Повторите попытку позже."
    );
    const resolved = await resolveQrLoginToken(client, exported);

    if (resolved.status === "ok") {
      const completed = await finalizeQrConnected({
        id: "immediate",
        tenantId: tenant.id,
        createdAt: Date.now(),
        apiId,
        apiHash,
        token: Buffer.alloc(0),
        expiresAt: Date.now() + FLOW_TTL_MS,
        session,
        client
      }, "saved_immediately");

      return {
        tenant,
        connected: true,
        qr: null,
        connection: completed.connection
      };
    }

    const flowId = crypto.randomUUID();
    activeQrFlows.set(tenant.id, {
      id: flowId,
      tenantId: tenant.id,
      createdAt: Date.now(),
      apiId,
      apiHash,
      token: resolved.token,
      expiresAt: resolved.expiresAt,
      session,
      client
    });

    return {
      tenant,
      connected: false,
      qr: {
        flowId,
        tgUrl: `tg://login?token=${encodeLoginToken(resolved.token)}`,
        expiresAt: new Date(resolved.expiresAt).toISOString()
      },
      connection: await getTelegramConnectionSnapshotByTenantId(prisma, tenant.id)
    };
  } catch (error) {
    const mapped = mapTelegramRuntimeError(error);
    await upsertTelegramIntegration(prisma, {
      tenantId: tenant.id,
      apiId: String(apiId),
      apiHash,
      status: "ERROR",
      lastErrorText: mapped.message,
      checkedAt: new Date()
    });
    await disposeQrFlow({
      id: "failed",
      tenantId: tenant.id,
      createdAt: Date.now(),
      apiId,
      apiHash,
      token: Buffer.alloc(0),
      expiresAt: Date.now(),
      session,
      client
    });
    throw mapped;
  }
}

export async function getTelegramQrConnectionStatus(params: {
  tenantSlug: string;
  flowId: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const flowId = normalizeFlowId(params.flowId);
  const flow = await cleanupTenantQrFlow(tenant.id);

  if (!flow || flow.id !== flowId) {
    throw new HttpError(410, "QR-сессия устарела. Нажмите «Получить QR» еще раз.");
  }

  if (Date.now() > flow.expiresAt) {
    try {
      const refreshed = await refreshQrFlowToken(flow);
      if (refreshed.status === "ok") {
        const completed = await finalizeQrConnected(flow, "saved");
        return {
          tenant,
          status: "ok" as const,
          qr: null,
          connection: completed.connection
        };
      }

      flow.token = refreshed.token;
      flow.expiresAt = refreshed.expiresAt;
      activeQrFlows.set(tenant.id, flow);
      return {
        tenant,
        status: "pending" as const,
        qr: {
          expiresAt: new Date(flow.expiresAt).toISOString(),
          tgUrl: `tg://login?token=${encodeLoginToken(flow.token)}`
        },
        connection: await getTelegramConnectionSnapshotByTenantId(prisma, tenant.id)
      };
    } catch (error) {
      throw mapTelegramRuntimeError(error);
    }
  }

  try {
    const result = await withTimeout(
      flow.client.invoke(new Api.auth.ImportLoginToken({
        token: flow.token
      })),
      TELEGRAM_NETWORK_TIMEOUT_MS,
      "Telegram не отвечает при проверке QR. Повторите попытку позже."
    );
    const resolved = await resolveQrLoginToken(flow.client, result);

    if (resolved.status === "ok") {
      const completed = await finalizeQrConnected(flow, "saved");
      return {
        tenant,
        status: "ok" as const,
        qr: null,
        connection: completed.connection
      };
    }

    flow.token = resolved.token;
    flow.expiresAt = resolved.expiresAt;
    activeQrFlows.set(tenant.id, flow);
    return {
      tenant,
      status: "pending" as const,
      qr: {
        expiresAt: new Date(flow.expiresAt).toISOString(),
        tgUrl: `tg://login?token=${encodeLoginToken(flow.token)}`
      },
      connection: await getTelegramConnectionSnapshotByTenantId(prisma, tenant.id)
    };
  } catch (error) {
    throw mapTelegramRuntimeError(error);
  }
}

export async function confirmTelegramQrConnectionPassword(params: {
  tenantSlug: string;
  flowId: string;
  password: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const flowId = normalizeFlowId(params.flowId);
  const password = params.password.trim();
  if (!password) {
    throw new HttpError(400, "Введите пароль 2FA.");
  }

  const flow = await cleanupTenantQrFlow(tenant.id);
  if (!flow || flow.id !== flowId) {
    throw new HttpError(410, "QR-сессия устарела. Нажмите «Получить QR» еще раз.");
  }

  try {
    await withTimeout(
      flow.client.signInWithPassword({ apiId: flow.apiId, apiHash: flow.apiHash }, {
        password: async () => password,
        onError: async (error) => {
          throw error;
        }
      }),
      TELEGRAM_NETWORK_TIMEOUT_MS,
      "Telegram не отвечает при проверке 2FA-пароля. Повторите попытку позже."
    );
  } catch (error) {
    throw mapTelegramRuntimeError(error);
  }

  const completed = await finalizeQrConnected(flow, "saved");
  return {
    tenant,
    status: completed.status,
    connection: completed.connection
  };
}

export async function resetTelegramConnection(params: {
  tenantSlug: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  await cancelTenantQrFlow(tenant.id);

  const existing = await findLatestTelegramIntegration(prisma, tenant.id);
  if (existing) {
    await upsertTelegramIntegration(prisma, {
      tenantId: tenant.id,
      status: "DISCONNECTED",
      label: existing.label,
      apiId: existing.externalAccountId,
      apiHash: existing.secretKey,
      session: null,
      lastErrorText: null,
      checkedAt: new Date()
    });
  }

  return {
    tenant,
    status: "ok" as const,
    connection: await getTelegramConnectionSnapshotByTenantId(prisma, tenant.id)
  };
}

export async function resolveTelegramConnectionSnapshot(params: {
  tenantSlug: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  return {
    tenant,
    connection: await getTelegramConnectionSnapshotByTenantId(prisma, tenant.id)
  };
}

export async function dispatchQueuedTelegramNotificationById(notificationId: string) {
  const normalizedId = notificationId.trim();
  if (!normalizedId) {
    throw new HttpError(400, "Не указан notificationId.");
  }

  if (activeDispatches.has(normalizedId)) {
    return null;
  }

  activeDispatches.add(normalizedId);

  try {
    const notification = await prisma.notification.findFirst({
      where: {
        id: normalizedId,
        channel: "TELEGRAM"
      },
      select: {
        id: true,
        tenantId: true,
        status: true,
        recipient: true,
        messageText: true,
        attachmentFilePath: true
      }
    });

    if (!notification || notification.status !== "QUEUED") {
      return null;
    }

    const integration = await findLatestTelegramIntegration(prisma, notification.tenantId);
    const runtime = resolveRuntimeCredentials(integration);

    if (!runtime) {
      await prisma.notification.update({
        where: {
          id: notification.id
        },
        data: {
          status: "FAILED",
          errorMessage: "Telegram не подключен."
        }
      });

      if (integration) {
        await upsertTelegramIntegration(prisma, {
          tenantId: notification.tenantId,
          status: "DISCONNECTED",
          label: integration.label,
          apiId: integration.externalAccountId,
          apiHash: integration.secretKey,
          session: integration.accessToken,
          lastErrorText: "Telegram не подключен.",
          checkedAt: new Date()
        });
      }

      return mapDispatchResult({
        id: notification.id,
        status: "FAILED",
        errorMessage: "Telegram не подключен."
      });
    }

    try {
      const accountLabel = await withTelegramClient({
        apiId: runtime.apiId,
        apiHash: runtime.apiHash,
        session: runtime.session,
        worker: async (client) => {
          await sendTelegramNotificationWithClient(client, {
            recipient: notification.recipient,
            messageText: notification.messageText,
            attachmentFilePath: notification.attachmentFilePath
          });

          const me = await client.getMe().catch(() => null);
          return resolveTelegramAccountLabel(me);
        }
      });

      await prisma.notification.update({
        where: {
          id: notification.id
        },
        data: {
          status: "SENT",
          sentAt: new Date(),
          errorMessage: null
        }
      });

      await upsertTelegramIntegration(prisma, {
        tenantId: notification.tenantId,
        status: "CONNECTED",
        label: accountLabel || runtime.label || "Telegram",
        apiId: String(runtime.apiId),
        apiHash: runtime.apiHash,
        session: runtime.session,
        lastErrorText: null,
        checkedAt: new Date()
      });

      return mapDispatchResult({
        id: notification.id,
        status: "SENT"
      });
    } catch (error) {
      const mapped = mapTelegramRuntimeError(error);

      await prisma.notification.update({
        where: {
          id: notification.id
        },
        data: {
          status: "FAILED",
          errorMessage: mapped.message
        }
      });

      await upsertTelegramIntegration(prisma, {
        tenantId: notification.tenantId,
        status: "ERROR",
        label: integration?.label ?? runtime.label ?? "Telegram",
        apiId: String(runtime.apiId),
        apiHash: runtime.apiHash,
        session: runtime.session,
        lastErrorText: mapped.message,
        checkedAt: new Date()
      });

      return mapDispatchResult({
        id: notification.id,
        status: "FAILED",
        errorMessage: mapped.message
      });
    }
  } finally {
    activeDispatches.delete(normalizedId);
  }
}

export async function drainQueuedTelegramNotificationsForTenant(params: {
  tenantId: string;
  limit?: number;
}) {
  const limit = Number.isInteger(params.limit) && Number(params.limit) > 0
    ? Math.min(MAX_NOTIFICATION_DRAIN_ROWS, Number(params.limit))
    : MAX_NOTIFICATION_DRAIN_ROWS;

  const rows = await prisma.notification.findMany({
    where: {
      tenantId: params.tenantId,
      channel: "TELEGRAM",
      status: "QUEUED",
      scenario: {
        is: {
          channel: "TELEGRAM",
          type: {
            in: [...LIVE_NOTIFICATION_SCENARIO_TYPES]
          }
        }
      }
    },
    orderBy: {
      createdAt: "asc"
    },
    take: limit,
    select: {
      id: true
    }
  });

  const results = [] as Array<{
    id: string;
    status: "SENT" | "FAILED" | "SKIPPED";
    errorMessage: string | null;
  }>;

  for (const row of rows) {
    const result = await dispatchQueuedTelegramNotificationById(row.id);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

export function triggerQueuedTelegramNotificationDispatch(notificationId: string | null | undefined) {
  const normalizedId = notificationId?.trim();
  if (!normalizedId) {
    return;
  }

  void dispatchQueuedTelegramNotificationById(normalizedId).catch(() => {
    // Deal/payment flows must not fail because Telegram transport is unavailable.
  });
}
