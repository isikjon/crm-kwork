import { createHash } from "node:crypto";
import {
  ImportIssueSeverity,
  ImportMatchQuality,
  ImportRowDecision,
  Prisma
} from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../core/http/errors.js";
import { rebuildBuyoutSchedule, rebuildRentalSchedule } from "../deals/schedule-service.js";
import { isAssignableBikeUnitName } from "../fleet/bike-unit-classifier.js";
import { hydrateClientFromLegacyCounterparty } from "../clients/legacy-counterparty-sync.js";
import { getLegacyOverview, loadLegacyDataBundle } from "../legacy/legacy-source.js";
import type {
  LegacyBuyoutPreset,
  LegacyOrderNote,
  LegacyOrderRow,
  LegacyPartialPaymentsFile
} from "../legacy/types.js";

const DEFAULT_TENANT_SLUG = "prokolesa";
const DEFAULT_TENANT_NAME = "ПРОКОЛЕСА";

export const SUPPORTED_LEGACY_ENTITY_TYPES = [
  "clients",
  "rental_deals",
  "buyout_deals",
  "notes_and_operational_flags",
  "bike_candidates_from_deals"
] as const;

type SupportedLegacyEntityType = (typeof SUPPORTED_LEGACY_ENTITY_TYPES)[number];
const CLIENT_ENRICHMENT_ENTITY_TYPE = "client_enrichment" as const;
type ImportJobEntityType = SupportedLegacyEntityType | typeof CLIENT_ENRICHMENT_ENTITY_TYPE;

type TransactionClient = Prisma.TransactionClient;

interface ImportEntitySummary {
  entityType: ImportJobEntityType;
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  createdRows: number;
  existingRows: number;
  skippedRows: number;
  warningRows: number;
  reliableRows: number;
  heuristicRows: number;
  logLines: string[];
}

interface ImportExecutionContext {
  tx: TransactionClient;
  tenantId: string;
  bikeModelIds: Map<string, string>;
  rentalIdsByOrderId: Map<string, string>;
  buyoutIdsByOrderId: Map<string, string>;
}

type SharedImportExecutionContext = Omit<ImportExecutionContext, "tx">;

interface ImportedRecordResult<TRecord extends { id: string }> {
  record: TRecord;
  created: boolean;
}

interface BikeCandidate {
  externalId: string;
  title: string;
  reference: string | null;
  modelName: string;
  article: string | null;
  internalCode: string;
  placeholder: boolean;
}

interface ImportJobRowDraft {
  sourceRecordKey: string;
  sourceRecordLabel: string;
  decision: ImportRowDecision;
  severity: ImportIssueSeverity;
  matchQuality?: ImportMatchQuality | null;
  matchedEntityType?: string | null;
  matchedEntityId?: string | null;
  matchedEntityLabel?: string | null;
  matchedBy?: string | null;
  issueCode?: string | null;
  issueText?: string | null;
  detailsText?: string | null;
}

interface DryRunLookupContext {
  tx: TransactionClient;
  tenantId: string;
  clientsByLegacyKey: Map<string, { id: string; fullName: string } | null>;
  bikeUnitsByLegacyKey: Map<string, { id: string; title: string } | null>;
  rentalsByLegacyKey: Map<string, { id: string; dealNumber: string } | null>;
  buyoutsByLegacyKey: Map<string, { id: string; dealNumber: string } | null>;
}

type ClientIdentityDescriptor = {
  externalId: string;
  label: string;
  quality: ImportMatchQuality;
  matchedBy: string;
  issueCode: string | null;
  issueText: string | null;
};

const LEGACY_RENTAL_STATES = new Set(["В Аренде", "Проблемы", "Выплата долга", "Аренда завершена", "Оплатил", "Доставлен"]);
const LEGACY_BUYOUT_STATES = new Set(["Выкуп", "Выкуп Завершен", "Продан", "Проблемы", "Выплата долга"]);

// Legacy import stays defensive on purpose: old operational JSON is messy, so heuristics + auditability are safer than aggressive cleanup.

function normalizeTenantSlug(input: string | undefined) {
  const raw = (input ?? DEFAULT_TENANT_SLUG).trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe || DEFAULT_TENANT_SLUG;
}

function normalizeTenantName(input: string | undefined) {
  const value = input?.trim();
  return value && value.length > 0 ? value : DEFAULT_TENANT_NAME;
}

function normalizeLegacyToken(input: string | null | undefined) {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9а-яё /._,-]/gi, "");
}

