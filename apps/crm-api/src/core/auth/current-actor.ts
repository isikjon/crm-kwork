import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../http/errors.js";
import { ensurePermissionCatalog, ensureSystemRoles } from "../../modules/users/permissions.js";
import { clearSessionCookie, readSessionTokenFromRequest, verifySessionToken } from "./session.js";
import type { CurrentActor } from "./request-context.js";

function buildCurrentActor(input: {
  id: string;
  branchId: string | null;
  email: string;
  fullName: string;
  isTenantOwner: boolean;
  isSupportUser: boolean;
  tenant: {
    id: string;
    slug: string;
  };
  userRoles: Array<{
    role: {
      name: string;
      permissions: Array<{
        branchScoped: boolean;
        permission: {
          code: string;
        };
      }>;
    };
  }>;
}): CurrentActor {
  const permissionGrantMap = new Map<string, boolean>();
  const roleNames = new Set<string>();

  function grantPermission(code: string, branchScoped: boolean) {
    const existing = permissionGrantMap.get(code);
    if (existing === false || branchScoped === false) {
      permissionGrantMap.set(code, false);
      return;
    }

    permissionGrantMap.set(code, true);
  }

  for (const assignment of input.userRoles) {
    roleNames.add(assignment.role.name);
    for (const permission of assignment.role.permissions) {
      grantPermission(permission.permission.code, permission.branchScoped);
    }
  }

  function grantViewFromWrite(viewCode: string, sourceCodes: string[]) {
    const sourceGrants = sourceCodes
      .map((code) => permissionGrantMap.get(code))
      .filter((value): value is boolean => typeof value === "boolean");

    if (sourceGrants.length === 0) {
      return;
    }

    const branchScoped = sourceGrants.every((value) => value === true);
    grantPermission(viewCode, branchScoped);
  }

  grantViewFromWrite("clients.view", ["clients.edit"]);
  grantViewFromWrite("clients.identity.view", ["clients.identity.edit"]);
  grantViewFromWrite("documents.view", ["documents.generate", "documents.manage_templates"]);
  grantViewFromWrite("repairs.view", ["repairs.edit"]);
  grantViewFromWrite("banks.view", ["banks.edit", "banks.manage"]);
  grantViewFromWrite("notifications.view", ["notifications.edit"]);
  grantViewFromWrite("finance.view", [
    "finance.manage_articles",
    "finance.post_manual_income",
    "finance.post_manual_expense",
    "finance.reverse_manual",
    "finance.reverse_penalty",
    "finance.reconcile",
    "finance.post",
    "finance.refund",
    "finance.export"
  ]);
  grantViewFromWrite("gps.view", ["gps.manage_settings", "gps.manage_binding"]);
  grantViewFromWrite("imports.view", ["imports.run"]);
  grantViewFromWrite("tariffs.view", ["tariffs.manage"]);
  grantViewFromWrite("equipment.view", ["equipment.manage"]);
  grantViewFromWrite("rentals.view", [
    "rentals.create",
    "rentals.post_payment",
    "rentals.manage_deposit",
    "rentals.receive_deposit",
    "rentals.refund_deposit",
    "rentals.manage_penalty",
    "rentals.manual_penalty",
    "rentals.pay_penalty",
    "rentals.edit_terms",
    "rentals.change_status"
  ]);
  grantViewFromWrite("buyouts.view", [
    "buyouts.create",
    "buyouts.post_payment",
    "buyouts.manual_penalty",
    "buyouts.pay_penalty",
    "buyouts.edit",
    "buyouts.edit_terms",
    "buyouts.change_status"
  ]);
  grantViewFromWrite("fleet.view", ["fleet.edit"]);
  grantViewFromWrite("users.view", ["users.manage_users", "users.assign_roles", "users.manage_roles"]);

  if (permissionGrantMap.has("orders.edit")) {
    grantPermission("orders.view", permissionGrantMap.get("orders.edit") ?? false);
  } else if (permissionGrantMap.has("rentals.view") && permissionGrantMap.has("buyouts.view")) {
    const branchScoped =
      (permissionGrantMap.get("rentals.view") ?? true)
      && (permissionGrantMap.get("buyouts.view") ?? true);
    grantPermission("orders.view", branchScoped);
  }

  const permissionGrants = Array.from(permissionGrantMap.entries())
    .map(([code, branchScoped]) => ({
      code,
      branchScoped
    }))
    .sort((left, right) => left.code.localeCompare(right.code, "ru"));

  return {
    userId: input.id,
    tenantId: input.tenant.id,
    tenantSlug: input.tenant.slug,
    branchId: input.branchId,
    email: input.email,
    fullName: input.fullName,
    isTenantOwner: input.isTenantOwner,
    isSupportUser: input.isSupportUser,
    roleNames: Array.from(roleNames).sort(),
    permissionCodes: permissionGrants.map((permission) => permission.code),
    permissionGrants
  };
}

