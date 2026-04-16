import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";

interface LegacyMoySkladConnection {
  authType: "token" | "basic";
  token?: string;
  login?: string;
  password?: string;
  baseUrl?: string;
}

interface LegacyMoySkladAttribute {
  name?: string;
  value?: unknown;
}

interface LegacyMoySkladCounterparty {
  name?: string;
  description?: string;
  companyType?: string;
  legalTitle?: string;
  inn?: string;
  legalAddress?: string;
  legalAddressFull?: string;
  actualAddress?: string;
  actualAddressFull?: string;
  legalLastName?: string;
  legalFirstName?: string;
  legalMiddleName?: string;
  birthDate?: string;
  sex?: string;
  phone?: string;
  email?: string;
  fax?: string;
  attributes?: LegacyMoySkladAttribute[];
}

interface ParsedRelativeCandidate {
  fullName: string;
  phone: string;
  comment: string | null;
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLabel(value: string) {
  return value.toLocaleLowerCase().replaceAll("ё", "е").trim();
}

function resolvePathFromHref(baseUrl: string, href: string) {
  const trimmed = href.trim();
  if (!trimmed) {
    throw new Error("Пустой href контрагента");
  }

  if (trimmed.startsWith(baseUrl)) {
    return trimmed.slice(baseUrl.length);
  }

  const absolute = new URL(trimmed);
  const base = new URL(baseUrl);
  const absolutePath = absolute.pathname + absolute.search;
  const basePath = base.pathname;

  if (absolute.origin === base.origin && absolutePath.startsWith(basePath)) {
    return absolutePath.slice(basePath.length) || "/";
  }

  throw new Error("href контрагента не относится к текущему API МойСклад");
}

function extractAttributeStringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }

  if (value && typeof value === "object") {
    if ("value" in value) {
      return extractAttributeStringValue((value as { value?: unknown }).value);
    }

    if ("name" in value && typeof (value as { name?: unknown }).name === "string") {
      return String((value as { name?: unknown }).name).trim();
    }
  }

  return "";
}

function readAttribute(counterparty: LegacyMoySkladCounterparty, names: string[]) {
  const wanted = new Set(names.map((name) => normalizeLabel(name)));
  for (const attribute of counterparty.attributes ?? []) {
    const attributeName = normalizeLabel(String(attribute.name ?? ""));
    if (!wanted.has(attributeName)) {
      continue;
    }

    const resolved = extractAttributeStringValue(attribute.value);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

function parseOptionalDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveClientName(counterparty: LegacyMoySkladCounterparty) {
  const parts = [
    normalizeString(counterparty.legalLastName),
    normalizeString(counterparty.legalFirstName),
    normalizeString(counterparty.legalMiddleName)
  ].filter(Boolean);

  return {
    lastName: normalizeString(counterparty.legalLastName) || null,
    firstName: normalizeString(counterparty.legalFirstName) || null,
    middleName: normalizeString(counterparty.legalMiddleName) || null,
    fullName: parts.join(" ").trim() || normalizeString(counterparty.name) || null
  };
}

function resolveClientType(companyType: string) {
  const normalized = normalizeLabel(companyType);
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("legal")
    || normalized.includes("юрид")
    || normalized.includes("организац")
    || normalized.includes("компания")
  ) {
    return "LEGAL_ENTITY" as const;
  }

  return "INDIVIDUAL" as const;
}

function chooseValue<T>(current: T | null | undefined, incoming: T | null | undefined, force = false) {
  if (force) {
    return incoming ?? current ?? null;
  }

  if (current !== null && current !== undefined && current !== "") {
    return current;
  }

  return incoming ?? current ?? null;
}

function extractRelativeCandidatesFromComment(comment: string): ParsedRelativeCandidate[] {
  const rows = comment
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  const candidates: ParsedRelativeCandidate[] = [];
  for (const row of rows) {
    const match = row.match(/^(\+?\d[\d\s()-]{7,}\d)\s*[.:-]?\s*(.+)$/);
    if (!match) {
      continue;
    }

    const phone = match[1].replace(/\s+/g, " ").trim();
    const fullName = match[2].trim().replace(/\s+/g, " ");
    if (!phone || !fullName) {
      continue;
    }

    candidates.push({
      fullName: fullName.slice(0, 160),
      phone: phone.slice(0, 64),
      comment: "Импортировано из комментария"
    });
  }

  return candidates;
}

async function readLegacyConnection(): Promise<LegacyMoySkladConnection | null> {
  const candidates = [
    env.LEGACY_MOYSKLAD_CONNECTION_FILE,
    path.join(env.LEGACY_CRM_DATA_DIR, "connection.json")
  ];

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as LegacyMoySkladConnection;
      if (parsed.authType !== "token" && parsed.authType !== "basic") {
        continue;
      }

      return parsed;
    } catch {
      // Try the next candidate path.
    }
  }

  return null;
}

