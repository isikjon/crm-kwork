import { getCrmApiBase } from "./crm-api-base";
import { getCurrentTenantSlugBrowser } from "./tenant";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export type FinanceQueryInput = Record<string, string | string[] | null | undefined>;

export interface FinanceWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  registry: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    query: string | null;
    filters: {
      type: string | null;
      contour: string | null;
      status: string | null;
      direction: string | null;
      paymentMethod: string | null;
      articleId: string | null;
      bankId: string | null;
      clientId: string | null;
      branchId: string | null;
      dealKind: string | null;
      dealNumber: string | null;
      amountFrom: string | null;
      amountTo: string | null;
      reconciled: boolean | null;
      period: string | null;
      dateFrom: string | null;
      dateTo: string | null;
    };
    summary: {
      incomeKopecks: number;
      expenseKopecks: number;
      netKopecks: number;
    };
    reconciliation: {
      reconciledCount: number;
      unreconciledCount: number;
      banks: Array<{
        bankId: string | null;
        bankName: string;
        reconciledIncomeKopecks: number;
        reconciledExpenseKopecks: number;
        unreconciledIncomeKopecks: number;
        unreconciledExpenseKopecks: number;
      }>;
    };
    rows: Array<{
      id: string;
      type: string;
      direction: "INCOME" | "EXPENSE";
      status: string;
      correctionKind: "NONE" | "REVERSAL";
      reversalOfTransactionId: string | null;
      reversalReason: string | null;
      reconciledAt: string | null;
      reconciliationNote: string | null;
      paymentMethod: string;
      amountKopecks: number;
      happenedAt: string;
      postedAt: string | null;
      comment: string | null;
      sourceLabel: string | null;
      externalReference: string | null;
      createdBy: {
        id: string;
        fullName: string;
      } | null;
      reconciledBy: {
        id: string;
        fullName: string;
      } | null;
      article: {
        id: string | null;
        name: string;
        systemKey: string | null;
        direction: "INCOME" | "EXPENSE";
        isActive: boolean;
        isSystem: boolean;
      } | null;
      client: {
        id: string;
        fullName: string;
      } | null;
      bank: {
        id: string;
        name: string;
      } | null;
      branch: {
        id: string;
        name: string;
        code: string;
      } | null;
      reversalOfTransaction: {
        id: string;
        type: string;
        direction: "INCOME" | "EXPENSE";
        amountKopecks: number;
        happenedAt: string;
      } | null;
      reversedByTransaction: {
        id: string;
        type: string;
        direction: "INCOME" | "EXPENSE";
        amountKopecks: number;
        happenedAt: string;
      } | null;
      deal: {
        kind: "RENTAL" | "BUYOUT";
        id: string;
        dealNumber: string;
      } | null;
    }>;
  };
  filters: {
    periods: Array<{ code: string; label: string }>;
    dealKinds: Array<{ code: string; label: string }>;
    directions: Array<{ code: string; label: string }>;
    paymentMethods: Array<{ code: string; label: string }>;
    reconciliationStates: Array<{ code: string; label: string }>;
    statuses: Array<{ code: string; label: string }>;
    banks: Array<{ id: string; name: string }>;
    branches: Array<{ id: string; name: string; code: string }>;
    clients: Array<{
      id: string;
      fullName: string;
      branch: {
        id: string;
        name: string;
        code: string;
      } | null;
    }>;
    articles: Array<{
      id: string;
      direction: "INCOME" | "EXPENSE";
      name: string;
      systemKey: string | null;
      isSystem: boolean;
      isActive: boolean;
      archivedAt: string | null;
      sortOrder: number;
      _count: {
        transactions: number;
      };
    }>;
  };
}

function getBrowserApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function buildFinanceQuery(tenantSlug: string, input?: FinanceQueryInput, options?: { includeLimit?: boolean }) {
  const params = new URLSearchParams();
  params.set("tenantSlug", tenantSlug);

  for (const [key, value] of Object.entries(input ?? {})) {
    if (Array.isArray(value)) {
      const first = value[0]?.trim();
      if (first) {
        params.set(key, first);
      }
      continue;
    }

    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) {
      params.set(key, normalized);
    }
  }

  if (options?.includeLimit !== false && !params.has("limit")) {
    params.set("limit", "64");
  }

  return params.toString();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}

export async function loadFinanceWorkspace(
  searchParams?: FinanceQueryInput,
  cookieHeader?: string
) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });
  const query = buildFinanceQuery(tenantSlug, searchParams);

  try {
    const response = await fetch(`${apiBase}/finance/workspace?${query}`, {
      cache: "no-store",
      ...(cookieHeader
        ? {
            headers: {
              cookie: cookieHeader
            }
          }
        : {})
    });

    const data = await parseJsonResponse<FinanceWorkspaceData>(response);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load finance workspace"
    };
  }
}

export async function createFinanceArticle(input: {
  direction: "INCOME" | "EXPENSE";
  name: string;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/finance/articles`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      direction: input.direction,
      name: input.name
    })
  });

  return parseJsonResponse(response);
}

export async function updateFinanceArticle(input: {
  articleId: string;
  name?: string;
  isActive?: boolean;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/finance/articles/${input.articleId}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      ...(input.name != null ? { name: input.name } : {}),
      ...(input.isActive != null ? { isActive: input.isActive } : {})
    })
  });

  return parseJsonResponse(response);
}

export async function createManualFinanceTransaction(input: {
  direction: "INCOME" | "EXPENSE";
  articleId: string;
  amountKopecks: number;
  paymentMethod: "BANK" | "CASH";
  bankId?: string | null;
  clientId?: string | null;
  branchId: string;
  happenedAt?: string | null;
  comment?: string | null;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/finance/manual-transactions`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      direction: input.direction,
      articleId: input.articleId,
      amountKopecks: input.amountKopecks,
      paymentMethod: input.paymentMethod,
      ...(input.bankId ? { bankId: input.bankId } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      branchId: input.branchId,
      ...(input.happenedAt ? { happenedAt: input.happenedAt } : {}),
      ...(input.comment?.trim() ? { comment: input.comment.trim() } : {})
    })
  });

  return parseJsonResponse(response);
}

export async function reverseFinanceTransaction(input: {
  transactionId: string;
  reason: string;
  happenedAt?: string | null;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/finance/transactions/${input.transactionId}/reverse`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      reason: input.reason,
      ...(input.happenedAt ? { happenedAt: input.happenedAt } : {})
    })
  });

  return parseJsonResponse(response);
}

export async function setFinanceTransactionReconciled(input: {
  transactionId: string;
  reconciled: boolean;
  note?: string | null;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/finance/transactions/${input.transactionId}/reconcile`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      reconciled: input.reconciled,
      ...(input.note?.trim() ? { note: input.note.trim() } : {})
    })
  });

  return parseJsonResponse(response);
}

export async function exportFinanceTransactionsCsv(filters?: FinanceQueryInput) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/finance/export.csv?${buildFinanceQuery(tenantSlug, filters, { includeLimit: false })}`, {
    credentials: "include"
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const fileNameMatch = contentDisposition.match(/filename=\"([^\"]+)\"/i);

  return {
    blob: await response.blob(),
    fileName: fileNameMatch?.[1] ?? "finance-export.csv"
  };
}
