import { getCrmApiBase } from "./crm-api-base";
import { DEFAULT_TENANT_SLUG, rememberTenantSlugBrowser } from "./tenant";

export interface AuthActor {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  branchId: string | null;
  email: string;
  fullName: string;
  isTenantOwner: boolean;
  isSupportUser: boolean;
  roleNames: string[];
  permissionCodes: string[];
}

export interface AuthStatusData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  hasUsers: boolean;
  requiresBootstrap: boolean;
  authenticated: boolean;
  actor: AuthActor | null;
}

function getBrowserApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}

export async function fetchCurrentActorServer(cookieHeader: string) {
  if (!cookieHeader) {
    return null;
  }

  const response = await fetch(`${getCrmApiBase()}/auth/me`, {
    cache: "no-store",
    headers: {
      cookie: cookieHeader
    }
  });

  if (response.status === 401) {
    return null;
  }

  const payload = await parseJsonResponse<{ actor: AuthActor }>(response);
  return payload.actor;
}

export async function fetchAuthStatus(tenantSlug = DEFAULT_TENANT_SLUG) {
  const response = await fetch(`${getBrowserApiBase()}/auth/status?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
    cache: "no-store",
    credentials: "include"
  });

  return parseJsonResponse<AuthStatusData>(response);
}

export async function loginWithPassword(input: {
  tenantSlug?: string;
  email: string;
  password: string;
}) {
  const response = await fetch(`${getBrowserApiBase()}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug: input.tenantSlug ?? DEFAULT_TENANT_SLUG,
      email: input.email,
      password: input.password
    })
  });

  const payload = await parseJsonResponse<{ actor: AuthActor }>(response);
  rememberTenantSlugBrowser(payload.actor.tenantSlug ?? input.tenantSlug ?? DEFAULT_TENANT_SLUG);
  return payload;
}

export async function bootstrapTenantOwner(input: {
  tenantSlug?: string;
  fullName: string;
  email: string;
  password: string;
}) {
  const response = await fetch(`${getBrowserApiBase()}/auth/bootstrap`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tenantSlug: input.tenantSlug ?? DEFAULT_TENANT_SLUG,
      fullName: input.fullName,
      email: input.email,
      password: input.password
    })
  });

  const payload = await parseJsonResponse<{ actor: AuthActor }>(response);
  rememberTenantSlugBrowser(payload.actor.tenantSlug ?? input.tenantSlug ?? DEFAULT_TENANT_SLUG);
  return payload;
}

export async function logoutSession() {
  const response = await fetch(`${getBrowserApiBase()}/auth/logout`, {
    method: "POST",
    credentials: "include"
  });

  return parseJsonResponse<{ ok: boolean }>(response);
}
