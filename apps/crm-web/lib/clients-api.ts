import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface ClientListRecord {
  id: string;
  fullName: string;
  clientType: "INDIVIDUAL" | "LEGAL_ENTITY";
  workplace: string | null;
  courierId: string | null;
  primaryPhone: string | null;
  telegramHandle: string | null;
  currentDebtKopecks: number;
  overdueDebtKopecks: number;
  activeDealsCount: number;
  updatedAt: string;
  isProblemClient: boolean;
  isThief: boolean;
  flagComment: string | null;
  moneyBroughtKopecks: number;
  clientState: string;
  _count: {
    rentals: number;
    buyouts: number;
  };
}

export interface ClientDetailRecord {
  id: string;
  fullName: string;
  clientType: "INDIVIDUAL" | "LEGAL_ENTITY";
  taxId: string | null;
  kpp: string | null;
  ogrn: string | null;
  workplace: string | null;
  email: string | null;
  fax: string | null;
  maxHandle: string | null;
  courierId: string | null;
  primaryPhone: string | null;
  contactPersonName: string | null;
  telegramHandle: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  gender: string | null;
  comment: string | null;
  isProblemClient: boolean;
  isThief: boolean;
  flagComment: string | null;
  currentDebtKopecks: number;
  overdueDebtKopecks: number;
  activeDealsCount: number;
  paymentCount: number;
  overdueCount: number;
  legacyExternalId: string | null;
  updatedAt: string;
  moneyBroughtKopecks: number;
  rentalDaysTotal: number;
  clientState: string;
  identityData: {
    passportSeries: string | null;
    passportNumber: string | null;
    issuedBy: string | null;
    issuedAt: string | null;
    departmentCode: string | null;
    birthDate: string | null;
    registeredAddressFull: string | null;
    registeredAddressComment: string | null;
    registeredFiasCode: string | null;
    actualAddressFull: string | null;
    actualAddressComment: string | null;
    actualFiasCode: string | null;
  } | null;
  relatives: Array<{
    id: string;
    fullName: string;
    phone: string;
    comment: string | null;
  }>;
  contacts: Array<{
    id: string;
    value: string;
    isPrimary: boolean;
  }>;
  _count: {
    rentals: number;
    buyouts: number;
    notes: number;
    documents: number;
  };
}

export interface ClientDetailDealPreview {
  id: string;
  kind: "RENTAL" | "BUYOUT";
  dealNumber: string;
  status: string;
  nextPaymentAt: string | null;
  debtKopecks: number;
  bikeLabel: string;
  bikeArticle: string | null;
}

export interface ClientPaymentPreview {
  id: string;
  type: string;
  paymentMethod: "BANK" | "CASH";
  amountKopecks: number;
  postedAt: string | null;
  happenedAt: string;
  comment: string | null;
}

export interface ClientsListData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  query: string | null;
  rows: ClientListRecord[];
}

export interface ClientDetailData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  client: ClientDetailRecord;
  identityAccess: {
    canView: boolean;
    redacted: boolean;
  };
  activeDeals: ClientDetailDealPreview[];
  recentPayments: ClientPaymentPreview[];
}

export interface ClientWorkplacesData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  rows: Array<{
    id: string;
    label: string;
    usageCount: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

function buildClientsUrl(tenantSlug: string, params?: {
  q?: string | null;
  limit?: number;
}) {
  const searchParams = new URLSearchParams();
  searchParams.set("tenantSlug", tenantSlug);
  searchParams.set("limit", String(params?.limit ?? 120));

  const query = params?.q?.trim();
  if (query) {
    searchParams.set("q", query);
  }

  return `/clients?${searchParams.toString()}`;
}

export async function loadClientWorkplaces(tenantSlug?: string, cookieHeader?: string) {
  const resolvedTenantSlug = tenantSlug ?? await resolveTenantSlugFromCookieHeader({ cookieHeader });
  return fetchCrmJsonServer<ClientWorkplacesData>(`/clients/workplaces?tenantSlug=${encodeURIComponent(resolvedTenantSlug)}`);
}

export async function loadClientsWorkspace(params?: {
  q?: string | null;
  limit?: number;
}, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const clients = await fetchCrmJsonServer<ClientsListData>(buildClientsUrl(tenantSlug, params));

    return {
      apiBase,
      data: {
        clients
      },
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load clients list"
    };
  }
}

export async function loadClientDetail(clientId: string, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const [detail, workplaces] = await Promise.all([
      fetchCrmJsonServer<ClientDetailData>(`/clients/${clientId}?tenantSlug=${encodeURIComponent(tenantSlug)}`),
      loadClientWorkplaces(tenantSlug, cookieHeader)
    ]);

    return {
      apiBase,
      data: {
        detail,
        workplaces
      },
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load client detail"
    };
  }
}
