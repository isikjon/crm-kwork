export const DEFAULT_TENANT_SLUG = "prokolesa";
export const TENANT_COOKIE_NAME = "crm_tenant_slug";

export function normalizeTenantSlug(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function pickTenantSlug(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = normalizeTenantSlug(value);
    if (normalized) {
      return normalized;
    }
  }

  return DEFAULT_TENANT_SLUG;
}

export function readCookieValue(cookieHeader: string | undefined | null, cookieName: string) {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    if (part.slice(0, separatorIndex) === cookieName) {
      return decodeURIComponent(part.slice(separatorIndex + 1));
    }
  }

  return null;
}

function readBrowserCookie(name: string) {
  if (typeof document === "undefined") {
    return null;
  }

  const pattern = new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")}=([^;]*)`);
  const match = document.cookie.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

export function getBrowserTenantSlug() {
  return normalizeTenantSlug(readBrowserCookie(TENANT_COOKIE_NAME));
}

export function getCurrentTenantSlugBrowser() {
  return pickTenantSlug(getBrowserTenantSlug());
}

export function rememberTenantSlugBrowser(tenantSlug?: string | null) {
  if (typeof document === "undefined") {
    return;
  }

  const normalized = pickTenantSlug(tenantSlug);
  document.cookie = `${TENANT_COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; Max-Age=2592000; SameSite=Lax`;
}

export function withTenantSlug(path: string, tenantSlug: string) {
  const resolvedTenantSlug = pickTenantSlug(tenantSlug);
  const url = new URL(path, "http://crm.local");
  url.searchParams.set("tenantSlug", resolvedTenantSlug);
  return `${url.pathname}${url.search}`;
}