function buildImportName(input: string | undefined, dryRun: boolean) {
  const value = input?.trim();
  if (value) {
    return value;
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${dryRun ? "Legacy dry-run" : "Legacy import"} ${timestamp}`;
}

function buildJobLog(summary: ImportEntitySummary) {
  return [
    ...summary.logLines,
    `createdRows: ${summary.createdRows}`,
    `existingRows: ${summary.existingRows}`,
    `skippedRows: ${summary.skippedRows}`,
    `warningRows: ${summary.warningRows}`,
    `reliableRows: ${summary.reliableRows}`,
    `heuristicRows: ${summary.heuristicRows}`,
    `processedRows: ${summary.processedRows}`,
    `successRows: ${summary.successRows}`,
    `failedRows: ${summary.failedRows}`
  ].join("\n");
}

function serializeAuditValue(value: unknown) {
  const json = JSON.stringify(value, null, 2);
  if (!json) {
    return null;
  }

  return json.length > 12000 ? `${json.slice(0, 11997)}...` : json;
}

function stableHash(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function parseLegacyDate(input: string | null | undefined) {
  if (!input) {
    return new Date();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return new Date(`${input}T12:00:00.000Z`);
  }

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(input)) {
    const [day, month, year] = input.split(".");
    return new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  }

  return new Date(input);
}

function buildClientExternalId(order: LegacyOrderRow) {
  if (order.counterpartyHref) {
    const idFromHref = order.counterpartyHref.split("/").pop()?.trim();
    if (idFromHref) {
      return `counterparty:${idFromHref}`;
    }
  }

  const normalizedName = normalizeLegacyToken(order.customerName);
  if (normalizedName) {
    return `name:${normalizedName}`;
  }

  return `order:${order.id}:anonymous`;
}

function classifyDealKind(order: LegacyOrderRow): "rental" | "buyout" | "unknown" {
  const state = order.state?.trim() ?? "";

  if (state.includes("Выкуп") || LEGACY_BUYOUT_STATES.has(state)) {
    return "buyout";
  }

  if (state.includes("Аренда") || LEGACY_RENTAL_STATES.has(state)) {
    return "rental";
  }

  return "unknown";
}

function isLikelyBikeUnit(serviceName: string, assortmentType: string) {
  if (assortmentType !== "product") {
    return false;
  }

  return isAssignableBikeUnitName(serviceName);
}

function pickPrimaryBikeService(order: LegacyOrderRow) {
  return (order.services ?? [])
    .filter((service) => isLikelyBikeUnit(service.name, service.assortmentType))
    .sort((left, right) => right.name.length - left.name.length)[0];
}

function deriveBikeModelName(title: string) {
  return title.split(",")[0]?.trim() || title.trim() || "Legacy bike";
}

function extractArticleLikeToken(title: string) {
  const tokens = title.match(/\d[\dA-Z ]{5,}/g);
  return tokens?.[0]?.trim() ?? null;
}

function buildBikeCandidate(order: LegacyOrderRow): BikeCandidate {
  const bikeService = pickPrimaryBikeService(order);

  if (bikeService) {
    const externalId = `bike:${stableHash(normalizeLegacyToken(bikeService.name))}`;
    return {
      externalId,
      title: bikeService.name,
      reference: bikeService.assortmentHref ?? null,
      modelName: deriveBikeModelName(bikeService.name),
      article: extractArticleLikeToken(bikeService.name),
      internalCode: `LEG-${stableHash(externalId).slice(0, 10).toUpperCase()}`,
      placeholder: false
    };
  }

  const placeholderSeed = `placeholder:${order.id}`;
  return {
    externalId: placeholderSeed,
    title: `Legacy bike placeholder for order ${order.name}`,
    reference: order.id,
    modelName: "Legacy bike placeholder",
    article: null,
    internalCode: `LEG-${stableHash(placeholderSeed).slice(0, 10).toUpperCase()}`,
    placeholder: true
  };
}

function pickRentalTariff(order: LegacyOrderRow) {
  return (order.services ?? [])
    .filter((service) => Number(service.days ?? 0) > 0)
    .sort((left, right) => {
      const leftWeight = Number(left.quantity ?? 0) * Number(left.price ?? 0);
      const rightWeight = Number(right.quantity ?? 0) * Number(right.price ?? 0);
      return rightWeight - leftWeight || Number(right.days ?? 0) - Number(left.days ?? 0);
    })[0];
}

function summarizePartialPayments(
  orderId: string,
  partialPayments: LegacyPartialPaymentsFile["orders"]
) {
  const positions = Object.values(partialPayments[orderId] ?? {});
  return positions.reduce(
    (summary, position) => {
      summary.dueKopecks += Number(position.dueKopecks ?? 0);
      summary.paidKopecks += Number(position.paidKopecks ?? 0);
      summary.outstandingKopecks += Math.max(
        0,
        Number(position.dueKopecks ?? 0) - Number(position.paidKopecks ?? 0)
      );
      return summary;
    },
    {
      dueKopecks: 0,
      paidKopecks: 0,
      outstandingKopecks: 0
    }
  );
}

function mapRentalStatus(state: string | null | undefined) {
  switch ((state ?? "").trim()) {
    case "В Аренде":
      return "ACTIVE" as const;
    case "Проблемы":
    case "Выплата долга":
      return "OVERDUE" as const;
    case "Аренда завершена":
    case "Оплатил":
    case "Доставлен":
      return "COMPLETED" as const;
    case "Отменен":
      return "CANCELED" as const;
    default:
      return "NEW" as const;
  }
}

function mapBuyoutStatus(state: string | null | undefined) {
  switch ((state ?? "").trim()) {
    case "Выкуп":
      return "ACTIVE" as const;
    case "Проблемы":
    case "Выплата долга":
      return "OVERDUE" as const;
    case "Выкуп Завершен":
    case "Продан":
      return "CLOSED" as const;
    case "Отменен":
      return "TERMINATED" as const;
    default:
      return "NEW" as const;
  }
}

function mapCadenceFromPresets(presets: LegacyBuyoutPreset[] | undefined) {
  const preset = presets?.[0];
  if (!preset) {
    return "WEEKLY" as const;
  }

  if (preset.intervalUnit === "months") {
    return "MONTHLY" as const;
  }

  if (preset.intervalUnit === "days" && Number(preset.intervalValue ?? 0) <= 1) {
    return "DAILY" as const;
  }

  return "WEEKLY" as const;
}

function collectLegacyNotes(
  order: LegacyOrderRow,
  separateNotesMap: Record<string, LegacyOrderNote[]>
) {
  const merged = new Map<string, LegacyOrderNote>();

  for (const note of order.notes ?? []) {
    merged.set(`${note.text}|${note.color ?? ""}`, note);
  }

  for (const note of separateNotesMap[order.id] ?? []) {
    merged.set(`${note.text}|${note.color ?? ""}`, note);
  }

  return [...merged.values()];
}

function buildCommentLines(order: LegacyOrderRow, extra: string[]) {
  return [
    `Imported from legacy order ${order.name}`,
    `Legacy order id: ${order.id}`,
    ...extra
  ].join("\n");
}

function describeClientIdentity(order: LegacyOrderRow): ClientIdentityDescriptor {
  if (order.counterpartyHref) {
    const idFromHref = order.counterpartyHref.split("/").pop()?.trim();
    if (idFromHref) {
      return {
        externalId: `counterparty:${idFromHref}`,
        label: order.customerName?.trim() || `Legacy client ${order.name}`,
        quality: ImportMatchQuality.RELIABLE,
        matchedBy: "legacy counterparty href",
        issueCode: null,
        issueText: null
      };
    }
  }

  const normalizedName = normalizeLegacyToken(order.customerName);
  if (normalizedName) {
    return {
      externalId: `name:${normalizedName}`,
      label: order.customerName?.trim() || `Legacy client ${order.name}`,
      quality: ImportMatchQuality.HEURISTIC,
      matchedBy: "normalized customer name",
      issueCode: "client_identity_heuristic_name",
      issueText: "Ключ клиента построен только по имени из legacy-кэша, без stable counterparty id."
    };
  }

  return {
    externalId: `order:${order.id}:anonymous`,
    label: `Legacy client ${order.name}`,
    quality: ImportMatchQuality.HEURISTIC,
    matchedBy: "legacy order fallback",
    issueCode: "client_identity_placeholder",
    issueText: "В legacy нет ни counterparty id, ни имени клиента. Будет создан placeholder-клиент."
  };
}

function appendIssueNotes(base: string | null, extra: string[]) {
  const chunks = [base, ...extra]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return chunks.length > 0 ? chunks.join(" ") : null;
}

function createDryRunContext(tx: TransactionClient, tenantId: string): DryRunLookupContext {
  return {
    tx,
    tenantId,
    clientsByLegacyKey: new Map(),
    bikeUnitsByLegacyKey: new Map(),
    rentalsByLegacyKey: new Map(),
    buyoutsByLegacyKey: new Map()
  };
}

async function findExistingClientByLegacyKey(
  ctx: DryRunLookupContext,
  legacyExternalId: string
) {
  if (ctx.clientsByLegacyKey.has(legacyExternalId)) {
    return ctx.clientsByLegacyKey.get(legacyExternalId) ?? null;
  }

  const existing = await ctx.tx.client.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId
      }
    },
    select: {
      id: true,
      fullName: true
    }
  });

  ctx.clientsByLegacyKey.set(legacyExternalId, existing ?? null);
  return existing ?? null;
}

async function findExistingBikeUnitByLegacyKey(
  ctx: DryRunLookupContext,
  legacyExternalId: string
) {
  if (ctx.bikeUnitsByLegacyKey.has(legacyExternalId)) {
    return ctx.bikeUnitsByLegacyKey.get(legacyExternalId) ?? null;
  }

  const existing = await ctx.tx.bikeUnit.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId
      }
    },
    select: {
      id: true,
      title: true
    }
  });

  ctx.bikeUnitsByLegacyKey.set(legacyExternalId, existing ?? null);
  return existing ?? null;
}

async function findExistingRentalByLegacyKey(
  ctx: DryRunLookupContext,
  legacyExternalId: string
) {
  if (ctx.rentalsByLegacyKey.has(legacyExternalId)) {
    return ctx.rentalsByLegacyKey.get(legacyExternalId) ?? null;
  }

  const existing = await ctx.tx.rental.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId
      }
    },
    select: {
      id: true,
      dealNumber: true
    }
  });

  ctx.rentalsByLegacyKey.set(legacyExternalId, existing ?? null);
  return existing ?? null;
}

async function findExistingBuyoutByLegacyKey(
  ctx: DryRunLookupContext,
  legacyExternalId: string
) {
  if (ctx.buyoutsByLegacyKey.has(legacyExternalId)) {
    return ctx.buyoutsByLegacyKey.get(legacyExternalId) ?? null;
  }

  const existing = await ctx.tx.buyout.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId
      }
    },
    select: {
      id: true,
      dealNumber: true
    }
  });

  ctx.buyoutsByLegacyKey.set(legacyExternalId, existing ?? null);
  return existing ?? null;
}

function summarizeDryRunRows(summary: ImportEntitySummary, rows: ImportJobRowDraft[]) {
  summary.totalRows = rows.length;
  summary.processedRows = rows.length;
  summary.createdRows = rows.filter((row) => row.decision === ImportRowDecision.CREATE).length;
  summary.existingRows = rows.filter((row) => row.decision === ImportRowDecision.MATCH_EXISTING).length;
  summary.skippedRows = rows.filter((row) => row.decision === ImportRowDecision.SKIP).length;
  summary.failedRows = rows.filter((row) => row.decision === ImportRowDecision.FAIL).length;
  summary.successRows = rows.length - summary.failedRows;
  summary.warningRows = rows.filter((row) => row.severity === ImportIssueSeverity.WARNING).length;
  summary.reliableRows = rows.filter((row) => row.matchQuality === ImportMatchQuality.RELIABLE).length;
  summary.heuristicRows = rows.filter((row) => row.matchQuality === ImportMatchQuality.HEURISTIC).length;
}

function createSummary(entityType: ImportJobEntityType): ImportEntitySummary {
  return {
    entityType,
    totalRows: 0,
    processedRows: 0,
    successRows: 0,
    failedRows: 0,
    createdRows: 0,
    existingRows: 0,
    skippedRows: 0,
    warningRows: 0,
    reliableRows: 0,
    heuristicRows: 0,
    logLines: []
  };
}

function uniqueBy<TValue>(values: TValue[], getKey: (value: TValue) => string) {
  const map = new Map<string, TValue>();
  for (const value of values) {
    map.set(getKey(value), value);
  }
  return [...map.values()];
}

function expandLegacyEntityTypes(entityTypes?: SupportedLegacyEntityType[]) {
  const expanded = new Set<SupportedLegacyEntityType>(entityTypes ?? SUPPORTED_LEGACY_ENTITY_TYPES);

  if (expanded.has("rental_deals") || expanded.has("buyout_deals")) {
    expanded.add("clients");
    expanded.add("bike_candidates_from_deals");
  }

  if (expanded.has("notes_and_operational_flags")) {
    expanded.add("clients");
  }

  return [...expanded];
}

function shouldRunClientEnrichment(entityTypes: SupportedLegacyEntityType[]) {
  return entityTypes.includes("clients");
}

function buildImportJobEntityTypes(entityTypes: SupportedLegacyEntityType[], dryRun: boolean): ImportJobEntityType[] {
  if (dryRun || !shouldRunClientEnrichment(entityTypes)) {
    return [...entityTypes];
  }

  return [...entityTypes, CLIENT_ENRICHMENT_ENTITY_TYPE];
}

async function buildLegacyDiagnostics(params: {
  tenantId: string;
  bundle: Awaited<ReturnType<typeof loadLegacyDataBundle>>;
  entityTypes: SupportedLegacyEntityType[];
}) {
  return prisma.$transaction(async (tx) => {
    const dryRunCtx = createDryRunContext(tx, params.tenantId);
    const diagnostics = new Map<SupportedLegacyEntityType, { summary: ImportEntitySummary; rows: ImportJobRowDraft[] }>();

    if (params.entityTypes.includes("clients")) {
      diagnostics.set("clients", await buildClientDryRun(dryRunCtx, params.bundle.orders.rows));
    }

    if (params.entityTypes.includes("bike_candidates_from_deals")) {
      diagnostics.set("bike_candidates_from_deals", await buildBikeCandidateDryRun(dryRunCtx, params.bundle.orders.rows));
    }

    if (params.entityTypes.includes("rental_deals")) {
      diagnostics.set(
        "rental_deals",
        await buildRentalDealDryRun(dryRunCtx, params.bundle.orders.rows, params.bundle.partialPayments.orders)
      );
    }

    if (params.entityTypes.includes("buyout_deals")) {
      diagnostics.set(
        "buyout_deals",
        await buildBuyoutDealDryRun(dryRunCtx, params.bundle.orders.rows, params.bundle.config.buyoutPaymentPresets)
      );
    }

    if (params.entityTypes.includes("notes_and_operational_flags")) {
      diagnostics.set(
        "notes_and_operational_flags",
        await buildNotesDryRun(
          dryRunCtx,
          params.bundle.orders.rows,
          params.bundle.orderNotes.orders,
          params.bundle.batteryCounts.orders
        )
      );
    }

    return diagnostics;
  });
}

async function upsertTenantForImport(params: { tenantSlug?: string; tenantName?: string }) {
  const slug = normalizeTenantSlug(params.tenantSlug);
  const name = normalizeTenantName(params.tenantName);

  return prisma.tenant.upsert({
    where: { slug },
    update: { name },
    create: {
      slug,
      name
    }
  });
}

function filterLegacyTargets(
  targets: Awaited<ReturnType<typeof getLegacyOverview>>["importTargets"],
  entityTypes: SupportedLegacyEntityType[]
) {
  const allowSet = new Set(entityTypes);
  return targets.filter((target) => allowSet.has(target.entity as SupportedLegacyEntityType));
}

async function ensureBikeModelId(
  ctx: ImportExecutionContext,
  modelName: string
) {
  const cacheKey = normalizeLegacyToken(modelName) || "legacy-bike";
  const cached = ctx.bikeModelIds.get(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = await ctx.tx.bikeModel.findFirst({
    where: {
      tenantId: ctx.tenantId,
      name: modelName
    },
    select: { id: true }
  });

  if (existing) {
    ctx.bikeModelIds.set(cacheKey, existing.id);
    return existing.id;
  }

  const created = await ctx.tx.bikeModel.create({
    data: {
      tenantId: ctx.tenantId,
      name: modelName
    },
    select: { id: true }
  });

  ctx.bikeModelIds.set(cacheKey, created.id);
  return created.id;
}

async function buildClientDryRun(
  ctx: DryRunLookupContext,
  orders: LegacyOrderRow[]
) {
  const summary = createSummary("clients");
  const grouped = new Map<string, LegacyOrderRow[]>();

  for (const order of orders) {
    const identity = describeClientIdentity(order);
    grouped.set(identity.externalId, [...(grouped.get(identity.externalId) ?? []), order]);
  }

  const rows: ImportJobRowDraft[] = [];
  for (const [externalId, groupOrders] of grouped.entries()) {
    const representative = groupOrders[groupOrders.length - 1]!;
    const identity = describeClientIdentity(representative);
    const existing = await findExistingClientByLegacyKey(ctx, externalId);
    const heuristicDuplicateWarning = identity.quality === ImportMatchQuality.HEURISTIC && groupOrders.length > 1
      ? `Эта heuristic identity встречается в ${groupOrders.length} legacy-заказах.`
      : null;

    rows.push({
      sourceRecordKey: externalId,
      sourceRecordLabel: identity.label,
      decision: existing ? ImportRowDecision.MATCH_EXISTING : ImportRowDecision.CREATE,
      severity: identity.quality === ImportMatchQuality.RELIABLE && !heuristicDuplicateWarning
        ? ImportIssueSeverity.INFO
        : ImportIssueSeverity.WARNING,
      matchQuality: identity.quality,
      matchedEntityType: existing ? "client" : null,
      matchedEntityId: existing?.id ?? null,
      matchedEntityLabel: existing?.fullName ?? null,
      matchedBy: identity.matchedBy,
      issueCode: heuristicDuplicateWarning ? "client_identity_heuristic_duplicate" : identity.issueCode,
      issueText: appendIssueNotes(identity.issueText, heuristicDuplicateWarning ? [heuristicDuplicateWarning] : []),
      detailsText: serializeAuditValue({
        legacyOrderIds: groupOrders.map((order) => order.id),
        customerNames: uniqueBy(groupOrders.map((order) => order.customerName?.trim() || "").filter(Boolean), (value) => value),
        counterpartyHrefs: uniqueBy(groupOrders.map((order) => order.counterpartyHref?.trim() || "").filter(Boolean), (value) => value),
        matchedBy: identity.matchedBy
      })
    });
  }

  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Dry-run distinguishes reliable counterparty keys from heuristic name-based client identities.");
  return { summary, rows };
}

async function buildBikeCandidateDryRun(
  ctx: DryRunLookupContext,
  orders: LegacyOrderRow[]
) {
  const summary = createSummary("bike_candidates_from_deals");
  const candidateOrders = orders.filter((order) => Boolean(pickPrimaryBikeService(order)));
  const grouped = new Map<string, LegacyOrderRow[]>();

  for (const order of candidateOrders) {
    const candidate = buildBikeCandidate(order);
    grouped.set(candidate.externalId, [...(grouped.get(candidate.externalId) ?? []), order]);
  }

  const rows: ImportJobRowDraft[] = [];
  for (const [externalId, groupOrders] of grouped.entries()) {
    const representative = groupOrders[groupOrders.length - 1]!;
    const candidate = buildBikeCandidate(representative);
    const existing = await findExistingBikeUnitByLegacyKey(ctx, externalId);
    const warnings = [
      "Единица техники выводится из product/service name, а не из stable unit id.",
      groupOrders.length > 1 ? `Одинаковый bike candidate встречается в ${groupOrders.length} legacy-заказах.` : null,
      candidate.reference ? null : "У позиции нет assortment href, поэтому identity особенно слабая."
    ].filter((value): value is string => Boolean(value));

    rows.push({
      sourceRecordKey: externalId,
      sourceRecordLabel: candidate.title,
      decision: existing ? ImportRowDecision.MATCH_EXISTING : ImportRowDecision.CREATE,
      severity: ImportIssueSeverity.WARNING,
      matchQuality: ImportMatchQuality.HEURISTIC,
      matchedEntityType: existing ? "bike_unit" : null,
      matchedEntityId: existing?.id ?? null,
      matchedEntityLabel: existing?.title ?? null,
      matchedBy: "bike candidate hash from service name",
      issueCode: "bike_candidate_heuristic_identity",
      issueText: warnings.join(" "),
      detailsText: serializeAuditValue({
        legacyOrderIds: groupOrders.map((order) => order.id),
        assortmentHrefs: uniqueBy(groupOrders.map((order) => pickPrimaryBikeService(order)?.assortmentHref?.trim() || "").filter(Boolean), (value) => value),
        title: candidate.title,
        article: candidate.article,
        modelName: candidate.modelName
      })
    });
  }

  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Bike candidates are always marked heuristic until direct fleet import provides stable unit identity.");
  return { summary, rows };
}

async function buildRentalDealDryRun(
  ctx: DryRunLookupContext,
  orders: LegacyOrderRow[],
  partialPayments: LegacyPartialPaymentsFile["orders"]
) {
  const summary = createSummary("rental_deals");
  const rentalOrders = orders.filter((order) => classifyDealKind(order) === "rental");
  const rows: ImportJobRowDraft[] = [];

  for (const order of rentalOrders) {
    const existing = await findExistingRentalByLegacyKey(ctx, order.id);
    const clientIdentity = describeClientIdentity(order);
    const bikeCandidate = buildBikeCandidate(order);
    const tariff = pickRentalTariff(order);
    const dependencyWarnings = [
      clientIdentity.quality === ImportMatchQuality.HEURISTIC
        ? "Клиент этой сделки определяется только эвристически."
        : null,
      "Велосипед в legacy-сделке определяется как bike candidate по продуктовой строке.",
      tariff ? null : "В legacy-сделке не найден явный rental tariff, будет использован legacy fallback."
    ].filter((value): value is string => Boolean(value));

    rows.push({
      sourceRecordKey: order.id,
      sourceRecordLabel: `${order.name} · ${order.customerName?.trim() || "без клиента"}`,
      decision: existing ? ImportRowDecision.MATCH_EXISTING : ImportRowDecision.CREATE,
      severity: dependencyWarnings.length > 0 ? ImportIssueSeverity.WARNING : ImportIssueSeverity.INFO,
      matchQuality: ImportMatchQuality.RELIABLE,
      matchedEntityType: existing ? "rental" : null,
      matchedEntityId: existing?.id ?? null,
      matchedEntityLabel: existing?.dealNumber ?? null,
      matchedBy: "legacy order id",
      issueCode: dependencyWarnings.length > 0 ? "rental_dependencies_heuristic" : null,
      issueText: dependencyWarnings.join(" ") || null,
      detailsText: serializeAuditValue({
        legacyOrderId: order.id,
        status: order.state ?? null,
        clientKey: clientIdentity.externalId,
        clientQuality: clientIdentity.quality,
        bikeCandidateKey: bikeCandidate.externalId,
        bikeCandidateTitle: bikeCandidate.title,
        tariffDays: Number(tariff?.days ?? 0),
        partialPayment: summarizePartialPayments(order.id, partialPayments)
      })
    });
  }

  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Rental deals match reliably by legacy order id, but dependency quality is surfaced separately.");
  return { summary, rows };
}

async function buildBuyoutDealDryRun(
  ctx: DryRunLookupContext,
  orders: LegacyOrderRow[],
  presets: LegacyBuyoutPreset[] | undefined
) {
  const summary = createSummary("buyout_deals");
  const buyoutOrders = orders.filter((order) => classifyDealKind(order) === "buyout");
  const rows: ImportJobRowDraft[] = [];

  for (const order of buyoutOrders) {
    const existing = await findExistingBuyoutByLegacyKey(ctx, order.id);
    const clientIdentity = describeClientIdentity(order);
    const bikeCandidate = buildBikeCandidate(order);
    const dependencyWarnings = [
      clientIdentity.quality === ImportMatchQuality.HEURISTIC
        ? "Клиент этой сделки определяется только эвристически."
        : null,
      "Велосипед в legacy-сделке определяется как bike candidate по продуктовой строке.",
      presets && presets.length > 0 ? null : "В legacy не найден buyout preset, график будет собран по fallback-правилу.",
      "В source нет явного upfront payment marker, поэтому точный historical down payment не восстанавливается."
    ].filter((value): value is string => Boolean(value));

    rows.push({
      sourceRecordKey: order.id,
      sourceRecordLabel: `${order.name} · ${order.customerName?.trim() || "без клиента"}`,
      decision: existing ? ImportRowDecision.MATCH_EXISTING : ImportRowDecision.CREATE,
      severity: dependencyWarnings.length > 0 ? ImportIssueSeverity.WARNING : ImportIssueSeverity.INFO,
      matchQuality: ImportMatchQuality.RELIABLE,
      matchedEntityType: existing ? "buyout" : null,
      matchedEntityId: existing?.id ?? null,
      matchedEntityLabel: existing?.dealNumber ?? null,
      matchedBy: "legacy order id",
      issueCode: dependencyWarnings.length > 0 ? "buyout_dependencies_heuristic" : null,
      issueText: dependencyWarnings.join(" "),
      detailsText: serializeAuditValue({
        legacyOrderId: order.id,
        status: order.state ?? null,
        clientKey: clientIdentity.externalId,
        clientQuality: clientIdentity.quality,
        bikeCandidateKey: bikeCandidate.externalId,
        bikeCandidateTitle: bikeCandidate.title,
        cadence: mapCadenceFromPresets(presets)
      })
    });
  }

  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Buyout deals match reliably by legacy order id, while schedule/data gaps stay visible as warnings.");
  return { summary, rows };
}

async function buildNotesDryRun(
  ctx: DryRunLookupContext,
  orders: LegacyOrderRow[],
  separateNotesMap: Record<string, LegacyOrderNote[]>,
  batteryCounts: Record<string, number>
) {
  const summary = createSummary("notes_and_operational_flags");
  const rows: ImportJobRowDraft[] = [];

  for (const order of orders) {
    const notes = collectLegacyNotes(order, separateNotesMap);
    const batteryCount = Number(batteryCounts[order.id] ?? order.batteryCount ?? 0);
    const wouldImportCount = notes.length + (batteryCount > 0 ? 1 : 0);

    if (wouldImportCount === 0) {
      continue;
    }

    const clientIdentity = describeClientIdentity(order);
    const rental = await findExistingRentalByLegacyKey(ctx, order.id);
    const buyout = await findExistingBuyoutByLegacyKey(ctx, order.id);
    const client = await findExistingClientByLegacyKey(ctx, clientIdentity.externalId);
    const targetEntityType = rental ? "rental" : buyout ? "buyout" : "client";
    const targetEntityId = rental?.id ?? buyout?.id ?? client?.id ?? null;

    let existingMatches = 0;
    if (targetEntityId) {
      for (const note of notes) {
        const existing = await ctx.tx.note.findFirst({
          where: {
            tenantId: ctx.tenantId,
            targetEntityType,
            targetEntityId,
            text: `[legacy] ${note.text}`,
            colorHex: note.color ?? null
          },
          select: { id: true }
        });
        if (existing) {
          existingMatches += 1;
        }
      }

      if (batteryCount > 0) {
        const existing = await ctx.tx.note.findFirst({
          where: {
            tenantId: ctx.tenantId,
            targetEntityType,
            targetEntityId,
            text: `[legacy] Battery count: ${batteryCount}`,
            colorHex: "#0e8f75"
          },
          select: { id: true }
        });
        if (existing) {
          existingMatches += 1;
        }
      }
    }

    const allExisting = targetEntityId ? existingMatches >= wouldImportCount : false;
    const noteWarnings = [
      clientIdentity.quality === ImportMatchQuality.HEURISTIC
        ? "Заметки завязаны на клиента с heuristic identity."
        : null,
      targetEntityId ? null : "Target entity еще не импортирован; заметки будут привязаны только на commit/replay шаге."
    ].filter((value): value is string => Boolean(value));

    rows.push({
      sourceRecordKey: order.id,
      sourceRecordLabel: `${order.name} · notes ${wouldImportCount}`,
      decision: allExisting ? ImportRowDecision.MATCH_EXISTING : ImportRowDecision.CREATE,
      severity: noteWarnings.length > 0 ? ImportIssueSeverity.WARNING : ImportIssueSeverity.INFO,
      matchQuality: ImportMatchQuality.RELIABLE,
      matchedEntityType: allExisting ? targetEntityType : null,
      matchedEntityId: allExisting ? targetEntityId : null,
      matchedEntityLabel: null,
      matchedBy: "legacy order id + note text",
      issueCode: noteWarnings.length > 0 ? "notes_target_not_ready" : null,
      issueText: noteWarnings.join(" "),
      detailsText: serializeAuditValue({
        legacyOrderId: order.id,
        noteCount: notes.length,
        batteryCount,
        targetEntityType,
        targetEntityId,
        existingMatches
      })
    });
  }

  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Operational notes preview is keyed by legacy order id and explicit note text, without pretending to restore hidden history.");
  return { summary, rows };
}

async function persistImportJobRows(
  tx: TransactionClient,
  params: {
    tenantId: string;
    importJobId: string;
    entityType: ImportJobEntityType;
    rows: ImportJobRowDraft[];
  }
) {
  if (params.rows.length === 0) {
    return;
  }

  await tx.importJobRow.createMany({
    data: params.rows.map((row) => ({
      tenantId: params.tenantId,
      importJobId: params.importJobId,
      sourceEntityType: params.entityType,
      sourceRecordKey: row.sourceRecordKey,
      sourceRecordLabel: row.sourceRecordLabel,
      decision: row.decision,
      severity: row.severity,
      matchQuality: row.matchQuality ?? null,
      matchedEntityType: row.matchedEntityType ?? null,
      matchedEntityId: row.matchedEntityId ?? null,
      matchedEntityLabel: row.matchedEntityLabel ?? null,
      matchedBy: row.matchedBy ?? null,
      issueCode: row.issueCode ?? null,
      issueText: row.issueText ?? null,
      detailsText: row.detailsText ?? null
    }))
  });
}

function groupOrdersByClientIdentity(orders: LegacyOrderRow[]) {
  const grouped = new Map<string, LegacyOrderRow[]>();

  for (const order of orders) {
    const identity = describeClientIdentity(order);
    grouped.set(identity.externalId, [...(grouped.get(identity.externalId) ?? []), order]);
  }

  return grouped;
}

function groupOrdersByBikeCandidate(orders: LegacyOrderRow[]) {
  const grouped = new Map<string, LegacyOrderRow[]>();

  for (const order of orders.filter((item) => Boolean(pickPrimaryBikeService(item)))) {
    const candidate = buildBikeCandidate(order);
    grouped.set(candidate.externalId, [...(grouped.get(candidate.externalId) ?? []), order]);
  }

  return grouped;
}

function mapOrdersById(orders: LegacyOrderRow[]) {
  return new Map(orders.map((order) => [order.id, order] as const));
}

function toCommitIssueText(base: ImportJobRowDraft, message: string) {
  return appendIssueNotes(base.issueText ?? null, [message]);
}

function toCommitFailureRow(base: ImportJobRowDraft, issueCode: string, message: string): ImportJobRowDraft {
  return {
    ...base,
    decision: ImportRowDecision.FAIL,
    severity: ImportIssueSeverity.ERROR,
    issueCode,
    issueText: toCommitIssueText(base, message)
  };
}

function resolveClientIdentityQuality(client: {
  legacyExternalId: string | null;
}) {
  const externalId = client.legacyExternalId?.trim() ?? "";
  if (externalId.startsWith("counterparty:")) {
    return ImportMatchQuality.RELIABLE;
  }

  if (externalId.startsWith("name:") || externalId.startsWith("order:")) {
    return ImportMatchQuality.HEURISTIC;
  }

  return null;
}

async function ensureClient(
  ctx: ImportExecutionContext,
  order: LegacyOrderRow
): Promise<ImportedRecordResult<{ id: string; fullName: string }>> {
  const externalId = buildClientExternalId(order);
  const existing = await ctx.tx.client.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId: externalId
      }
    },
    select: {
      id: true,
      fullName: true
    }
  });

  if (existing) {
    return {
      record: existing,
      created: false
    };
  }

  const created = await ctx.tx.client.create({
    data: {
      tenantId: ctx.tenantId,
      legacySource: "LEGACY_CRM",
      legacyExternalId: externalId,
      legacyReference: order.counterpartyHref ?? null,
      fullName: order.customerName?.trim() || `Legacy client ${order.name}`
    },
    select: {
      id: true,
      fullName: true
    }
  });

  return {
    record: created,
    created: true
  };
}

async function ensureBikeUnit(
  ctx: ImportExecutionContext,
  order: LegacyOrderRow
): Promise<ImportedRecordResult<{ id: string; title: string }>> {
  const candidate = buildBikeCandidate(order);
  const existing = await ctx.tx.bikeUnit.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId: candidate.externalId
      }
    },
    select: {
      id: true,
      title: true
    }
  });

  if (existing) {
    return {
      record: existing,
      created: false
    };
  }

  const bikeModelId = await ensureBikeModelId(ctx, candidate.modelName);
  const created = await ctx.tx.bikeUnit.create({
    data: {
      tenantId: ctx.tenantId,
      bikeModelId,
      legacySource: "LEGACY_CRM",
      legacyExternalId: candidate.externalId,
      legacyReference: candidate.reference,
      internalCode: candidate.internalCode,
      title: candidate.title,
      article: candidate.article,
      conditionNote: candidate.placeholder ? "Imported as placeholder from legacy order" : null
    },
    select: {
      id: true,
      title: true
    }
  });

  return {
    record: created,
    created: true
  };
}

async function ensureRentalDeal(
  ctx: ImportExecutionContext,
  order: LegacyOrderRow,
  clientId: string,
  bikeUnitId: string,
  partialPayments: LegacyPartialPaymentsFile["orders"]
): Promise<ImportedRecordResult<{ id: string; dealNumber: string }>> {
  const existing = await ctx.tx.rental.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId: order.id
      }
    },
    select: { id: true, dealNumber: true }
  });

  if (existing) {
    ctx.rentalIdsByOrderId.set(order.id, existing.id);
    return {
      record: existing,
      created: false
    };
  }

  const tariff = pickRentalTariff(order);
  const partial = summarizePartialPayments(order.id, partialPayments);
  const dueAt = parseLegacyDate(order.dateInput ?? order.date);
  const created = await ctx.tx.rental.create({
    data: {
      tenantId: ctx.tenantId,
      clientId,
      bikeUnitId,
      legacySource: "LEGACY_CRM",
      legacyExternalId: order.id,
      legacyReference: order.stateMetaHref ?? null,
      dealNumber: `LRY-${order.name}-${order.id.slice(0, 8)}`,
      status: mapRentalStatus(order.state),
      tariffCode: tariff ? `legacy-days-${tariff.days}` : "legacy-unknown",
      tariffLabel: tariff?.name ?? "Legacy rental tariff",
      startsAt: dueAt,
      nextPaymentAt: dueAt,
      plannedPaymentKopecks: Number(tariff?.price ?? 0),
      debtKopecks: partial.outstandingKopecks,
      overdueDays: partial.outstandingKopecks > 0 ? 1 : 0,
      comment: buildCommentLines(order, [
        `Legacy total sum: ${Number(order.totalSum ?? 0)}`,
        `Legacy dashboard date used as current due date reference.`
      ])
    },
    select: { id: true, dealNumber: true }
  });

  ctx.rentalIdsByOrderId.set(order.id, created.id);
  return {
    record: created,
    created: true
  };
}

async function ensureBuyoutDeal(
  ctx: ImportExecutionContext,
  order: LegacyOrderRow,
  clientId: string,
  bikeUnitId: string,
  buyoutPresets: LegacyBuyoutPreset[] | undefined
): Promise<ImportedRecordResult<{ id: string; dealNumber: string }>> {
  const existing = await ctx.tx.buyout.findUnique({
    where: {
      tenantId_legacySource_legacyExternalId: {
        tenantId: ctx.tenantId,
        legacySource: "LEGACY_CRM",
        legacyExternalId: order.id
      }
    },
    select: { id: true, dealNumber: true }
  });

  if (existing) {
    ctx.buyoutIdsByOrderId.set(order.id, existing.id);
    return {
      record: existing,
      created: false
    };
  }

  const cadence = mapCadenceFromPresets(buyoutPresets);
  const totalPriceKopecks = Number(order.totalSum ?? 0);
  const status = mapBuyoutStatus(order.state);
  const dueAt = parseLegacyDate(order.dateInput ?? order.date);
  const residualDebtKopecks = status === "CLOSED" ? 0 : totalPriceKopecks;
  const created = await ctx.tx.buyout.create({
    data: {
      tenantId: ctx.tenantId,
      clientId,
      bikeUnitId,
      legacySource: "LEGACY_CRM",
      legacyExternalId: order.id,
      legacyReference: order.stateMetaHref ?? null,
      dealNumber: `LBY-${order.name}-${order.id.slice(0, 8)}`,
      status,
      paymentCadence: cadence,
      totalPriceKopecks,
      financedAmountKopecks: totalPriceKopecks,
      residualDebtKopecks,
      startsAt: dueAt,
      nextPaymentAt: dueAt,
      comment: buildCommentLines(order, [
        `Legacy buyout cadence assumed as ${cadence}.`,
        `Schedule rebuilt from legacy presets and current residual debt snapshot.`
      ])
    },
    select: { id: true, dealNumber: true }
  });

  ctx.buyoutIdsByOrderId.set(order.id, created.id);
  return {
    record: created,
    created: true
  };
}

async function ensureNote(
  tx: TransactionClient,
  params: {
    tenantId: string;
    clientId: string;
    targetEntityType: string;
    targetEntityId: string;
    text: string;
    colorHex?: string | null;
  }
) {
  const existing = await tx.note.findFirst({
    where: {
      tenantId: params.tenantId,
      clientId: params.clientId,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId,
      text: params.text,
      colorHex: params.colorHex ?? null
    },
    select: { id: true }
  });

  if (existing) {
    return false;
  }

  await tx.note.create({
    data: {
      tenantId: params.tenantId,
      clientId: params.clientId,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId,
      text: params.text,
      colorHex: params.colorHex ?? null
    }
  });

  return true;
}

async function markBikeUsage(
  tx: TransactionClient,
  params: {
    bikeUnitId: string;
    clientId: string;
    kind: "rental" | "buyout";
    happenedAt: Date;
  }
) {
  await tx.bikeUnit.update({
    where: { id: params.bikeUnitId },
    data: {
      currentClientId: params.clientId,
      status: params.kind === "buyout" ? "BUYOUT" : "RENTED",
      lastIssuedAt: params.happenedAt
    }
  });
}

async function importClientsFromLegacy(
  ctx: ImportExecutionContext,
  orders: LegacyOrderRow[]
) {
  const summary = createSummary("clients");
  const uniqueOrders = uniqueBy(orders, buildClientExternalId);
  summary.totalRows = uniqueOrders.length;

  for (const order of uniqueOrders) {
    summary.processedRows += 1;
    const result = await ensureClient(ctx, order);
    summary.successRows += 1;
    summary[result.created ? "createdRows" : "existingRows"] += 1;
  }

  summary.logLines.push("Clients imported from legacy orders cache.");
  return summary;
}

async function importBikeCandidatesFromLegacy(
  ctx: ImportExecutionContext,
  orders: LegacyOrderRow[]
) {
  const summary = createSummary("bike_candidates_from_deals");
  const candidateOrders = uniqueBy(
    orders.filter((order) => Boolean(pickPrimaryBikeService(order))),
    (order) => buildBikeCandidate(order).externalId
  );
  summary.totalRows = candidateOrders.length;

  for (const order of candidateOrders) {
    summary.processedRows += 1;
    const result = await ensureBikeUnit(ctx, order);
    summary.successRows += 1;
    summary[result.created ? "createdRows" : "existingRows"] += 1;
  }

  summary.logLines.push("Bike units imported from likely product lines inside legacy deals.");
  return summary;
}

async function importRentalDealsFromLegacy(
  ctx: ImportExecutionContext,
  orders: LegacyOrderRow[],
  partialPayments: LegacyPartialPaymentsFile["orders"]
) {
  const summary = createSummary("rental_deals");
  const rentalOrders = orders
    .filter((order) => classifyDealKind(order) === "rental")
    .sort(
      (left, right) =>
        parseLegacyDate(left.dateInput ?? left.date).getTime()
        - parseLegacyDate(right.dateInput ?? right.date).getTime()
    );
  summary.totalRows = rentalOrders.length;

  for (const order of rentalOrders) {
    summary.processedRows += 1;
    const client = await ensureClient(ctx, order);
    const bikeUnit = await ensureBikeUnit(ctx, order);
    const result = await ensureRentalDeal(ctx, order, client.record.id, bikeUnit.record.id, partialPayments);

    summary.successRows += 1;
    summary[result.created ? "createdRows" : "existingRows"] += 1;

    const status = mapRentalStatus(order.state);
    const rentalRecord = await ctx.tx.rental.findUnique({
      where: { id: result.record.id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        startsAt: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        graceDays: true,
        tariffCode: true,
        tariffLabel: true
      }
    });
    if (rentalRecord) {
      await rebuildRentalSchedule({
        tx: ctx.tx,
        rental: rentalRecord,
        cycles: Object.values(partialPayments[order.id] ?? {})
      });
    }

    if (status === "ACTIVE" || status === "OVERDUE") {
      await markBikeUsage(ctx.tx, {
        bikeUnitId: bikeUnit.record.id,
        clientId: client.record.id,
        kind: "rental",
        happenedAt: parseLegacyDate(order.dateInput ?? order.date)
      });
    }
  }

  summary.logLines.push("Rental stubs imported from legacy orders.");
  return summary;
}

async function importBuyoutDealsFromLegacy(
  ctx: ImportExecutionContext,
  orders: LegacyOrderRow[],
  presets: LegacyBuyoutPreset[] | undefined
) {
  const summary = createSummary("buyout_deals");
  const buyoutOrders = orders
    .filter((order) => classifyDealKind(order) === "buyout")
    .sort(
      (left, right) =>
        parseLegacyDate(left.dateInput ?? left.date).getTime()
        - parseLegacyDate(right.dateInput ?? right.date).getTime()
    );
  summary.totalRows = buyoutOrders.length;

  for (const order of buyoutOrders) {
    summary.processedRows += 1;
    const client = await ensureClient(ctx, order);
    const bikeUnit = await ensureBikeUnit(ctx, order);
    const result = await ensureBuyoutDeal(ctx, order, client.record.id, bikeUnit.record.id, presets);

    summary.successRows += 1;
    summary[result.created ? "createdRows" : "existingRows"] += 1;

    const status = mapBuyoutStatus(order.state);
    const buyoutRecord = await ctx.tx.buyout.findUnique({
      where: { id: result.record.id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        startsAt: true,
        nextPaymentAt: true,
        termMonths: true,
        paymentCadence: true,
        financedAmountKopecks: true,
        residualDebtKopecks: true
      }
    });
    if (buyoutRecord) {
      await rebuildBuyoutSchedule({
        tx: ctx.tx,
        buyout: buyoutRecord,
        presets: (presets ?? []).map((preset) => ({
          amountKopecks: Number(preset.amountKopecks ?? 0),
          intervalUnit: preset.intervalUnit,
          intervalValue: Number(preset.intervalValue ?? 1)
        }))
      });
    }

    if (status === "ACTIVE" || status === "OVERDUE") {
      await markBikeUsage(ctx.tx, {
        bikeUnitId: bikeUnit.record.id,
        clientId: client.record.id,
        kind: "buyout",
        happenedAt: parseLegacyDate(order.dateInput ?? order.date)
      });
    }
  }

  summary.logLines.push("Buyout stubs imported from legacy orders.");
  return summary;
}

async function importNotesFromLegacy(
  ctx: ImportExecutionContext,
  orders: LegacyOrderRow[],
  separateNotesMap: Record<string, LegacyOrderNote[]>,
  batteryCounts: Record<string, number>
) {
  const summary = createSummary("notes_and_operational_flags");
  summary.totalRows = orders.length;

  for (const order of orders) {
    summary.processedRows += 1;
    const client = await ensureClient(ctx, order);
    const rentalId = ctx.rentalIdsByOrderId.get(order.id);
    const buyoutId = ctx.buyoutIdsByOrderId.get(order.id);
    const targetEntityType = rentalId ? "rental" : buyoutId ? "buyout" : "client";
    const targetEntityId = rentalId ?? buyoutId ?? client.record.id;

    let createdThisOrder = 0;
    for (const note of collectLegacyNotes(order, separateNotesMap)) {
      const created = await ensureNote(ctx.tx, {
        tenantId: ctx.tenantId,
        clientId: client.record.id,
        targetEntityType,
        targetEntityId,
        text: `[legacy] ${note.text}`,
        colorHex: note.color ?? null
      });
      if (created) {
        createdThisOrder += 1;
      }
    }

    const batteryCount = Number(batteryCounts[order.id] ?? order.batteryCount ?? 0);
    if (batteryCount > 0) {
      const created = await ensureNote(ctx.tx, {
        tenantId: ctx.tenantId,
        clientId: client.record.id,
        targetEntityType,
        targetEntityId,
        text: `[legacy] Battery count: ${batteryCount}`,
        colorHex: "#0e8f75"
      });
      if (created) {
        createdThisOrder += 1;
      }
    }

    summary.successRows += 1;
    if (createdThisOrder > 0) {
      summary.createdRows += createdThisOrder;
    } else {
      summary.existingRows += 1;
    }
  }

  summary.logLines.push("Legacy notes and battery counters imported into note ledger.");
  return summary;
}

async function commitClientsFromLegacyRows(
  ctx: SharedImportExecutionContext,
  orders: LegacyOrderRow[],
  baseRows: ImportJobRowDraft[]
) {
  const grouped = groupOrdersByClientIdentity(orders);
  const rows: ImportJobRowDraft[] = [];
  const clientIds = new Set<string>();

  for (const baseRow of baseRows) {
    const groupOrders = grouped.get(baseRow.sourceRecordKey) ?? [];
    const representative = groupOrders[groupOrders.length - 1];

    if (!representative) {
      rows.push(toCommitFailureRow(baseRow, "legacy_source_missing", "В source bundle не найдена запись для этого клиента."));
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const txCtx: ImportExecutionContext = { ...ctx, tx };
        return ensureClient(txCtx, representative);
      });

      clientIds.add(result.record.id);
      rows.push({
        ...baseRow,
        decision: result.created ? ImportRowDecision.CREATE : ImportRowDecision.MATCH_EXISTING,
        matchedEntityType: "client",
        matchedEntityId: result.record.id,
        matchedEntityLabel: result.record.fullName
      });
    } catch (error) {
      rows.push(
        toCommitFailureRow(
          baseRow,
          "client_commit_failed",
          error instanceof Error ? error.message : "Не удалось записать клиента в CRM."
        )
      );
    }
  }

  const summary = createSummary("clients");
  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Commit follows the same client quality model as dry-run and stays idempotent by legacy key.");
  return { summary, rows, clientIds: [...clientIds] };
}

async function commitBikeCandidatesFromLegacyRows(
  ctx: SharedImportExecutionContext,
  orders: LegacyOrderRow[],
  baseRows: ImportJobRowDraft[]
) {
  const grouped = groupOrdersByBikeCandidate(orders);
  const rows: ImportJobRowDraft[] = [];

  for (const baseRow of baseRows) {
    const groupOrders = grouped.get(baseRow.sourceRecordKey) ?? [];
    const representative = groupOrders[groupOrders.length - 1];

    if (!representative) {
      rows.push(toCommitFailureRow(baseRow, "legacy_source_missing", "В source bundle не найден bike candidate для этой строки."));
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const txCtx: ImportExecutionContext = { ...ctx, tx };
        return ensureBikeUnit(txCtx, representative);
      });

      rows.push({
        ...baseRow,
        decision: result.created ? ImportRowDecision.CREATE : ImportRowDecision.MATCH_EXISTING,
        matchedEntityType: "bike_unit",
        matchedEntityId: result.record.id,
        matchedEntityLabel: result.record.title
      });
    } catch (error) {
      rows.push(
        toCommitFailureRow(
          baseRow,
          "bike_candidate_commit_failed",
          error instanceof Error ? error.message : "Не удалось записать bike candidate в CRM."
        )
      );
    }
  }

  const summary = createSummary("bike_candidates_from_deals");
  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Bike candidate commit is repeatable and still keeps heuristic identity visible.");
  return { summary, rows };
}

async function commitRentalDealsFromLegacyRows(
  ctx: SharedImportExecutionContext,
  orders: LegacyOrderRow[],
  partialPayments: LegacyPartialPaymentsFile["orders"],
  baseRows: ImportJobRowDraft[]
) {
  const ordersById = mapOrdersById(orders.filter((order) => classifyDealKind(order) === "rental"));
  const rows: ImportJobRowDraft[] = [];

  for (const baseRow of baseRows) {
    const order = ordersById.get(baseRow.sourceRecordKey);
    if (!order) {
      rows.push(toCommitFailureRow(baseRow, "legacy_source_missing", "В source bundle не найдена rental-сделка для этой строки."));
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const txCtx: ImportExecutionContext = { ...ctx, tx };
        const client = await ensureClient(txCtx, order);
        const bikeUnit = await ensureBikeUnit(txCtx, order);
        const rental = await ensureRentalDeal(txCtx, order, client.record.id, bikeUnit.record.id, partialPayments);

        const rentalRecord = await tx.rental.findUnique({
          where: { id: rental.record.id },
          select: {
            id: true,
            tenantId: true,
            status: true,
            startsAt: true,
            nextPaymentAt: true,
            plannedPaymentKopecks: true,
            graceDays: true,
            tariffCode: true,
            tariffLabel: true
          }
        });
        if (rentalRecord) {
          await rebuildRentalSchedule({
            tx,
            rental: rentalRecord,
            cycles: Object.values(partialPayments[order.id] ?? {})
          });
        }

        const status = mapRentalStatus(order.state);
        if (status === "ACTIVE" || status === "OVERDUE") {
          await markBikeUsage(tx, {
            bikeUnitId: bikeUnit.record.id,
            clientId: client.record.id,
            kind: "rental",
            happenedAt: parseLegacyDate(order.dateInput ?? order.date)
          });
        }

        return rental;
      });

      rows.push({
        ...baseRow,
        decision: result.created ? ImportRowDecision.CREATE : ImportRowDecision.MATCH_EXISTING,
        matchedEntityType: "rental",
        matchedEntityId: result.record.id,
        matchedEntityLabel: result.record.dealNumber
      });
    } catch (error) {
      rows.push(
        toCommitFailureRow(
          baseRow,
          "rental_commit_failed",
          error instanceof Error ? error.message : "Не удалось записать rental-сделку в CRM."
        )
      );
    }
  }

  const summary = createSummary("rental_deals");
  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Rental commit reuses dry-run dependency warnings and can be replayed safely by legacy order id.");
  return { summary, rows };
}

async function commitBuyoutDealsFromLegacyRows(
  ctx: SharedImportExecutionContext,
  orders: LegacyOrderRow[],
  presets: LegacyBuyoutPreset[] | undefined,
  baseRows: ImportJobRowDraft[]
) {
  const ordersById = mapOrdersById(orders.filter((order) => classifyDealKind(order) === "buyout"));
  const rows: ImportJobRowDraft[] = [];

  for (const baseRow of baseRows) {
    const order = ordersById.get(baseRow.sourceRecordKey);
    if (!order) {
      rows.push(toCommitFailureRow(baseRow, "legacy_source_missing", "В source bundle не найдена buyout-сделка для этой строки."));
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const txCtx: ImportExecutionContext = { ...ctx, tx };
        const client = await ensureClient(txCtx, order);
        const bikeUnit = await ensureBikeUnit(txCtx, order);
        const buyout = await ensureBuyoutDeal(txCtx, order, client.record.id, bikeUnit.record.id, presets);

        const buyoutRecord = await tx.buyout.findUnique({
          where: { id: buyout.record.id },
          select: {
            id: true,
            tenantId: true,
            status: true,
            startsAt: true,
            nextPaymentAt: true,
            termMonths: true,
            paymentCadence: true,
            financedAmountKopecks: true,
            residualDebtKopecks: true
          }
        });
        if (buyoutRecord) {
          await rebuildBuyoutSchedule({
            tx,
            buyout: buyoutRecord,
            presets: (presets ?? []).map((preset) => ({
              amountKopecks: Number(preset.amountKopecks ?? 0),
              intervalUnit: preset.intervalUnit,
              intervalValue: Number(preset.intervalValue ?? 1)
            }))
          });
        }

        const status = mapBuyoutStatus(order.state);
        if (status === "ACTIVE" || status === "OVERDUE") {
          await markBikeUsage(tx, {
            bikeUnitId: bikeUnit.record.id,
            clientId: client.record.id,
            kind: "buyout",
            happenedAt: parseLegacyDate(order.dateInput ?? order.date)
          });
        }

        return buyout;
      });

      rows.push({
        ...baseRow,
        decision: result.created ? ImportRowDecision.CREATE : ImportRowDecision.MATCH_EXISTING,
        matchedEntityType: "buyout",
        matchedEntityId: result.record.id,
        matchedEntityLabel: result.record.dealNumber
      });
    } catch (error) {
      rows.push(
        toCommitFailureRow(
          baseRow,
          "buyout_commit_failed",
          error instanceof Error ? error.message : "Не удалось записать buyout-сделку в CRM."
        )
      );
    }
  }

  const summary = createSummary("buyout_deals");
  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Buyout commit reuses dry-run quality signals and stays replay-safe by legacy order id.");
  return { summary, rows };
}

async function commitNotesFromLegacyRows(
  ctx: SharedImportExecutionContext,
  orders: LegacyOrderRow[],
  separateNotesMap: Record<string, LegacyOrderNote[]>,
  batteryCounts: Record<string, number>,
  baseRows: ImportJobRowDraft[]
) {
  const ordersById = mapOrdersById(orders);
  const rows: ImportJobRowDraft[] = [];

  for (const baseRow of baseRows) {
    const order = ordersById.get(baseRow.sourceRecordKey);
    if (!order) {
      rows.push(toCommitFailureRow(baseRow, "legacy_source_missing", "В source bundle не найдена note-строка для этой сделки."));
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const txCtx: ImportExecutionContext = { ...ctx, tx };
        const client = await ensureClient(txCtx, order);
        const rental = await tx.rental.findUnique({
          where: {
            tenantId_legacySource_legacyExternalId: {
              tenantId: txCtx.tenantId,
              legacySource: "LEGACY_CRM",
              legacyExternalId: order.id
            }
          },
          select: { id: true, dealNumber: true }
        });
        const buyout = await tx.buyout.findUnique({
          where: {
            tenantId_legacySource_legacyExternalId: {
              tenantId: txCtx.tenantId,
              legacySource: "LEGACY_CRM",
              legacyExternalId: order.id
            }
          },
          select: { id: true, dealNumber: true }
        });

        const notes = collectLegacyNotes(order, separateNotesMap);
        const batteryCount = Number(batteryCounts[order.id] ?? order.batteryCount ?? 0);
        const targetEntityType = rental ? "rental" : buyout ? "buyout" : "client";
        const targetEntityId = rental?.id ?? buyout?.id ?? client.record.id;
        const targetEntityLabel = rental?.dealNumber ?? buyout?.dealNumber ?? client.record.fullName;

        let createdCount = 0;
        for (const note of notes) {
          const created = await ensureNote(tx, {
            tenantId: txCtx.tenantId,
            clientId: client.record.id,
            targetEntityType,
            targetEntityId,
            text: `[legacy] ${note.text}`,
            colorHex: note.color ?? null
          });
          if (created) {
            createdCount += 1;
          }
        }

        if (batteryCount > 0) {
          const created = await ensureNote(tx, {
            tenantId: txCtx.tenantId,
            clientId: client.record.id,
            targetEntityType,
            targetEntityId,
            text: `[legacy] Battery count: ${batteryCount}`,
            colorHex: "#0e8f75"
          });
          if (created) {
            createdCount += 1;
          }
        }

        return {
          createdCount,
          targetEntityType,
          targetEntityId,
          targetEntityLabel,
          clientQuality: describeClientIdentity(order).quality,
          attachedToFallbackClient: !rental && !buyout
        };
      });

      const noteWarnings = [
        result.clientQuality === ImportMatchQuality.HEURISTIC
          ? "Заметки привязаны к клиенту с heuristic identity."
          : null,
        result.attachedToFallbackClient
          ? "Deal target еще не найден, поэтому заметки привязаны к карточке клиента."
          : null
      ].filter((value): value is string => Boolean(value));

      rows.push({
        ...baseRow,
        decision: result.createdCount > 0 ? ImportRowDecision.CREATE : ImportRowDecision.MATCH_EXISTING,
        severity: noteWarnings.length > 0 ? ImportIssueSeverity.WARNING : baseRow.severity,
        matchedEntityType: result.targetEntityType,
        matchedEntityId: result.targetEntityId,
        matchedEntityLabel: result.targetEntityLabel,
        issueCode: noteWarnings.length > 0 ? "notes_commit_warning" : baseRow.issueCode,
        issueText: noteWarnings.length > 0 ? noteWarnings.join(" ") : baseRow.issueText
      });
    } catch (error) {
      rows.push(
        toCommitFailureRow(
          baseRow,
          "notes_commit_failed",
          error instanceof Error ? error.message : "Не удалось импортировать заметки и operational flags."
        )
      );
    }
  }

  const summary = createSummary("notes_and_operational_flags");
  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Notes import can be replayed safely and now keeps per-row quality outcomes.");
  return { summary, rows };
}

async function runClientEnrichmentStage(params: {
  tenantId: string;
  clientIds: string[];
}) {
  const summary = createSummary(CLIENT_ENRICHMENT_ENTITY_TYPE);
  const rows: ImportJobRowDraft[] = [];
  const uniqueClientIds = uniqueBy(params.clientIds, (value) => value);

  for (const clientId of uniqueClientIds) {
    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        tenantId: params.tenantId
      },
      select: {
        id: true,
        fullName: true,
        legacyExternalId: true,
        legacyReference: true
      }
    });

    const baseRow: ImportJobRowDraft = {
      sourceRecordKey: clientId,
      sourceRecordLabel: client?.fullName ?? `client:${clientId}`,
      decision: ImportRowDecision.SKIP,
      severity: ImportIssueSeverity.INFO,
      matchQuality: client ? resolveClientIdentityQuality(client) : null,
      matchedEntityType: client ? "client" : null,
      matchedEntityId: client?.id ?? null,
      matchedEntityLabel: client?.fullName ?? null,
      matchedBy: client?.legacyReference ? "legacy counterparty hydration" : "client legacy reference missing"
    };

    if (!client) {
      rows.push(toCommitFailureRow(baseRow, "client_not_found", "Клиент для post-import enrichment не найден."));
      continue;
    }

    try {
      const result = await hydrateClientFromLegacyCounterparty({
        tenantId: params.tenantId,
        clientId: client.id
      });

      if (result.updated) {
        rows.push({
          ...baseRow,
          decision: ImportRowDecision.CREATE,
          issueCode: "client_enriched",
          issueText: "Legacy counterparty data применены к карточке клиента."
        });
        continue;
      }

      if (result.reason === "already_hydrated") {
        rows.push({
          ...baseRow,
          decision: ImportRowDecision.MATCH_EXISTING,
          issueCode: "already_hydrated",
          issueText: "Карточка клиента уже содержит эти данные, enrichment повторно ничего не менял."
        });
        continue;
      }

      if (result.reason === "no_legacy_reference" || result.reason === "no_connection") {
        rows.push({
          ...baseRow,
          decision: ImportRowDecision.SKIP,
          severity: ImportIssueSeverity.WARNING,
          issueCode: result.reason,
          issueText: result.reason === "no_legacy_reference"
            ? "У клиента нет stable legacyReference, enrichment пропущен."
            : "Нет подключения к legacy MoySklad, enrichment пропущен."
        });
        continue;
      }

      rows.push(toCommitFailureRow(baseRow, result.reason, "Enrichment не завершен."));
    } catch (error) {
      rows.push(
        toCommitFailureRow(
          baseRow,
          "client_enrichment_failed",
          error instanceof Error ? error.message : "Ошибка post-import enrichment."
        )
      );
    }
  }

  summarizeDryRunRows(summary, rows);
  summary.logLines.push("Post-import enrichment is now a visible quality stage, not a hidden side effect.");
  return { summary, rows };
}

function createImportJobsLookup(jobs: Array<{ id: string; entityType: string }>) {
  const map = new Map<string, string>();
  for (const job of jobs) {
    map.set(job.entityType, job.id);
  }
  return map;
}

async function createImportRecord(
  tx: TransactionClient,
  params: {
    tenantId: string;
    source: "LEGACY_CRM";
    name: string;
    dryRun: boolean;
    duplicatePolicy: string;
    entityTypes: ImportJobEntityType[];
  }
) {
  const status = params.dryRun ? "DRY_RUN" : "RUNNING";
  const importRecord = await tx.import.create({
    data: {
      tenantId: params.tenantId,
      source: params.source,
      status,
      name: params.name,
      dryRun: params.dryRun,
      duplicatePolicy: params.duplicatePolicy
    }
  });

  const jobs = await Promise.all(
    params.entityTypes.map((entityType) =>
      tx.importJob.create({
        data: {
          tenantId: params.tenantId,
          importId: importRecord.id,
          status,
          entityType
        },
        select: {
          id: true,
          entityType: true
        }
      })
    )
  );

  return {
    importRecord,
    jobs
  };
}

async function finalizeImportJobs(
  tx: TransactionClient,
  params: {
    importId: string;
    importStatus: "DRY_RUN" | "COMPLETED" | "FAILED";
    jobIdsByEntityType: Map<string, string>;
    summaries: ImportEntitySummary[];
  }
) {
  const resolvedImportStatus = params.importStatus === "COMPLETED" && params.summaries.some((summary) => summary.failedRows > 0)
    ? "FAILED"
    : params.importStatus;

  await Promise.all(
    params.summaries.map((summary) =>
      tx.importJob.update({
        where: { id: params.jobIdsByEntityType.get(summary.entityType)! },
        data: {
          status: params.importStatus === "DRY_RUN"
            ? "DRY_RUN"
            : summary.failedRows > 0
              ? "FAILED"
              : "COMPLETED",
          totalRows: summary.totalRows,
          processedRows: summary.processedRows,
          successRows: summary.successRows,
          failedRows: summary.failedRows,
          finishedAt: new Date(),
          startedAt: new Date(),
          logText: buildJobLog(summary)
        }
      })
    )
  );

  await tx.import.update({
    where: { id: params.importId },
    data: {
      status: resolvedImportStatus
    }
  });
}

export async function createLegacyDryRunImport(params: {
  tenantSlug?: string;
  tenantName?: string;
  importName?: string;
  duplicatePolicy?: string;
  entityTypes?: SupportedLegacyEntityType[];
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const overview = await getLegacyOverview();
  const bundle = await loadLegacyDataBundle();
  const expandedTypes = expandLegacyEntityTypes(params.entityTypes);
  const selectedTargets = filterLegacyTargets(overview.importTargets, expandedTypes);

  if (selectedTargets.length === 0) {
    throw new HttpError(400, "No legacy import targets selected");
  }

  const tenant = await upsertTenantForImport({
    tenantSlug: params.tenantSlug,
    tenantName: params.tenantName
  });

  const diagnostics = await buildLegacyDiagnostics({
    tenantId: tenant.id,
    bundle,
    entityTypes: expandedTypes
  });

  const createdImport = await prisma.$transaction(async (tx) => {
    const { importRecord, jobs } = await createImportRecord(tx, {
      tenantId: tenant.id,
      source: "LEGACY_CRM",
      name: buildImportName(params.importName, true),
      dryRun: true,
      duplicatePolicy: params.duplicatePolicy?.trim() || "MERGE_BY_LEGACY_KEY",
      entityTypes: buildImportJobEntityTypes(expandedTypes, true)
    });

    const jobIdsByEntityType = createImportJobsLookup(jobs);

    const summaries = selectedTargets.map((target) => {
      const entityType = target.entity as SupportedLegacyEntityType;
      const diagnostic = diagnostics.get(entityType);
      const summary = diagnostic?.summary ?? createSummary(entityType);
      summary.logLines.unshift(`missingFields: ${target.missingFields.join(", ") || "n/a"}`);
      summary.logLines.unshift(`readyFields: ${target.readyFields.join(", ") || "n/a"}`);
      summary.logLines.unshift(`sourceFiles: ${target.sourceFiles.join(", ") || "n/a"}`);
      summary.logLines.unshift(`strategy: ${target.strategy}`);
      return summary;
    });

    for (const target of selectedTargets) {
      const entityType = target.entity as SupportedLegacyEntityType;
      const diagnostic = diagnostics.get(entityType);
      if (!diagnostic) {
        continue;
      }

      await persistImportJobRows(tx, {
        tenantId: tenant.id,
        importJobId: jobIdsByEntityType.get(entityType)!,
        entityType,
        rows: diagnostic.rows
      });
    }

    await finalizeImportJobs(tx, {
      importId: importRecord.id,
      importStatus: "DRY_RUN",
      jobIdsByEntityType,
      summaries
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "import",
        entityId: importRecord.id,
        action: "legacy.dry_run.created",
        newValueText: serializeAuditValue({
          source: "LEGACY_CRM",
          targets: selectedTargets.map((target) => {
            const summary = summaries.find((item) => item.entityType === target.entity);
            return {
              entity: target.entity,
              totalRows: summary?.totalRows ?? 0,
              createdRows: summary?.createdRows ?? 0,
              existingRows: summary?.existingRows ?? 0,
              skippedRows: summary?.skippedRows ?? 0,
              warningRows: summary?.warningRows ?? 0,
              failedRows: summary?.failedRows ?? 0
            };
          }),
          overviewCounts: overview.counts
        }),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      importRecord,
      jobs,
      summaries
    };
  });

  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name
    },
    import: createdImport.importRecord,
    jobs: createdImport.jobs,
    summaries: createdImport.summaries,
    overviewCounts: overview.counts,
    selectedTargets
  };
}

export async function commitLegacyImport(params: {
  tenantSlug?: string;
  tenantName?: string;
  importName?: string;
  duplicatePolicy?: string;
  entityTypes?: SupportedLegacyEntityType[];
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  // Commit writes entities first and rebuilds schedules after that so current CRM starts from deterministic debt/next-payment snapshots.
  const overview = await getLegacyOverview();
  const bundle = await loadLegacyDataBundle();
  const expandedTypes = expandLegacyEntityTypes(params.entityTypes);
  const selectedTargets = filterLegacyTargets(overview.importTargets, expandedTypes);

  if (selectedTargets.length === 0) {
    throw new HttpError(400, "No legacy import targets selected");
  }

  const tenant = await upsertTenantForImport({
    tenantSlug: params.tenantSlug,
    tenantName: params.tenantName
  });

  const diagnostics = await buildLegacyDiagnostics({
    tenantId: tenant.id,
    bundle,
    entityTypes: expandedTypes
  });

  const createdImport = await prisma.$transaction(async (tx) => createImportRecord(tx, {
    tenantId: tenant.id,
    source: "LEGACY_CRM",
    name: buildImportName(params.importName, false),
    dryRun: false,
    duplicatePolicy: params.duplicatePolicy?.trim() || "MERGE_BY_LEGACY_KEY",
    entityTypes: buildImportJobEntityTypes(expandedTypes, false)
  }));

  const jobIdsByEntityType = createImportJobsLookup(createdImport.jobs);
  const sharedCtx: SharedImportExecutionContext = {
    tenantId: tenant.id,
    bikeModelIds: new Map<string, string>(),
    rentalIdsByOrderId: new Map<string, string>(),
    buyoutIdsByOrderId: new Map<string, string>()
  };

  const summaries: ImportEntitySummary[] = [];
  const importedClientIds = new Set<string>();

  async function persistJobResult(entityType: ImportJobEntityType, summary: ImportEntitySummary, rows: ImportJobRowDraft[]) {
    summaries.push(summary);

    await prisma.$transaction(async (tx) => {
      const jobId = jobIdsByEntityType.get(entityType);
      if (!jobId) {
        throw new Error(`Import job '${entityType}' was not created`);
      }

      await tx.importJobRow.deleteMany({
        where: {
          tenantId: tenant.id,
          importJobId: jobId
        }
      });

      await persistImportJobRows(tx, {
        tenantId: tenant.id,
        importJobId: jobId,
        entityType,
        rows
      });
    });
  }

  if (expandedTypes.includes("clients")) {
    const result = await commitClientsFromLegacyRows(
      sharedCtx,
      bundle.orders.rows,
      diagnostics.get("clients")?.rows ?? []
    );
    for (const clientId of result.clientIds) {
      importedClientIds.add(clientId);
    }
    await persistJobResult("clients", result.summary, result.rows);
  }

  if (expandedTypes.includes("bike_candidates_from_deals")) {
    const result = await commitBikeCandidatesFromLegacyRows(
      sharedCtx,
      bundle.orders.rows,
      diagnostics.get("bike_candidates_from_deals")?.rows ?? []
    );
    await persistJobResult("bike_candidates_from_deals", result.summary, result.rows);
  }

  if (expandedTypes.includes("rental_deals")) {
    const result = await commitRentalDealsFromLegacyRows(
      sharedCtx,
      bundle.orders.rows,
      bundle.partialPayments.orders,
      diagnostics.get("rental_deals")?.rows ?? []
    );
    await persistJobResult("rental_deals", result.summary, result.rows);
  }

  if (expandedTypes.includes("buyout_deals")) {
    const result = await commitBuyoutDealsFromLegacyRows(
      sharedCtx,
      bundle.orders.rows,
      bundle.config.buyoutPaymentPresets,
      diagnostics.get("buyout_deals")?.rows ?? []
    );
    await persistJobResult("buyout_deals", result.summary, result.rows);
  }

  if (expandedTypes.includes("notes_and_operational_flags")) {
    const result = await commitNotesFromLegacyRows(
      sharedCtx,
      bundle.orders.rows,
      bundle.orderNotes.orders,
      bundle.batteryCounts.orders,
      diagnostics.get("notes_and_operational_flags")?.rows ?? []
    );
    await persistJobResult("notes_and_operational_flags", result.summary, result.rows);
  }

  if (shouldRunClientEnrichment(expandedTypes)) {
    const enrichment = await runClientEnrichmentStage({
      tenantId: tenant.id,
      clientIds: [...importedClientIds]
    });
    await persistJobResult(CLIENT_ENRICHMENT_ENTITY_TYPE, enrichment.summary, enrichment.rows);
  }

  await prisma.$transaction(async (tx) => {
    await finalizeImportJobs(tx, {
      importId: createdImport.importRecord.id,
      importStatus: "COMPLETED",
      jobIdsByEntityType,
      summaries
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "import",
        entityId: createdImport.importRecord.id,
        action: "legacy.commit.completed",
        newValueText: serializeAuditValue({
          source: "LEGACY_CRM",
          summaries: summaries.map((summary) => ({
            entityType: summary.entityType,
            createdRows: summary.createdRows,
            existingRows: summary.existingRows,
            skippedRows: summary.skippedRows,
            warningRows: summary.warningRows,
            failedRows: summary.failedRows,
            successRows: summary.successRows
          })),
          overviewCounts: overview.counts
        }),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });
  });

  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name
    },
    import: createdImport.importRecord,
    selectedTargets,
    summaries,
    overviewCounts: overview.counts
  };
}

export async function replayLegacyImport(params: {
  tenantSlug?: string;
  importId: string;
  importName?: string;
  dryRun?: boolean;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const slug = normalizeTenantSlug(params.tenantSlug);
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true }
  });

  if (!tenant) {
    throw new HttpError(404, `Tenant '${slug}' was not found`);
  }

  const importRecord = await prisma.import.findFirst({
    where: {
      id: params.importId,
      tenantId: tenant.id
    },
    include: {
      jobs: {
        orderBy: {
          createdAt: "asc"
        }
      }
    }
  });

  if (!importRecord) {
    throw new HttpError(404, "Import not found");
  }

  if (importRecord.source !== "LEGACY_CRM") {
    throw new HttpError(400, "Replay is supported only for LEGACY_CRM imports");
  }

  const entityTypes = uniqueBy(
    importRecord.jobs
      .map((job) => job.entityType)
      .filter((value): value is SupportedLegacyEntityType => (
        value !== CLIENT_ENRICHMENT_ENTITY_TYPE
        && SUPPORTED_LEGACY_ENTITY_TYPES.includes(value as SupportedLegacyEntityType)
      )),
    (value) => value
  );

  if (entityTypes.length === 0) {
    throw new HttpError(400, "Source import does not contain replayable legacy entity types");
  }

  const nextName = params.importName?.trim()
    || `${params.dryRun ? "Legacy dry-run replay" : "Legacy replay"} of ${importRecord.name}`;

  const basePayload = {
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    importName: nextName,
    duplicatePolicy: importRecord.duplicatePolicy ?? "MERGE_BY_LEGACY_KEY",
    entityTypes,
    actorUserId: params.actorUserId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent
  };

  if (params.dryRun) {
    return createLegacyDryRunImport(basePayload);
  }

  return commitLegacyImport(basePayload);
}

function createEmptyImportRowSummary() {
  return {
    totalRows: 0,
    createdRows: 0,
    matchedRows: 0,
    skippedRows: 0,
    failedRows: 0,
    warningRows: 0,
    reliableRows: 0,
    heuristicRows: 0
  };
}

async function loadImportRowSummaryMap(tenantId: string, jobIds: string[]) {
  const rowSummaryByJobId = new Map<string, ReturnType<typeof createEmptyImportRowSummary>>();
  if (jobIds.length === 0) {
    return rowSummaryByJobId;
  }

  const rowGroups = await prisma.importJobRow.groupBy({
    by: ["importJobId", "decision", "severity", "matchQuality"],
    where: {
      tenantId,
      importJobId: {
        in: jobIds
      }
    },
    _count: {
      _all: true
    }
  });

  for (const row of rowGroups) {
    const current = rowSummaryByJobId.get(row.importJobId) ?? createEmptyImportRowSummary();

    current.totalRows += row._count._all;
    if (row.decision === ImportRowDecision.CREATE) {
      current.createdRows += row._count._all;
    }
    if (row.decision === ImportRowDecision.MATCH_EXISTING) {
      current.matchedRows += row._count._all;
    }
    if (row.decision === ImportRowDecision.SKIP) {
      current.skippedRows += row._count._all;
    }
    if (row.decision === ImportRowDecision.FAIL) {
      current.failedRows += row._count._all;
    }
    if (row.severity === ImportIssueSeverity.WARNING) {
      current.warningRows += row._count._all;
    }
    if (row.matchQuality === ImportMatchQuality.RELIABLE) {
      current.reliableRows += row._count._all;
    }
    if (row.matchQuality === ImportMatchQuality.HEURISTIC) {
      current.heuristicRows += row._count._all;
    }

    rowSummaryByJobId.set(row.importJobId, current);
  }

  return rowSummaryByJobId;
}

function sortImportRows<T extends {
  severity: ImportIssueSeverity;
  decision: ImportRowDecision;
  sourceRecordLabel: string;
}>(rows: T[]) {
  const severityWeight: Record<ImportIssueSeverity, number> = {
    ERROR: 0,
    WARNING: 1,
    INFO: 2
  };
  const decisionWeight: Record<ImportRowDecision, number> = {
    FAIL: 0,
    CREATE: 1,
    MATCH_EXISTING: 2,
    SKIP: 3
  };

  return [...rows].sort((left, right) => (
    severityWeight[left.severity] - severityWeight[right.severity]
    || decisionWeight[left.decision] - decisionWeight[right.decision]
    || left.sourceRecordLabel.localeCompare(right.sourceRecordLabel, "ru")
  ));
}

export async function getImportDetail(params: {
  tenantSlug?: string;
  importId: string;
  rowLimitPerJob?: number;
}) {
  const slug = normalizeTenantSlug(params.tenantSlug);
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true }
  });

  if (!tenant) {
    throw new HttpError(404, `Tenant '${slug}' was not found`);
  }

  const importRecord = await prisma.import.findFirst({
    where: {
      id: params.importId,
      tenantId: tenant.id
    },
    include: {
      jobs: {
        orderBy: [
          { createdAt: "desc" },
          { entityType: "asc" }
        ]
      }
    }
  });

  if (!importRecord) {
    throw new HttpError(404, "Import not found");
  }

  const jobIds = importRecord.jobs.map((job) => job.id);
  const rowSummaryByJobId = await loadImportRowSummaryMap(tenant.id, jobIds);
  const rowLimitPerJob = Math.min(Math.max(params.rowLimitPerJob ?? 40, 1), 200);

  const rows = jobIds.length > 0
    ? await prisma.importJobRow.findMany({
        where: {
          tenantId: tenant.id,
          importJobId: {
            in: jobIds
          }
        },
        select: {
          id: true,
          importJobId: true,
          sourceEntityType: true,
          sourceRecordKey: true,
          sourceRecordLabel: true,
          decision: true,
          severity: true,
          matchQuality: true,
          matchedEntityType: true,
          matchedEntityId: true,
          matchedEntityLabel: true,
          matchedBy: true,
          issueCode: true,
          issueText: true,
          detailsText: true,
          createdAt: true
        }
      })
    : [];

  const rowsByJobId = new Map<string, typeof rows>();
  for (const row of rows) {
    rowsByJobId.set(row.importJobId, [...(rowsByJobId.get(row.importJobId) ?? []), row]);
  }

  return {
    tenant,
    import: {
      ...importRecord,
      jobs: importRecord.jobs.map((job) => ({
        ...job,
        rowSummary: rowSummaryByJobId.get(job.id) ?? createEmptyImportRowSummary(),
        rows: sortImportRows(rowsByJobId.get(job.id) ?? []).slice(0, rowLimitPerJob)
      }))
    }
  };
}

export async function listImports(params: {
  tenantSlug?: string;
  limit?: number;
}) {
  const slug = normalizeTenantSlug(params.tenantSlug);
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true }
  });

  if (!tenant) {
    throw new HttpError(404, `Tenant '${slug}' was not found`);
  }

  const imports = await prisma.import.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(params.limit ?? 20, 1), 100),
    include: {
      jobs: {
        orderBy: [
          { createdAt: "desc" },
          { entityType: "asc" }
        ]
      }
    }
  });

  const jobIds = imports.flatMap((item) => item.jobs.map((job) => job.id));
  const rowSummaryByJobId = await loadImportRowSummaryMap(tenant.id, jobIds);

  return {
    tenant,
    rows: imports.map((importItem) => ({
      ...importItem,
      jobs: importItem.jobs.map((job) => ({
        ...job,
        rowSummary: rowSummaryByJobId.get(job.id) ?? {
          totalRows: 0,
          createdRows: 0,
          matchedRows: 0,
          skippedRows: 0,
          failedRows: 0,
          warningRows: 0,
          reliableRows: 0,
          heuristicRows: 0
        }
      }))
    }))
  };
}
