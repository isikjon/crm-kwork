import { getCrmApiBase } from "./crm-api-base";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface FleetListData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  query: string | null;
  statusFilter: string | null;
  quickFilter: "available" | "rented" | "buyout" | "repair" | "gps_issue" | "attention" | null;
  summary: {
    total: number;
    availableCount: number;
    rentedCount: number;
    buyoutCount: number;
    repairCount: number;
    reservedCount: number;
    gpsIssueCount: number;
    attentionCount: number;
  };
  rows: Array<{
    id: string;
    internalCode: string;
    title: string;
    article: string | null;
    serialNumber: string | null;
    status: string;
    odometerKm: number;
    purchaseCostKopecks: number;
    salePriceKopecks: number;
    valuationKopecks: number;
    lastIssuedAt: string | null;
    legacyExternalId: string | null;
    conditionNote: string | null;
    rentalTariffGroup: {
      id: string;
      name: string;
      code: string;
    } | null;
    buyoutTariffGroup: {
      id: string;
      name: string;
      code: string;
    } | null;
    bikeModel: { id: string; name: string } | null;
    currentClient: { id: string; fullName: string } | null;
    branch: { id: string; name: string } | null;
    activeDeal: {
      kind: "RENTAL" | "BUYOUT";
      id: string;
      dealNumber: string;
      status: string;
      clientName: string;
      nextPaymentAt: string | null;
    } | null;
    openRepair: {
      id: string;
      title: string;
      status: "OPEN";
      serviceDate: string;
      costKopecks: number;
    } | null;
    gps: {
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
    } | null;
    attention: {
      hasGpsIssue: boolean;
      needsAttention: boolean;
      reasons: string[];
    };
    economics: {
      revenueKopecks: number;
      repairCostKopecks: number;
      netProfitKopecks: number;
    };
    _count: {
      rentals: number;
      buyouts: number;
      repairs: number;
    };
  }>;
}

export interface BikeWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  branches: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  bikeModels: Array<{
    id: string;
    name: string;
    article: string | null;
  }>;
}

export interface BikeDetailData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  bike: {
    id: string;
    internalCode: string;
    title: string;
    article: string | null;
    serialNumber: string | null;
    status: string;
    odometerKm: number;
    purchaseCostKopecks: number;
    salePriceKopecks: number;
    valuationKopecks: number;
    photoPath: string | null;
    conditionNote: string | null;
    comment: string | null;
    lastIssuedAt: string | null;
    legacyExternalId: string | null;
    branch: { id: string; name: string } | null;
    bikeModel: { id: string; name: string; article: string | null } | null;
    currentClient: { id: string; fullName: string; primaryPhone: string | null } | null;
    rentalTariffGroup: { id: string; name: string; code: string } | null;
    buyoutTariffGroup: { id: string; name: string; code: string } | null;
    repairs: Array<{
      id: string;
      title: string;
      status: "OPEN" | "COMPLETED";
      serviceDate: string;
      completedAt: string | null;
      costKopecks: number;
      description: string | null;
    }>;
    summary: {
      rentalsCount: number;
      buyoutsCount: number;
      repairsCount: number;
      workedDurationDays: number;
      workedDurationLabel: string;
      utilization: {
        last7Days: {
          workedDays: number;
          utilizationPercent: number;
        };
        last30Days: {
          workedDays: number;
          utilizationPercent: number;
        };
        last365Days: {
          workedDays: number;
          utilizationPercent: number;
        };
      };
    };
    economics: {
      moneyBroughtKopecks: number;
      repairSpentKopecks: number;
      netProfitKopecks: number;
    };
    gps: {
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
    } | null;
    activeRental: {
      id: string;
      dealNumber: string;
      status: string;
      nextPaymentAt: string | null;
      debtKopecks: number;
      overdueDays: number;
      plannedPaymentKopecks: number;
      client: {
        id: string;
        fullName: string;
      };
      equipmentItems: Array<{
        id: string;
        type: "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
        label: string;
        quantity: number;
        comment: string | null;
      }>;
    } | null;
    activeBuyout: {
      id: string;
      dealNumber: string;
      status: string;
      nextPaymentAt: string | null;
      residualDebtKopecks: number;
      overdueDays: number;
      financedAmountKopecks: number;
      client: {
        id: string;
        fullName: string;
      };
      equipmentItems: Array<{
        id: string;
        type: "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
        label: string;
        quantity: number;
        comment: string | null;
      }>;
    } | null;
    issuedEquipment: Array<{
      id: string;
      type: "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
      label: string;
      quantity: number;
      comment: string | null;
    }>;
    recentDeals: {
      rentals: Array<{
        id: string;
        dealNumber: string;
        status: string;
        startsAt: string;
        nextPaymentAt: string | null;
        client: { fullName: string };
      }>;
      buyouts: Array<{
        id: string;
        dealNumber: string;
        status: string;
        startsAt: string;
        nextPaymentAt: string | null;
        client: { fullName: string };
      }>;
    };
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}

function buildFleetQuery(tenantSlug: string, query: {
  q?: string | null;
  status?: string | null;
  quick?: "available" | "rented" | "buyout" | "repair" | "gps_issue" | "attention" | null;
  limit?: number;
}) {
  const params = new URLSearchParams({
    tenantSlug,
    limit: String(query.limit ?? 24)
  });

  if (query.q?.trim()) {
    params.set("q", query.q.trim());
  }

  if (query.status?.trim()) {
    params.set("status", query.status.trim());
  }

  if (query.quick?.trim()) {
    params.set("quick", query.quick.trim());
  }

  return params.toString();
}

export async function loadFleetList(query: {
  q?: string | null;
  status?: string | null;
  quick?: "available" | "rented" | "buyout" | "repair" | "gps_issue" | "attention" | null;
  limit?: number;
}, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const response = await fetch(`${apiBase}/bikes?${buildFleetQuery(tenantSlug, query)}`, {
      cache: "no-store",
      ...(cookieHeader
        ? {
            headers: {
              cookie: cookieHeader
            }
          }
        : {})
    });
    const data = await parseJsonResponse<FleetListData>(response);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load bike list"
    };
  }
}

export async function loadBikeDetail(bikeId: string, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const response = await fetch(`${apiBase}/bikes/${bikeId}?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
      cache: "no-store",
      ...(cookieHeader
        ? {
            headers: {
              cookie: cookieHeader
            }
          }
        : {})
    });
    const data = await parseJsonResponse<BikeDetailData>(response);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load bike detail"
    };
  }
}

export async function loadBikeWorkspace(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const response = await fetch(`${apiBase}/bikes/workspace?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
      cache: "no-store",
      ...(cookieHeader
        ? {
            headers: {
              cookie: cookieHeader
            }
          }
        : {})
    });
    const data = await parseJsonResponse<BikeWorkspaceData>(response);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load bike workspace"
    };
  }
}
