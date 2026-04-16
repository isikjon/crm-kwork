import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import type { GpsSnapshotRecord } from "./orders-api";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface RentalsListData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  query: string | null;
  statusFilter: string | null;
  rows: Array<{
    id: string;
    dealNumber: string;
    status: string;
    tariffLabel: string;
    startsAt: string;
    nextPaymentAt: string | null;
    plannedPaymentKopecks: number;
    debtKopecks: number;
    overdueDays: number;
    legacyExternalId: string | null;
    client: { fullName: string };
    bikeUnit: { title: string };
    _count: {
      penalties: number;
      deposits: number;
      notifications: number;
    };
    paymentSchedules: Array<{
      cadence: string;
      intervalValue: number;
      cycleAmountKopecks: number;
      nextDueAt: string | null;
      items: Array<{
        sequenceNumber: number;
        dueAt: string;
        amountKopecks: number;
        paidKopecks: number;
        status: string;
      }>;
    }>;
  }>;
}

export interface RentalDetailData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  deal: {
    id: string;
    dealNumber: string;
    status: string;
    isProblem: boolean;
    tariffCode: string;
    tariffLabel: string;
    startsAt: string;
    nextPaymentAt: string | null;
    plannedPaymentKopecks: number;
    debtKopecks: number;
    overdueDays: number;
    depositTargetKopecks: number;
    depositCollectedKopecks: number;
    depositReturnedKopecks: number;
    autoPenaltyEnabled: boolean;
    autoPenaltyDailyKopecks: number;
    graceDays: number;
    legacyExternalId: string | null;
    comment: string | null;
    createdAt: string;
    updatedAt: string;
    tariffSnapshots: Array<{
      id: string;
      tariffCode: string;
      label: string;
      durationDays: number;
      amountKopecks: number;
    }>;
    branch: {
      id: string;
      name: string;
      code: string;
    } | null;
    bank: {
      id: string;
      name: string;
      phone: string | null;
      comment: string | null;
      instructionType: string;
      requisitesTitle: string | null;
      requisitesText: string | null;
    } | null;
    availableBanks: Array<{
      id: string;
      name: string;
      instructionType: string;
    }>;
    client: {
      id: string;
      fullName: string;
      primaryPhone: string | null;
      telegramHandle: string | null;
      currentDebtKopecks: number;
      overdueDebtKopecks: number;
      activeDealsCount: number;
      paymentCount: number;
      overdueCount: number;
    };
    bikeUnit: {
      id: string;
      title: string;
      internalCode: string;
      article: string | null;
      serialNumber: string | null;
      status: string;
      rentalTariffGroup: {
        id: string;
        code: string;
        name: string;
        rates: Array<{
          id: string;
          label: string;
          durationDays: number;
          amountKopecks: number;
        }>;
      } | null;
      bikeModel: {
        name: string;
        article: string | null;
      } | null;
    };
    gps: GpsSnapshotRecord | null;
    equipment: Array<{
      id: string;
      type: "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
      label: string;
      quantity: number;
      comment: string | null;
    }>;
    deposits: Array<{
      id: string;
      amountKopecks: number;
      refundedKopecks: number;
      status: string;
      comment: string | null;
      createdAt: string;
    }>;
    depositRefunds: Array<{
      id: string;
      amountKopecks: number;
      comment: string | null;
      createdAt: string;
    }>;
    penalties: Array<{
      id: string;
      mode: string;
      status: string;
      amountKopecks: number;
      accrualDate: string;
      reason: string;
      comment: string | null;
    }>;
    notifications: Array<{
      id: string;
      channel: string;
      status: string;
      recipient: string;
      createdAt: string;
      sentAt: string | null;
    }>;
    paymentSchedules: Array<{
      id: string;
      cadence: string;
      intervalValue: number;
      startsAt: string;
      nextDueAt: string | null;
      cycleAmountKopecks: number;
      items: Array<{
        id: string;
        sequenceNumber: number;
        dueAt: string;
        amountKopecks: number;
        paidKopecks: number;
        status: string;
        closedAt: string | null;
      }>;
    }>;
    notes: Array<{
      id: string;
      text: string;
      colorHex: string | null;
      createdAt: string;
    }>;
    _count: {
      deposits: number;
      penalties: number;
      notifications: number;
      documents: number;
    };
  };
}

export async function loadRentalsList(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const data = await fetchCrmJsonServer<RentalsListData>(`/rentals?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=12`);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load rentals list"
    };
  }
}

export async function loadRentalDetail(dealId: string, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const data = await fetchCrmJsonServer<RentalDetailData>(`/rentals/${dealId}?tenantSlug=${encodeURIComponent(tenantSlug)}`);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load rental detail"
    };
  }
}
