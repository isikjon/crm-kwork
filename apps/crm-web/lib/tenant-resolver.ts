import { fetchCurrentActorServer } from "./auth-api";
import { DEFAULT_TENANT_SLUG, TENANT_COOKIE_NAME, pickTenantSlug, readCookieValue } from "./tenant";

export async function resolveTenantSlugFromCookieHeader(options?: {
  cookieHeader?: string;
  fallback?: string | null;
}) {
  const cookieHeader = options?.cookieHeader ?? "";
  const actor = cookieHeader
    ? await fetchCurrentActorServer(cookieHeader).catch(() => null)
    : null;

  return pickTenantSlug(
    actor?.tenantSlug,
    readCookieValue(cookieHeader, TENANT_COOKIE_NAME),
    options?.fallback,
    DEFAULT_TENANT_SLUG
  );
}
