import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface RepairBankOption {
  id: string;
  name: string;
  instructionType: string;
  branch: {
    name: string;
  } | null;
}

export interface RepairsListData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  query: string | null;
  statusFilter: string | null;
  summary: {
    openCount: number;
    completedCount: number;
  };
  banks: RepairBankOption[];
  rows: Array<{
    id: string;
    title: string;
    description: string | null;
    status: "OPEN" | "COMPLETED";
    serviceDate: string;
    completedAt: string | null;
    executorName: string | null;
    sourceName: string | null;
    costKopecks: number;
    bikeUnit: {
      id: string;
      title: string;
      article: string | null;
      internalCode: string;
      status: string;
    };
    items: Array<{
      id: string;
      title: string;
      quantity: number;
      amountKopecks: number;
      transactionId: string | null;
      comment: string | null;
      createdAt: string;
      bank: {
        name: string;
      } | null;
    }>;
  }>;
}

export interface RepairsWorkspaceData {
  repairs: RepairsListData;
  banks: RepairBankOption[];
}

function buildRepairsUrl(tenantSlug: string) {
  return `/repairs?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=24`;
}

export async function loadRepairsWorkspace(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const repairs = await fetchCrmJsonServer<RepairsListData>(buildRepairsUrl(tenantSlug));

    return {
      apiBase,
      data: {
        repairs,
        banks: repairs.banks
      } satisfies RepairsWorkspaceData,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load repairs workspace"
    };
  }
}
