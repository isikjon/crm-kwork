import { fetchCrmJson, getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface LegacyFileStatusView {
  key: string;
  fileName: string;
  path: string;
  exists: boolean;
  bytes: number;
  parseMode: "strict" | "lenient-trim" | "missing";
  records: number;
}

export interface LegacyOverviewView {
  source: {
    dataDir: string;
    resolvedAt: string;
    files: LegacyFileStatusView[];
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
    serviceDays: Array<{ name: string; days: number }>;
    buyoutPaymentPresets: Array<{ id: string; name: string; amountKopecks: number; intervalUnit: string; intervalValue: number }>;
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
  states: Array<{ state: string; count: number }>;
  topServices: Array<{ name: string; count: number }>;
  importTargets: Array<{
    entity: string;
    availableRecords: number;
    strategy: string;
    matchingMode: "RELIABLE" | "MIXED" | "HEURISTIC";
    reliabilityNote: string;
    sourceFiles: string[];
    readyFields: string[];
    missingFields: string[];
  }>;
  limitations: string[];
}

export interface LegacyOrdersPreviewView {
  rows: Array<{
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
  }>;
  total: number;
  filtered: number;
  stateFilter: string | null;
  limit: number;
}

export interface LegacyImportDashboardData {
  apiBase: string;
  overview: LegacyOverviewView | null;
  ordersPreview: LegacyOrdersPreviewView | null;
  imports: LegacyImportsListView | null;
  latestImportDetail: LegacyImportDetailView | null;
  progress: ImplementationProgressView | null;
  error: string | null;
}

export interface ImportJobRowSummaryView {
  totalRows: number;
  createdRows: number;
  matchedRows: number;
  skippedRows: number;
  failedRows: number;
  warningRows: number;
  reliableRows: number;
  heuristicRows: number;
}

export interface ImportJobRowView {
  id: string;
  sourceEntityType: string;
  sourceRecordKey: string;
  sourceRecordLabel: string;
  decision: "CREATE" | "MATCH_EXISTING" | "SKIP" | "FAIL";
  severity: "INFO" | "WARNING" | "ERROR";
  matchQuality: "RELIABLE" | "HEURISTIC" | null;
  matchedEntityType: string | null;
  matchedEntityId: string | null;
  matchedEntityLabel: string | null;
  matchedBy: string | null;
  issueCode: string | null;
  issueText: string | null;
  detailsText: string | null;
  createdAt: string;
}

export interface LegacyImportJobView {
  id: string;
  entityType: string;
  status: string;
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  startedAt: string | null;
  finishedAt: string | null;
  logText: string | null;
  rowSummary: ImportJobRowSummaryView;
}

export interface LegacyImportView {
  id: string;
  source: string;
  status: string;
  name: string;
  dryRun: boolean;
  duplicatePolicy: string | null;
  createdAt: string;
  updatedAt: string;
  jobs: LegacyImportJobView[];
}

export interface LegacyImportsListView {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  rows: LegacyImportView[];
}

export interface LegacyImportDetailView {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  import: Omit<LegacyImportView, "jobs"> & {
    jobs: Array<LegacyImportJobView & {
      rows: ImportJobRowView[];
    }>;
  };
}

export interface ImplementationStageView {
  code: string;
  title: string;
  tzReferences: string[];
  status: "completed" | "in_progress" | "pending";
  summary: string;
  done: string[];
  next: string[];
  risks: string[];
}

export interface ImplementationProgressView {
  currentStage: ImplementationStageView;
  stages: ImplementationStageView[];
  currentFocus: Array<{
    tzPoint: string;
    label: string;
    status: "completed" | "in_progress" | "pending";
    note: string;
  }>;
}

export async function loadLegacyImportDashboardData(cookieHeader?: string): Promise<LegacyImportDashboardData> {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const [overviewResult, ordersResult, importsResult, progressResult] = await Promise.allSettled([
      fetchCrmJsonServer<LegacyOverviewView>(`/legacy/overview?tenantSlug=${tenantSlug}`),
      fetchCrmJsonServer<LegacyOrdersPreviewView>(`/legacy/orders?tenantSlug=${tenantSlug}&limit=6`),
      fetchCrmJsonServer<LegacyImportsListView>(`/imports?tenantSlug=${tenantSlug}&limit=6`),
      fetchCrmJson<ImplementationProgressView>("/meta/progress")
    ]);

    if (overviewResult.status !== "fulfilled" || ordersResult.status !== "fulfilled") {
      const overviewError =
        overviewResult.status === "rejected"
          ? overviewResult.reason instanceof Error
            ? overviewResult.reason.message
            : "Legacy overview request failed"
          : null;
      const ordersError =
        ordersResult.status === "rejected"
          ? ordersResult.reason instanceof Error
            ? ordersResult.reason.message
            : "Legacy orders request failed"
          : null;

      throw new Error(
        overviewError ?? ordersError ?? "Legacy import request failed"
      );
    }

    const imports = importsResult.status === "fulfilled" ? importsResult.value : null;
    const latestImportDetail = imports?.rows[0]
      ? await fetchCrmJsonServer<LegacyImportDetailView>(`/imports/${imports.rows[0].id}?tenantSlug=${tenantSlug}&rowLimitPerJob=6`).catch(() => null)
      : null;

    return {
      apiBase,
      overview: overviewResult.value,
      ordersPreview: ordersResult.value,
      imports,
      latestImportDetail,
      progress: progressResult.status === "fulfilled" ? progressResult.value : null,
      error: null
    };
  } catch (error) {
    return {
      apiBase,
      overview: null,
      ordersPreview: null,
      imports: null,
      latestImportDetail: null,
      progress: null,
      error: error instanceof Error ? error.message : "Unable to reach CRM API"
    };
  }
}
