export interface PermissionGrantSummary {
  code: string;
  branchScoped: boolean;
}

export interface CurrentActor {
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
  permissionGrants: PermissionGrantSummary[];
}

export interface ActorSummary {
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

declare module "express-serve-static-core" {
  interface Request {
    currentActor?: CurrentActor | null;
  }
}

export function serializeActor(actor: CurrentActor): ActorSummary {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    tenantSlug: actor.tenantSlug,
    branchId: actor.branchId,
    email: actor.email,
    fullName: actor.fullName,
    isTenantOwner: actor.isTenantOwner,
    isSupportUser: actor.isSupportUser,
    roleNames: actor.roleNames,
    permissionCodes: actor.permissionCodes
  };
}