export async function loadCurrentActorByUserId(userId: string, tenantId?: string) {
  await ensurePermissionCatalog();
  if (tenantId) {
    await ensureSystemRoles(tenantId);
  }

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      ...(tenantId ? { tenantId } : {}),
      status: "ACTIVE"
    },
    select: {
      id: true,
      branchId: true,
      email: true,
      fullName: true,
      isTenantOwner: true,
      isSupportUser: true,
      tenant: {
        select: {
          id: true,
          slug: true
        }
      },
      userRoles: {
        select: {
          role: {
            select: {
              name: true,
              permissions: {
                select: {
                  branchScoped: true,
                  permission: {
                    select: {
                      code: true
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  if (!user) {
    return null;
  }

  if (!tenantId) {
    await ensureSystemRoles(user.tenant.id);
  }

  return buildCurrentActor(user);
}

export function getCurrentActor(req: Request) {
  return req.currentActor ?? null;
}

export function actorHasPermission(actor: CurrentActor | null | undefined, required: string | string[]) {
  if (!actor) {
    return false;
  }

  if (actor.isTenantOwner || actor.isSupportUser) {
    return true;
  }

  const requiredCodes = Array.isArray(required) ? required : [required];
  return requiredCodes.every((code) => actor.permissionCodes.includes(code));
}

export function actorRequiresBranchScope(actor: CurrentActor | null | undefined, required: string | string[]) {
  if (!actor || actor.isTenantOwner || actor.isSupportUser) {
    return false;
  }

  const requiredCodes = Array.isArray(required) ? required : [required];
  return requiredCodes.some((code) => actor.permissionGrants.find((permission) => permission.code === code)?.branchScoped === true);
}

export function assertActorBranchAccess(
  actor: CurrentActor | null | undefined,
  required: string | string[],
  targetBranchId: string | null | undefined
) {
  if (!actor || !actorRequiresBranchScope(actor, required)) {
    return;
  }

  if (!actor.branchId) {
    throw new HttpError(403, "Для branch-scoped действия у пользователя не задана рабочая точка.");
  }

  if (!targetBranchId) {
    throw new HttpError(403, "Для branch-scoped действия объект должен принадлежать точке пользователя.");
  }

  if (actor.branchId !== targetBranchId) {
    throw new HttpError(403, "Нет доступа к объекту другой точки.", {
      actorBranchId: actor.branchId,
      targetBranchId
    });
  }
}

export function createCurrentActorMiddleware() {
  return async function currentActorMiddleware(req: Request, res: Response, next: NextFunction) {
    const token = readSessionTokenFromRequest(req);
    if (!token) {
      req.currentActor = null;
      next();
      return;
    }

    const payload = verifySessionToken(token);
    if (!payload) {
      req.currentActor = null;
      clearSessionCookie(res);
      next();
      return;
    }

    try {
      const actor = await loadCurrentActorByUserId(payload.sub, payload.tenantId);
      if (!actor) {
        req.currentActor = null;
        clearSessionCookie(res);
        next();
        return;
      }

      req.currentActor = actor;
      next();
    } catch (error) {
      next(error);
    }
  };
}
