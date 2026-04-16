"use client";

import { createContext, useContext, useEffect } from "react";
import type { PropsWithChildren } from "react";
import type { AuthActor } from "../lib/auth-api";
import { DEFAULT_TENANT_SLUG, rememberTenantSlugBrowser } from "../lib/tenant";

const AuthActorContext = createContext<AuthActor | null>(null);

export function AuthActorProvider(props: PropsWithChildren<{ actor: AuthActor }>) {
  useEffect(() => {
    rememberTenantSlugBrowser(props.actor.tenantSlug);
  }, [props.actor.tenantSlug]);

  return (
    <AuthActorContext.Provider value={props.actor}>
      {props.children}
    </AuthActorContext.Provider>
  );
}

export function useAuthActor() {
  return useContext(AuthActorContext);
}

export function useHasPermission(required: string | string[]) {
  const actor = useAuthActor();
  if (!actor) {
    return false;
  }

  if (actor.isTenantOwner || actor.isSupportUser) {
    return true;
  }

  const requiredCodes = Array.isArray(required) ? required : [required];
  return requiredCodes.every((code) => actor.permissionCodes.includes(code));
}

export function useTenantSlug() {
  return useAuthActor()?.tenantSlug ?? DEFAULT_TENANT_SLUG;
}
