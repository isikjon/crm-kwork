import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface BanksListData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  query: string | null;
  rows: Array<{
    id: string;
    name: string;
    phone: string | null;
    comment: string | null;
    isActive: boolean;
    instructionType: string;
    branch: {
      name: string;
    } | null;
    assets: Array<{
      id: string;
      type: string;
      title: string;
      textBody: string | null;
      filePath: string | null;
      isPrimary: boolean;
    }>;
    _count: {
      rentals: number;
      buyouts: number;
      transactions: number;
    };
  }>;
}

export async function loadBanksList(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const data = await fetchCrmJsonServer<BanksListData>(`/banks?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=16`);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load banks list"
    };
  }
}
