import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import {
  type LegacyBatteryCountsFile,
  type LegacyConfigFile,
  type LegacyDataBundle,
  type LegacyFileStatus,
  type LegacyImportTarget,
  type LegacyManualDemandSyncFile,
  type LegacyNormalizedOrder,
  type LegacyNotificationJournalFile,
  type LegacyOrderRow,
  type LegacyOrderNotesFile,
  type LegacyOrdersCache,
  type LegacyOrdersListResponse,
  type LegacyOverview,
  type LegacyPartialPaymentCycle,
  type LegacyPartialPaymentsFile,
  type LegacyStateStat,
  type LegacyServiceStat
} from "./types.js";
import { isAssignableBikeUnitName } from "../fleet/bike-unit-classifier.js";

const LEGACY_FILE_MAP = {
  orders: "orders.cache.json",
  partialPayments: "rental-partial-payments.json",
  orderNotes: "order-notes.json",
  batteryCounts: "order-battery-counts.json",
  notificationJournal: "notification-journal.json",
  manualDemandSync: "manual-demand-sync.json",
  config: "config.local.json"
} as const;

const ACTIVE_RENTAL_STATES = new Set(["В Аренде"]);
const ACTIVE_BUYOUT_STATES = new Set(["Выкуп"]);
const COMPLETED_RENTAL_STATES = new Set(["Аренда завершена", "Оплатил", "Доставлен"]);
const COMPLETED_BUYOUT_STATES = new Set(["Выкуп Завершен", "Продан"]);
const PROBLEM_STATES = new Set(["Проблемы", "Выплата долга"]);

function createEmptyOrdersCache(): LegacyOrdersCache {
  return { rows: [] };
}

function createEmptyPartialPayments(): LegacyPartialPaymentsFile {
  return { orders: {} };
}

function createEmptyNotes(): LegacyOrderNotesFile {
  return { orders: {} };
}

function createEmptyBatteryCounts(): LegacyBatteryCountsFile {
  return { orders: {} };
}

function createEmptyManualDemandSync(): LegacyManualDemandSyncFile {
  return { orders: {} };
}

function createEmptyNotificationJournal(): LegacyNotificationJournalFile {
  return { rows: [] };
}

function createEmptyConfig(): LegacyConfigFile {
  return {};
}

function resolveLegacyDataDir() {
  return path.resolve(env.LEGACY_CRM_DATA_DIR);
}

async function readLegacyJsonFile<T>(
  fileKey: keyof typeof LEGACY_FILE_MAP,
  fallbackFactory: () => T
): Promise<{ data: T; status: LegacyFileStatus }> {
  const dataDir = resolveLegacyDataDir();
  const fileName = LEGACY_FILE_MAP[fileKey];
  const filePath = path.join(dataDir, fileName);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseLegacyJson<T>(raw);

    return {
      data: parsed.data,
      status: {
        key: fileKey,
        fileName,
        path: filePath,
        exists: true,
        bytes: Buffer.byteLength(raw),
        parseMode: parsed.parseMode,
        records: estimateRecordCount(parsed.data)
      }
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        data: fallbackFactory(),
        status: {
          key: fileKey,
          fileName,
          path: filePath,
          exists: false,
          bytes: 0,
          parseMode: "missing",
          records: 0
        }
      };
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: string }).code === "string" &&
      (error as { code?: string }).code === "ENOENT"
  );
}

function parseLegacyJson<T>(raw: string): { data: T; parseMode: LegacyFileStatus["parseMode"] } {
  try {
    return {
      data: JSON.parse(raw) as T,
      parseMode: "strict"
    };
  } catch {
    const repaired = trimTrailingClosers(raw);
    return {
      data: JSON.parse(repaired) as T,
      parseMode: "lenient-trim"
    };
  }
}

