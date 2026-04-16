import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export type OrdersScope = "ACTIVE" | "ALL";
export type OrdersAttention = "ALL" | "DEBT" | "OVERDUE" | "TODAY";
export type OrdersKind = "RENTAL" | "BUYOUT";
export type OrdersStatusGroup = "ALL_ACTIVE" | "RENTAL" | "BUYOUT" | "RENTAL_COMPLETED" | "BUYOUT_COMPLETED" | "PROBLEM" | "REPAIR";

export interface GpsSnapshotRecord {
  id: string;
  externalDeviceId: string;
  deviceName: string;
  deviceAlias: string | null;
  status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
  lastSeenAt: string | null;
  lastOnlineAt: string | null;
  lastSyncAt: string | null;
  lastSeenLabel: string | null;
  offlineAgeLabel: string | null;
  syncAgeLabel: string | null;
  syncState: "FRESH" | "WARNING" | "STALE" | "ERROR" | "UNKNOWN";
  lastSyncError: string | null;
}

export interface OrdersQuery {
  q?: string | null;
  kind?: OrdersKind | null;
  scope?: OrdersScope | null;
  attention?: OrdersAttention | null;
  statusGroup?: OrdersStatusGroup | null;
  focusKind?: OrdersKind | null;
  focusDealId?: string | null;
  limit?: number | null;
}

export interface UnifiedOrdersListData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  filters: {
    query: string | null;
    kind: OrdersKind | null;
    scope: OrdersScope;
    attention: OrdersAttention;
    statusGroup: OrdersStatusGroup;
    limit: number;
  };
  summary: {
    totalCount: number;
    filteredCount: number;
    rentalCount: number;
    buyoutCount: number;
    inWorkCount: number;
    problemCount: number;
    idleBikeCount: number;
    repairBikeCount: number;
    rentalCompletedCount: number;
    buyoutCompletedCount: number;
    overdueCount: number;
    dueTodayCount: number;
    debtorsCount: number;
    totalDebtKopecks: number;
  };
  rows: Array<{
    id: string;
    kind: OrdersKind;
    kindLabel: string;
    detailHref: string;
    dealNumber: string;
    status: string;
    paymentPlanLabel: string;
    startsAt: string;
    nextPaymentAt: string | null;
    paymentAmountKopecks: number;
    debtKopecks: number;
    penaltyBalanceKopecks: number;
    totalDueKopecks: number;
    overdueDays: number;
    client: {
      id: string;
      detailHref: string;
      fullName: string;
      primaryPhone: string | null;
    };
    bikeUnit: {
      title: string;
      article?: string | null;
    };
    branch: {
      name: string;
    } | null;
    bank: {
      id: string;
      name: string;
    } | null;
    _count: {
      penalties: number;
      deposits: number;
      notifications: number;
    };
    notes: Array<{
      id: string;
      text: string;
      colorHex: string | null;
      createdAt: string;
    }>;
    paymentSchedule: {
      cadence: string;
      intervalValue: number;
      cycleAmountKopecks: number;
      nextDueAt: string | null;
      items: Array<{
        id: string;
        sequenceNumber: number;
        dueAt: string;
        amountKopecks: number;
        paidKopecks: number;
        status: string;
      }>;
    } | null;
    attention: {
      code: string;
      label: string;
      rank: number;
    };
    mainStatus: {
      code: OrdersStatusGroup | "RENTAL" | "BUYOUT" | "PROBLEM" | "REPAIR";
      label: string;
    };
    gps: GpsSnapshotRecord | null;
  }>;
}

