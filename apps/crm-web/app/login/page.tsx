import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "../../components/login-form";
import { fetchCurrentActorServer } from "../../lib/auth-api";
import { TENANT_COOKIE_NAME, normalizeTenantSlug } from "../../lib/tenant";

function pickFirst(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? undefined;
  }

  return value;
}

export default async function LoginPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined>;
}) {
  const cookieStore = await cookies();
  const actor = await fetchCurrentActorServer(cookieStore.toString());
  if (actor) {
    redirect("/");
  }

  const searchParams = await Promise.resolve(props.searchParams ?? {});
  const initialTenantSlug = normalizeTenantSlug(
    pickFirst(searchParams.tenantSlug),
  ) ?? normalizeTenantSlug(
    pickFirst(searchParams.tenant)
  ) ?? normalizeTenantSlug(
    cookieStore.get(TENANT_COOKIE_NAME)?.value
  ) ?? "";

  return <LoginForm initialTenantSlug={initialTenantSlug} />;
}
