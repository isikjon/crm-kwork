export interface LegacyOrderNote {
  id: string;
  text: string;
  color?: string | null;
}

export interface LegacyOrderService {
  positionId: string;
  name: string;
  quantity: number;
  days: number;
  price: number;
  assortmentHref: string;
  assortmentType: string;
}

export interface LegacyOrderRow {
  id: string;
  name: string;
  counterpartyHref?: string | null;
  customerName?: string | null;
  batteryCount?: number | null;
  notes?: LegacyOrderNote[];
  date?: string | null;
  dateInput?: string | null;
  state?: string | null;
  stateMetaHref?: string | null;
  services?: LegacyOrderService[];
  totalSum?: number | null;
}

export interface LegacyOrdersCache {
  savedAt?: number | null;
  rows: LegacyOrderRow[];
}

export interface LegacyPartialPaymentCycle {
  orderId: string;
  positionId: string;
  demandMetaHref?: string | null;
  dueKopecks: number;
  paidKopecks: number;
  paidDays: number;
  quantityIncrement?: number | null;
  serviceName?: string | null;
  updatedAt?: string | null;
}

export interface LegacyPartialPaymentsFile {
  orders: Record<string, Record<string, LegacyPartialPaymentCycle>>;
}

export interface LegacyOrderNotesFile {
  orders: Record<string, LegacyOrderNote[]>;
}

export interface LegacyBatteryCountsFile {
  orders: Record<string, number>;
}

export interface LegacyManualDemandState {
  initialized?: boolean;
  handledDemandHrefs?: string[];
}

export interface LegacyManualDemandSyncFile {
  orders: Record<string, LegacyManualDemandState>;
}

export interface LegacyNotificationJournalFile {
  rows: Array<Record<string, unknown>>;
}

export interface LegacyServiceDayRule {
  assortmentHref: string;
  name: string;
  days: number;
}

export interface LegacyBuyoutPreset {
  id: string;
  name: string;
  amountKopecks: number;
  intervalUnit: string;
  intervalValue: number;
}

export interface LegacyNotificationConfig {
  enabled?: boolean;
  due?: {
    enabled?: boolean;
    times?: string[];
    messageTemplate?: string;
  };
  overdue?: {
    enabled?: boolean;
    maxDays?: number;
    times?: string[];
    messageTemplate?: string;
  };
  managerMessageTemplate?: string;
}

export interface LegacyStarlineConfig {
  appId?: string;
  appSecret?: string;
}

export interface LegacyConfigFile {
  sourceDateField?: string;
  shiftDays?: number;
  serviceSearch?: {
    mode?: string;
    value?: string;
  };
  serviceDays?: LegacyServiceDayRule[];
  dashboardStateVisibilityMode?: string;
  dashboardVisibleStateMetaHrefs?: string[];
  banks?: Array<Record<string, unknown>>;
  defaultOrganizationMetaHref?: string;
  paymentDateAttributeName?: string;
  bankAttributeName?: string;
  sortDateAttributeName?: string;
  serviceQuantityIncrement?: number;
  buyoutPaymentPresets?: LegacyBuyoutPreset[];
  notifications?: LegacyNotificationConfig;
  starline?: LegacyStarlineConfig;
}

export interface LegacyFileStatus {
  key: string;
  fileName: string;
  path: string;
  exists: boolean;
  bytes: number;
  parseMode: "strict" | "lenient-trim" | "missing";
  records: number;
}

export interface LegacyStateStat {
  state: string;
  count: number;
}

export interface LegacyServiceStat {
  name: string;
  count: number;
}

export interface LegacyImportTarget {
  entity: string;
  availableRecords: number;
  strategy: string;
  matchingMode: "RELIABLE" | "MIXED" | "HEURISTIC";
  reliabilityNote: string;
  sourceFiles: string[];
  readyFields: string[];
  missingFields: string[];
}

export interface LegacyOverview {
  source: {
    dataDir: string;
    resolvedAt: string;
    files: LegacyFileStatus[];
  };
  rules: {
    sourceDateField: string | null;
    shiftDays: number;
    paymentDateAttributeName: string | null;
    bankAttributeName: string | null;
    sortDateAttributeName: string | null;
    serviceQuantityIncrement: number;
    serviceSearchMode: string | null;
    serviceSearchValue: string | null;
    visibleStateMetaHrefCount: number;
    serviceDays: LegacyServiceDayRule[];
    buyoutPaymentPresets: LegacyBuyoutPreset[];
    notifications: {
      enabled: boolean;
      dueEnabled: boolean;
      dueTimes: string[];
      overdueEnabled: boolean;
      overdueTimes: string[];
      overdueMaxDays: number;
      managerTemplateConfigured: boolean;
    };
    starlineConfigured: boolean;
  };
  counts: {
    ordersTotal: number;
    uniqueClients: number;
    activeRentals: number;
    activeBuyouts: number;
    completedRentals: number;
    completedBuyouts: number;
    overdueOrProblemDeals: number;
    partialPaymentCycles: number;
    partialPaymentOrders: number;
    manualDemandOrders: number;
    manualDemandHandledLinks: number;
    notesOrders: number;
    notesCount: number;
    batteryTrackedOrders: number;
    notificationJournalRows: number;
    productLineCandidates: number;
    inferredBikeCandidates: number;
  };
  states: LegacyStateStat[];
  topServices: LegacyServiceStat[];
  importTargets: LegacyImportTarget[];
  limitations: string[];
}

export interface LegacyNormalizedOrder {
  orderId: string;
  legacyNumber: string;
  dealKind: "rental" | "buyout" | "unknown";
  state: string;
  customerName: string | null;
  counterpartyHref: string | null;
  dealDate: string | null;
  totalKopecks: number;
  batteryCount: number;
  notesCount: number;
  manualDemandInitialized: boolean;
  handledDemandCount: number;
  partialPayment: {
    positions: number;
    dueKopecks: number;
    paidKopecks: number;
    outstandingKopecks: number;
    paidDays: number;
  };
  services: Array<{
    positionId: string;
    name: string;
    assortmentType: string;
    quantity: number;
    priceKopecks: number;
    days: number;
    isRentalTariff: boolean;
    isLikelyBikeUnit: boolean;
  }>;
}

export interface LegacyOrdersListResponse {
  rows: LegacyNormalizedOrder[];
  total: number;
  filtered: number;
  stateFilter: string | null;
  limit: number;
}

export interface LegacyDataBundle {
  files: LegacyFileStatus[];
  orders: LegacyOrdersCache;
  partialPayments: LegacyPartialPaymentsFile;
  orderNotes: LegacyOrderNotesFile;
  batteryCounts: LegacyBatteryCountsFile;
  manualDemandSync: LegacyManualDemandSyncFile;
  notificationJournal: LegacyNotificationJournalFile;
  config: LegacyConfigFile;
}