export interface OrderInlineDetailData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  deal: {
    id: string;
    kind: OrdersKind;
    kindLabel: string;
    detailHref: string;
    dealNumber: string;
    status: string;
    comment: string | null;
    startsAt: string;
    nextPaymentAt: string | null;
    paymentAmountKopecks: number;
    debtKopecks: number;
    penaltyBalanceKopecks: number;
    totalDueKopecks: number;
    overdueDays: number;
    autoPenaltyEnabled: boolean;
    autoPenaltyDailyKopecks: number;
    paymentPlanLabel?: string;
    mainStatus: {
      code: OrdersStatusGroup | "RENTAL" | "BUYOUT" | "PROBLEM" | "REPAIR";
      label: string;
    };
    attention: {
      code: string;
      label: string;
      rank: number;
    };
    bikeUnit: {
      title: string;
      internalCode: string;
      article: string | null;
      serialNumber: string | null;
      status: string;
    };
    bank: {
      id: string;
      name: string;
      phone: string | null;
      comment: string | null;
      instructionType: string;
    } | null;
    availableBanks: Array<{
      id: string;
      name: string;
      instructionType: string;
    }>;
    deposit: {
      targetKopecks: number;
      collectedKopecks: number;
      returnedKopecks: number;
      refundableKopecks: number;
      transactions: Array<{
        id: string;
        type: "DEPOSIT_IN" | "DEPOSIT_REFUND_OUT";
        paymentMethod: "BANK" | "CASH";
        amountKopecks: number;
        happenedAt: string;
        comment: string | null;
        bank: {
          id: string;
          name: string;
        } | null;
      }>;
    } | null;
    paymentSchedule: {
      cadence: string;
      intervalValue: number;
      nextDueAt: string | null;
      cycleAmountKopecks: number;
    } | null;
    equipment: Array<{
      id: string;
      type: "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
      label: string;
      quantity: number;
      comment: string | null;
    }>;
    payments: Array<{
      id: string;
      type: string;
      paymentMethod: string;
      amountKopecks: number;
      happenedAt: string;
      comment: string | null;
      bank: {
        name: string;
      } | null;
    }>;
    notes: Array<{
      id: string;
      text: string;
      colorHex: string | null;
      createdAt: string;
    }>;
    penalties: Array<{
      id: string;
      amountKopecks: number;
      reason: string;
      comment: string | null;
      accrualDate: string;
      mode: string;
    }>;
    penaltyHistory: Array<{
      id: string;
      amountKopecks: number;
      reason: string;
      comment: string | null;
      accrualDate: string;
      mode: string;
      status: string;
    }>;
    gps: GpsSnapshotRecord | null;
  };
}

function buildOrdersQueryString(tenantSlug: string, query: OrdersQuery) {
  const searchParams = new URLSearchParams();
  searchParams.set("tenantSlug", tenantSlug);

  if (query.q?.trim()) {
    searchParams.set("q", query.q.trim());
  }

  if (query.kind) {
    searchParams.set("kind", query.kind);
  }

  if (query.scope) {
    searchParams.set("scope", query.scope);
  }

  if (query.attention) {
    searchParams.set("attention", query.attention);
  }

  if (query.statusGroup) {
    searchParams.set("statusGroup", query.statusGroup);
  }

  if (query.focusKind) {
    searchParams.set("focusKind", query.focusKind);
  }

  if (query.focusDealId?.trim()) {
    searchParams.set("focusDealId", query.focusDealId.trim());
  }

  if (typeof query.limit === "number") {
    searchParams.set("limit", String(query.limit));
  }

  return searchParams.toString();
}

export async function loadUnifiedOrders(query: OrdersQuery = {}, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const data = await fetchCrmJsonServer<UnifiedOrdersListData>(`/orders?${buildOrdersQueryString(tenantSlug, {
      scope: "ACTIVE",
      attention: "ALL",
      statusGroup: "ALL_ACTIVE",
      limit: 36,
      ...query
    })}`);

    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load unified orders"
    };
  }
}

export async function loadOrderInlineDetail(params: {
  kind: OrdersKind;
  dealId: string;
}, cookieHeader?: string) {
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });
  return fetchCrmJsonServer<OrderInlineDetailData>(`/orders/${params.kind}/${params.dealId}/expand?tenantSlug=${encodeURIComponent(tenantSlug)}`);
}