function trimTrailingClosers(raw: string): string {
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

function estimateRecordCount(data: unknown): number {
  if (Array.isArray(data)) {
    return data.length;
  }

  if (!data || typeof data !== "object") {
    return 0;
  }

  if ("rows" in data && Array.isArray((data as { rows?: unknown[] }).rows)) {
    return (data as { rows: unknown[] }).rows.length;
  }

  if ("orders" in data && typeof (data as { orders?: object }).orders === "object") {
    return Object.keys((data as { orders: Record<string, unknown> }).orders).length;
  }

  return Object.keys(data as Record<string, unknown>).length;
}

function getOrderNotesCount(order: LegacyOrderRow, notesMap: LegacyOrderNotesFile["orders"]) {
  const embedded = Array.isArray(order.notes) ? order.notes.length : 0;
  const separate = Array.isArray(notesMap[order.id]) ? notesMap[order.id].length : 0;
  return Math.max(embedded, separate);
}

function flattenPartialPaymentCycles(
  partialPayments: LegacyPartialPaymentsFile["orders"]
): LegacyPartialPaymentCycle[] {
  return Object.values(partialPayments).flatMap((positions) => Object.values(positions ?? {}));
}

function getPartialPaymentSummary(
  orderId: string,
  partialPayments: LegacyPartialPaymentsFile["orders"]
) {
  const positions = Object.values(partialPayments[orderId] ?? {});
  return positions.reduce(
    (summary, position) => {
      summary.positions += 1;
      summary.dueKopecks += Number(position.dueKopecks ?? 0);
      summary.paidKopecks += Number(position.paidKopecks ?? 0);
      summary.outstandingKopecks += Math.max(
        0,
        Number(position.dueKopecks ?? 0) - Number(position.paidKopecks ?? 0)
      );
      summary.paidDays += Number(position.paidDays ?? 0);
      return summary;
    },
    {
      positions: 0,
      dueKopecks: 0,
      paidKopecks: 0,
      outstandingKopecks: 0,
      paidDays: 0
    }
  );
}

function classifyDealKind(state: string | null | undefined): LegacyNormalizedOrder["dealKind"] {
  if (!state) {
    return "unknown";
  }

  if (state.includes("Выкуп") || ACTIVE_BUYOUT_STATES.has(state) || COMPLETED_BUYOUT_STATES.has(state)) {
    return "buyout";
  }

  if (state.includes("Аренда") || ACTIVE_RENTAL_STATES.has(state) || COMPLETED_RENTAL_STATES.has(state)) {
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

function buildStateStats(orders: LegacyOrderRow[]): LegacyStateStat[] {
  const counters = new Map<string, number>();

  for (const order of orders) {
    const state = order.state?.trim() || "Без статуса";
    counters.set(state, (counters.get(state) ?? 0) + 1);
  }

  return [...counters.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((left, right) => right.count - left.count || left.state.localeCompare(right.state, "ru"));
}

function buildServiceStats(orders: LegacyOrderRow[]): LegacyServiceStat[] {
  const counters = new Map<string, number>();

  for (const order of orders) {
    for (const service of order.services ?? []) {
      const name = service.name?.trim() || "Без названия";
      counters.set(name, (counters.get(name) ?? 0) + 1);
    }
  }

  return [...counters.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "ru"));
}

function buildImportTargets(bundle: LegacyDataBundle): LegacyImportTarget[] {
  const uniqueClients = new Set(
    bundle.orders.rows
      .map((order) => `${order.counterpartyHref ?? ""}|${order.customerName ?? ""}`.trim())
      .filter((value) => value !== "|")
  ).size;

  const likelyBikeRows = bundle.orders.rows.flatMap((order) =>
    (order.services ?? []).filter((service) => isLikelyBikeUnit(service.name, service.assortmentType))
  ).length;

  return [
    {
      entity: "clients",
      availableRecords: uniqueClients,
      strategy: "customerName + counterpartyHref -> client stub, then enrich via dedicated import step",
      matchingMode: "MIXED",
      reliabilityNote: "Counterparty href дает reliable identity, а fallback по имени клиента остается только heuristic.",
      sourceFiles: ["orders.cache.json"],
      readyFields: ["customerName", "counterpartyHref"],
      missingFields: ["phone", "address", "identity data", "telegram handle"]
    },
    {
      entity: "rental_deals",
      availableRecords: bundle.orders.rows.filter((order) => classifyDealKind(order.state) === "rental").length,
      strategy: "state + services + totals + partial cycles -> rental deal ledger",
      matchingMode: "MIXED",
      reliabilityNote: "Сделка сама мачтится надежно по legacy order id, но клиент и bike candidate могут быть heuristic.",
      sourceFiles: ["orders.cache.json", "rental-partial-payments.json", "manual-demand-sync.json"],
      readyFields: ["deal state", "deal date", "line items", "totalSum", "partial payment state"],
      missingFields: ["tenant-side manager attribution", "branch attribution"]
    },
    {
      entity: "buyout_deals",
      availableRecords: bundle.orders.rows.filter((order) => classifyDealKind(order.state) === "buyout").length,
      strategy: "state + totals + buyout presets -> buyout seed, then rebuild schedule in new engine",
      matchingMode: "MIXED",
      reliabilityNote: "Сделка мачтится надежно по legacy order id, но клиент/bike identity и часть schedule history остаются неполными.",
      sourceFiles: ["orders.cache.json", "config.local.json"],
      readyFields: ["deal state", "customerName", "totalSum", "buyout payment presets"],
      missingFields: ["full schedule history", "explicit upfront payment marker"]
    },
    {
      entity: "notes_and_operational_flags",
      availableRecords: Object.keys(bundle.orderNotes.orders).length,
      strategy: "merge order-notes with embedded order notes and battery counters",
      matchingMode: "MIXED",
      reliabilityNote: "Сами заметки читаются прямо, но их target зависит от качества match по клиенту и сделке.",
      sourceFiles: ["order-notes.json", "order-battery-counts.json", "orders.cache.json"],
      readyFields: ["notes", "battery count"],
      missingFields: []
    },
    {
      entity: "bike_candidates_from_deals",
      availableRecords: likelyBikeRows,
      strategy: "product positions in historical deals -> candidate bike units until direct fleet import lands",
      matchingMode: "HEURISTIC",
      reliabilityNote: "Bike candidate строится из product/service строки и не является stable identity единицы техники.",
      sourceFiles: ["orders.cache.json"],
      readyFields: ["product line names", "assortment href"],
      missingFields: ["full free-fleet inventory", "serial number", "cost", "sale price"]
    }
  ];
}

function buildLimitations(bundle: LegacyDataBundle): string[] {
  const limitations = [
    "Старая data-папка хранит живой кэш сделок и operational JSON, но не полноценный реестр свободного парка.",
    "Карточки клиентов в текущем orders.cache.json не содержат телефоны и паспортные данные, поэтому client import идет в два шага.",
    "Полный rebuild графиков аренды и выкупа должен выполняться новым backend engine, а не просто копированием totals."
  ];

  const configFile = bundle.files.find((file) => file.key === "config");
  if (configFile?.exists) {
    limitations.push("Секреты Telegram и StarLine не копируются в новую CRM и должны быть заведены заново через настройки.");
  }

  const partialFile = bundle.files.find((file) => file.key === "partialPayments");
  if (partialFile?.parseMode === "lenient-trim") {
    limitations.push("Файл partial payments был поврежден лишними скобками; importer читает его lenient-mode, чтобы не потерять partial cycles.");
  }

  return limitations;
}

export async function loadLegacyDataBundle(): Promise<LegacyDataBundle> {
  const [orders, partialPayments, orderNotes, batteryCounts, notificationJournal, manualDemandSync, config] =
    await Promise.all([
      readLegacyJsonFile("orders", createEmptyOrdersCache),
      readLegacyJsonFile("partialPayments", createEmptyPartialPayments),
      readLegacyJsonFile("orderNotes", createEmptyNotes),
      readLegacyJsonFile("batteryCounts", createEmptyBatteryCounts),
      readLegacyJsonFile("notificationJournal", createEmptyNotificationJournal),
      readLegacyJsonFile("manualDemandSync", createEmptyManualDemandSync),
      readLegacyJsonFile("config", createEmptyConfig)
    ]);

  return {
    files: [
      orders.status,
      partialPayments.status,
      orderNotes.status,
      batteryCounts.status,
      notificationJournal.status,
      manualDemandSync.status,
      config.status
    ],
    orders: orders.data,
    partialPayments: partialPayments.data,
    orderNotes: orderNotes.data,
    batteryCounts: batteryCounts.data,
    manualDemandSync: manualDemandSync.data,
    notificationJournal: notificationJournal.data,
    config: config.data
  };
}

export async function getLegacyOverview(): Promise<LegacyOverview> {
  const bundle = await loadLegacyDataBundle();
  const orders = bundle.orders.rows;
  const partialCycles = flattenPartialPaymentCycles(bundle.partialPayments.orders);
  const states = buildStateStats(orders);
  const topServices = buildServiceStats(orders).slice(0, 12);
  const uniqueClients = new Set(
    orders
      .map((order) => `${order.counterpartyHref ?? ""}|${order.customerName ?? ""}`.trim())
      .filter((value) => value !== "|")
  );
  const manualDemandHandledLinks = Object.values(bundle.manualDemandSync.orders).reduce(
    (total, item) => total + (item.handledDemandHrefs?.length ?? 0),
    0
  );
  const notesCount = orders.reduce(
    (total, order) => total + getOrderNotesCount(order, bundle.orderNotes.orders),
    0
  );
  const productLineCandidates = orders.reduce(
    (total, order) =>
      total +
      (order.services ?? []).filter((service) => service.assortmentType === "product").length,
    0
  );
  const inferredBikeCandidates = orders.reduce(
    (total, order) =>
      total +
      (order.services ?? []).filter((service) => isLikelyBikeUnit(service.name, service.assortmentType)).length,
    0
  );
  const notifications = bundle.config.notifications ?? {};

  return {
    source: {
      dataDir: resolveLegacyDataDir(),
      resolvedAt: new Date().toISOString(),
      files: bundle.files
    },
    rules: {
      sourceDateField: bundle.config.sourceDateField ?? null,
      shiftDays: Number(bundle.config.shiftDays ?? 0),
      paymentDateAttributeName: bundle.config.paymentDateAttributeName ?? null,
      bankAttributeName: bundle.config.bankAttributeName ?? null,
      sortDateAttributeName: bundle.config.sortDateAttributeName ?? null,
      serviceQuantityIncrement: Number(bundle.config.serviceQuantityIncrement ?? 1),
      serviceSearchMode: bundle.config.serviceSearch?.mode ?? null,
      serviceSearchValue: bundle.config.serviceSearch?.value ?? null,
      visibleStateMetaHrefCount: bundle.config.dashboardVisibleStateMetaHrefs?.length ?? 0,
      serviceDays: bundle.config.serviceDays ?? [],
      buyoutPaymentPresets: bundle.config.buyoutPaymentPresets ?? [],
      notifications: {
        enabled: Boolean(notifications.enabled),
        dueEnabled: Boolean(notifications.due?.enabled),
        dueTimes: notifications.due?.times ?? [],
        overdueEnabled: Boolean(notifications.overdue?.enabled),
        overdueTimes: notifications.overdue?.times ?? [],
        overdueMaxDays: Number(notifications.overdue?.maxDays ?? 0),
        managerTemplateConfigured: Boolean(notifications.managerMessageTemplate)
      },
      starlineConfigured: Boolean(bundle.config.starline?.appId && bundle.config.starline?.appSecret)
    },
    counts: {
      ordersTotal: orders.length,
      uniqueClients: uniqueClients.size,
      activeRentals: orders.filter((order) => ACTIVE_RENTAL_STATES.has(order.state ?? "")).length,
      activeBuyouts: orders.filter((order) => ACTIVE_BUYOUT_STATES.has(order.state ?? "")).length,
      completedRentals: orders.filter((order) => COMPLETED_RENTAL_STATES.has(order.state ?? "")).length,
      completedBuyouts: orders.filter((order) => COMPLETED_BUYOUT_STATES.has(order.state ?? "")).length,
      overdueOrProblemDeals: orders.filter((order) => PROBLEM_STATES.has(order.state ?? "")).length,
      partialPaymentCycles: partialCycles.length,
      partialPaymentOrders: Object.keys(bundle.partialPayments.orders).length,
      manualDemandOrders: Object.keys(bundle.manualDemandSync.orders).length,
      manualDemandHandledLinks,
      notesOrders: Object.keys(bundle.orderNotes.orders).length,
      notesCount,
      batteryTrackedOrders: Object.keys(bundle.batteryCounts.orders).length,
      notificationJournalRows: bundle.notificationJournal.rows.length,
      productLineCandidates,
      inferredBikeCandidates
    },
    states,
    topServices,
    importTargets: buildImportTargets(bundle),
    limitations: buildLimitations(bundle)
  };
}

function normalizeOrder(
  order: LegacyOrderRow,
  bundle: LegacyDataBundle
): LegacyNormalizedOrder {
  const partialPayment = getPartialPaymentSummary(order.id, bundle.partialPayments.orders);
  const manualDemand = bundle.manualDemandSync.orders[order.id];

  return {
    orderId: order.id,
    legacyNumber: order.name,
    dealKind: classifyDealKind(order.state),
    state: order.state ?? "Без статуса",
    customerName: order.customerName ?? null,
    counterpartyHref: order.counterpartyHref ?? null,
    dealDate: order.dateInput ?? order.date ?? null,
    totalKopecks: Number(order.totalSum ?? 0),
    batteryCount: Number(bundle.batteryCounts.orders[order.id] ?? order.batteryCount ?? 0),
    notesCount: getOrderNotesCount(order, bundle.orderNotes.orders),
    manualDemandInitialized: Boolean(manualDemand?.initialized),
    handledDemandCount: manualDemand?.handledDemandHrefs?.length ?? 0,
    partialPayment,
    services: (order.services ?? []).map((service) => ({
      positionId: service.positionId,
      name: service.name,
      assortmentType: service.assortmentType,
      quantity: Number(service.quantity ?? 0),
      priceKopecks: Number(service.price ?? 0),
      days: Number(service.days ?? 0),
      isRentalTariff: Number(service.days ?? 0) > 0,
      isLikelyBikeUnit: isLikelyBikeUnit(service.name, service.assortmentType)
    }))
  };
}

export async function getLegacyOrdersList(params: {
  state?: string;
  limit?: number;
}): Promise<LegacyOrdersListResponse> {
  const bundle = await loadLegacyDataBundle();
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 100);
  const stateFilter = params.state?.trim() || null;

  const filteredRows = bundle.orders.rows.filter((order) =>
    stateFilter ? (order.state ?? "").toLowerCase() === stateFilter.toLowerCase() : true
  );

  return {
    rows: filteredRows.slice(0, limit).map((order) => normalizeOrder(order, bundle)),
    total: bundle.orders.rows.length,
    filtered: filteredRows.length,
    stateFilter,
    limit
  };
}
