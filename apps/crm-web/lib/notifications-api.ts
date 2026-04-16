import { getCrmApiBase } from "./crm-api-base";
import { getCurrentTenantSlugBrowser } from "./tenant";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export class NotificationsApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "NotificationsApiError";
    this.statusCode = statusCode;
  }
}

export interface NotificationsWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  connection: {
    kind: "TELEGRAM";
    status: "CONNECTED" | "DISCONNECTED" | "ERROR";
    connected: boolean;
    configured: boolean;
    label: string | null;
    apiId: string | null;
    baseUrl: string;
    lastCheckedAt: string | null;
    lastErrorText: string | null;
  };
  scenarios: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    rows: Array<{
      id: string;
      channel: "TELEGRAM";
      type: "DEAL_CREATED" | "PAYMENT_RECEIVED";
      name: string;
      isEnabled: boolean;
      templateText: string;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  journal: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    rows: Array<{
      id: string;
      createdAt: string;
      sentAt: string | null;
      status: "QUEUED" | "SENT" | "FAILED" | "SKIPPED";
      recipient: string;
      messageText: string;
      reason: string | null;
      scenario: {
        id: string;
        type: "DEAL_CREATED" | "PAYMENT_RECEIVED";
        name: string;
      } | null;
      client: {
        id: string;
        fullName: string;
      } | null;
      deal: {
        kind: "RENTAL" | "BUYOUT";
        id: string;
        dealNumber: string;
      } | null;
    }>;
  };
}

function getBrowserApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new NotificationsApiError(
      payload?.error?.message ?? `Request failed with ${response.status}`,
      response.status
    );
  }

  return payload as T;
}

type TelegramConnectionSnapshot = NotificationsWorkspaceData["connection"];

export interface StartTelegramQrConnectionResult {
  tenant: NotificationsWorkspaceData["tenant"];
  connected: boolean;
  qr: {
    flowId: string;
    tgUrl: string;
    expiresAt: string;
  } | null;
  connection: TelegramConnectionSnapshot;
}

export interface TelegramQrConnectionStatusResult {
  tenant: NotificationsWorkspaceData["tenant"];
  status: "pending" | "ok";
  qr: {
    expiresAt: string;
    tgUrl: string;
  } | null;
  connection: TelegramConnectionSnapshot;
}

export interface TelegramConnectionMutationResult {
  tenant: NotificationsWorkspaceData["tenant"];
  status: "ok";
  connection: TelegramConnectionSnapshot;
}

export async function loadNotificationsWorkspace(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const response = await fetch(`${apiBase}/notifications/workspace?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
      cache: "no-store",
      ...(cookieHeader
        ? {
            headers: {
              cookie: cookieHeader
            }
          }
        : {})
    });

    const data = await parseJsonResponse<NotificationsWorkspaceData>(response);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load notifications workspace"
    };
  }
}

export async function saveNotificationScenario(input: {
  scenarioId: string;
  isEnabled?: boolean;
  templateText?: string;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/notifications/scenarios/${encodeURIComponent(input.scenarioId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      ...(typeof input.isEnabled === "boolean" ? { isEnabled: input.isEnabled } : {}),
      ...(typeof input.templateText === "string" ? { templateText: input.templateText } : {})
    })
  });

  return parseJsonResponse<{
    tenant: NotificationsWorkspaceData["tenant"];
    scenario: NotificationsWorkspaceData["scenarios"]["rows"][number];
  }>(response);
}

export async function startTelegramQrConnection(input: {
  apiId?: string;
  apiHash?: string;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/notifications/telegram/qr/start`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      ...(typeof input.apiId === "string" ? { apiId: input.apiId } : {}),
      ...(typeof input.apiHash === "string" ? { apiHash: input.apiHash } : {})
    })
  });

  return parseJsonResponse<StartTelegramQrConnectionResult>(response);
}

export async function getTelegramQrConnectionStatus(flowId: string) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(
    `${getBrowserApiBase()}/notifications/telegram/qr/status?tenantSlug=${encodeURIComponent(tenantSlug)}&flowId=${encodeURIComponent(flowId)}`,
    {
      method: "GET",
      credentials: "include"
    }
  );

  return parseJsonResponse<TelegramQrConnectionStatusResult>(response);
}

export async function confirmTelegramQrConnectionPassword(input: {
  flowId: string;
  password: string;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/notifications/telegram/qr/password`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug,
      flowId: input.flowId,
      password: input.password
    })
  });

  return parseJsonResponse<TelegramConnectionMutationResult>(response);
}

export async function resetTelegramConnection() {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const response = await fetch(`${getBrowserApiBase()}/notifications/telegram/reset`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug
    })
  });

  return parseJsonResponse<TelegramConnectionMutationResult>(response);
}
