import type { Request } from "express";
import { HttpError } from "../http/errors.js";
import { actorHasPermission, getCurrentActor } from "./current-actor.js";
import { resolveTenantBySlug } from "../../modules/tenants/runtime.js";

export async function requireTenantPermission(
  req: Request,
  tenantSlug: string,
  required: string | string[]
) {
  const actor = getCurrentActor(req);
  if (!actor) {
    throw new HttpError(401, "Требуется авторизация");
  }

  const tenant = await resolveTenantBySlug(tenantSlug);
  if (actor.tenantId !== tenant.id && !actor.isSupportUser) {
    throw new HttpError(403, "Нет доступа к этому tenant", {
      actorTenantId: actor.tenantId,
      requiredTenantId: tenant.id
    });
  }

  if (!actorHasPermission(actor, required)) {
    throw new HttpError(403, "Недостаточно прав для выполнения действия", {
      required
    });
  }

  return {
    actor,
    tenant
  };
}