function buildAuthorizationHeader(connection: LegacyMoySkladConnection) {
  const token = normalizeString(connection.token);
  if (token) {
    return `Bearer ${token}`;
  }

  const login = normalizeString(connection.login);
  const password = normalizeString(connection.password);
  if (!login || !password) {
    throw new Error("В connection.json не настроены credentials МойСклад");
  }

  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

async function fetchCounterpartyByHref(href: string) {
  const connection = await readLegacyConnection();
  if (!connection) {
    return null;
  }

  const baseUrl = normalizeString(connection.baseUrl) || "https://api.moysklad.ru/api/remap/1.2";
  const path = resolvePathFromHref(baseUrl, href);
  const [basePath, queryPart = ""] = path.split("?");
  const query = new URLSearchParams(queryPart);
  const expanded = query.get("expand") ?? "";
  const parts = expanded.split(",").map((item) => item.trim()).filter(Boolean);
  if (!parts.includes("attributes")) {
    parts.push("attributes");
  }
  if (parts.length) {
    query.set("expand", parts.join(","));
  }

  const response = await fetch(`${baseUrl}${basePath}${query.toString() ? `?${query.toString()}` : ""}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: buildAuthorizationHeader(connection)
    }
  });

  if (!response.ok) {
    throw new Error(`Ошибка МойСклад ${response.status}`);
  }

  return await response.json() as LegacyMoySkladCounterparty;
}

export async function hydrateClientFromLegacyCounterparty(params: {
  tenantId: string;
  clientId: string;
  legacyReference?: string | null;
  force?: boolean;
}) {
  const client = await prisma.client.findFirst({
    where: {
      id: params.clientId,
      tenantId: params.tenantId
    },
    select: {
      id: true,
      legacyReference: true,
      fullName: true,
      lastName: true,
      firstName: true,
      middleName: true,
      clientType: true,
      taxId: true,
      primaryPhone: true,
      telegramHandle: true,
      email: true,
      fax: true,
      maxHandle: true,
      courierId: true,
      address: true,
      legalTitle: true,
      gender: true,
      workplace: true,
      comment: true,
      relatives: {
        select: {
          fullName: true,
          phone: true
        }
      },
      identityData: {
        select: {
          id: true,
          passportSeries: true,
          passportNumber: true,
          issuedBy: true,
          issuedAt: true,
          departmentCode: true,
          birthDate: true,
          registeredAddress: true,
          registeredAddressFull: true,
          registeredAddressComment: true,
          registeredFiasCode: true,
          actualAddress: true,
          actualAddressFull: true,
          actualAddressComment: true,
          actualFiasCode: true
        }
      }
    }
  });

  if (!client) {
    return { updated: false, reason: "client_not_found" as const };
  }

  const legacyReference = params.legacyReference?.trim() || client.legacyReference?.trim() || "";
  if (!legacyReference) {
    return { updated: false, reason: "no_legacy_reference" as const };
  }

  const counterparty = await fetchCounterpartyByHref(legacyReference);
  if (!counterparty) {
    return { updated: false, reason: "no_connection" as const };
  }

  const name = resolveClientName(counterparty);
  const telegramHandle = readAttribute(counterparty, ["телеграмм", "telegram", "telegram username", "телеграм"]);
  const passportSeries = readAttribute(counterparty, ["серия", "паспорт серия"]);
  const passportNumber = readAttribute(counterparty, ["№", "номер", "паспорт номер"]);
  const issuedBy = readAttribute(counterparty, ["где выдан", "кем выдан"]);
  const issuedAt = parseOptionalDate(readAttribute(counterparty, ["дата выдачи"]));
  const departmentCode = readAttribute(counterparty, ["код подразделения"]);
  const workplace = readAttribute(counterparty, ["место работы", "работа"]);
  const maxHandle = readAttribute(counterparty, ["макс", "max"]);
  const courierId = readAttribute(counterparty, ["id курьера", "ид курьера", "курьер id", "courier id"]);
  const birthDate = parseOptionalDate(normalizeString(counterparty.birthDate));
  const actualAddress = normalizeString(counterparty.actualAddress);
  const actualAddressFull = normalizeString(counterparty.actualAddressFull);
  const registeredAddress = normalizeString(counterparty.legalAddress);
  const registeredAddressFull = normalizeString(counterparty.legalAddressFull);
  const relativeCandidates = extractRelativeCandidatesFromComment(normalizeString(counterparty.description));
  const existingRelativeKeys = new Set(
    client.relatives.map((relative) => `${relative.phone}::${relative.fullName}`.toLocaleLowerCase())
  );
  const newRelatives = relativeCandidates.filter((relative) => !existingRelativeKeys.has(`${relative.phone}::${relative.fullName}`.toLocaleLowerCase()));

  const nextClient = {
    fullName: chooseValue(client.fullName, name.fullName, params.force) ?? client.fullName,
    lastName: chooseValue(client.lastName, name.lastName, params.force),
    firstName: chooseValue(client.firstName, name.firstName, params.force),
    middleName: chooseValue(client.middleName, name.middleName, params.force),
    clientType: chooseValue(client.clientType, resolveClientType(normalizeString(counterparty.companyType)), params.force) ?? client.clientType,
    taxId: chooseValue(client.taxId, normalizeString(counterparty.inn) || null, params.force),
    primaryPhone: chooseValue(client.primaryPhone, normalizeString(counterparty.phone) || null, params.force),
    telegramHandle: chooseValue(client.telegramHandle, telegramHandle || null, params.force),
    email: chooseValue(client.email, normalizeString(counterparty.email) || null, params.force),
    fax: chooseValue(client.fax, normalizeString(counterparty.fax) || null, params.force),
    maxHandle: chooseValue(client.maxHandle, maxHandle || null, params.force),
    courierId: chooseValue(client.courierId, courierId || null, params.force),
    address: chooseValue(client.address, actualAddressFull || actualAddress || null, params.force),
    legalTitle: chooseValue(client.legalTitle, normalizeString(counterparty.legalTitle) || null, params.force),
    gender: chooseValue(client.gender, normalizeString(counterparty.sex) || null, params.force),
    workplace: chooseValue(client.workplace, workplace || null, params.force),
    comment: chooseValue(client.comment, normalizeString(counterparty.description) || null, params.force)
  };

  const nextIdentity = {
    passportSeries: chooseValue(client.identityData?.passportSeries, passportSeries || null, params.force),
    passportNumber: chooseValue(client.identityData?.passportNumber, passportNumber || null, params.force),
    issuedBy: chooseValue(client.identityData?.issuedBy, issuedBy || null, params.force),
    issuedAt: chooseValue(client.identityData?.issuedAt, issuedAt, params.force),
    departmentCode: chooseValue(client.identityData?.departmentCode, departmentCode || null, params.force),
    birthDate: chooseValue(client.identityData?.birthDate, birthDate, params.force),
    registeredAddress: chooseValue(client.identityData?.registeredAddress, registeredAddress || null, params.force),
    registeredAddressFull: chooseValue(client.identityData?.registeredAddressFull, registeredAddressFull || null, params.force),
    registeredAddressComment: chooseValue(client.identityData?.registeredAddressComment, null, params.force),
    registeredFiasCode: chooseValue(client.identityData?.registeredFiasCode, null, params.force),
    actualAddress: chooseValue(client.identityData?.actualAddress, actualAddress || null, params.force),
    actualAddressFull: chooseValue(client.identityData?.actualAddressFull, actualAddressFull || null, params.force),
    actualAddressComment: chooseValue(client.identityData?.actualAddressComment, null, params.force),
    actualFiasCode: chooseValue(client.identityData?.actualFiasCode, null, params.force)
  };

  const changed =
    JSON.stringify(nextClient) !== JSON.stringify({
      fullName: client.fullName,
      lastName: client.lastName,
      firstName: client.firstName,
      middleName: client.middleName,
      clientType: client.clientType,
      taxId: client.taxId,
      primaryPhone: client.primaryPhone,
      telegramHandle: client.telegramHandle,
      email: client.email,
      fax: client.fax,
      maxHandle: client.maxHandle,
      courierId: client.courierId,
      address: client.address,
      legalTitle: client.legalTitle,
      gender: client.gender,
      workplace: client.workplace,
      comment: client.comment
    })
    || JSON.stringify(nextIdentity) !== JSON.stringify({
      passportSeries: client.identityData?.passportSeries ?? null,
      passportNumber: client.identityData?.passportNumber ?? null,
      issuedBy: client.identityData?.issuedBy ?? null,
      issuedAt: client.identityData?.issuedAt ?? null,
      departmentCode: client.identityData?.departmentCode ?? null,
      birthDate: client.identityData?.birthDate ?? null,
      registeredAddress: client.identityData?.registeredAddress ?? null,
      registeredAddressFull: client.identityData?.registeredAddressFull ?? null,
      registeredAddressComment: client.identityData?.registeredAddressComment ?? null,
      registeredFiasCode: client.identityData?.registeredFiasCode ?? null,
      actualAddress: client.identityData?.actualAddress ?? null,
      actualAddressFull: client.identityData?.actualAddressFull ?? null,
      actualAddressComment: client.identityData?.actualAddressComment ?? null,
      actualFiasCode: client.identityData?.actualFiasCode ?? null
    })
    || newRelatives.length > 0;

  if (!changed) {
    return { updated: false, reason: "already_hydrated" as const };
  }

  await prisma.$transaction(async (tx) => {
    await tx.client.update({
      where: { id: client.id },
      data: nextClient
    });

    await tx.clientIdentityData.upsert({
      where: {
        clientId: client.id
      },
      create: {
        tenantId: params.tenantId,
        clientId: client.id,
        ...nextIdentity
      },
      update: nextIdentity
    });

    if (newRelatives.length > 0) {
      await tx.clientRelative.createMany({
        data: newRelatives.map((relative) => ({
          tenantId: params.tenantId,
          clientId: client.id,
          fullName: relative.fullName,
          phone: relative.phone,
          comment: relative.comment
        }))
      });
    }
  });

  return {
    updated: true,
    reason: "hydrated" as const
  };
}
