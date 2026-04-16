import { UserStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { actorRequiresBranchScope, assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { hashPassword } from "../../core/auth/password.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { SYSTEM_SUPER_ADMIN_ROLE_NAME, ensurePermissionCatalog, ensureSystemRoles, loadPermissionsByCodes } from "./permissions.js";

const tenantQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const roleParamsSchema = z.object({
  roleId: z.string().trim().min(2).max(128)
});

const userParamsSchema = z.object({
  userId: z.string().trim().min(2).max(128)
});

const userRoleParamsSchema = z.object({
  userId: z.string().trim().min(2).max(128),
  roleId: z.string().trim().min(2).max(128)
});

const rolePermissionSchema = z.object({
  code: z.string().trim().min(2).max(120),
  branchScoped: z.coerce.boolean().default(false)
});

const createRoleSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  permissions: z.array(rolePermissionSchema).default([])
});

const createUserSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().trim().min(8).max(120),
  branchId: z.string().trim().min(2).max(128).optional(),
  status: z.nativeEnum(UserStatus).default(UserStatus.ACTIVE)
});

const assignRoleSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  roleId: z.string().trim().min(2).max(128)
});

async function ensureBranchExists(tenantId: string, branchId: string | null | undefined) {
  if (!branchId) {
    return null;
  }

  const branch = await prisma.branch.findFirst({
    where: {
      id: branchId,
      tenantId,
      isActive: true
    },
    select: {
      id: true,
      name: true
    }
  });

  if (!branch) {
    throw new HttpError(404, "Точка не найдена.");
  }

  return branch;
}

async function listGroupedPermissions() {
  const permissions = await prisma.permission.findMany({
    orderBy: [
      { category: "asc" },
      { code: "asc" }
    ],
    select: {
      id: true,
      code: true,
      category: true,
      name: true,
      description: true
    }
  });

  return {
    total: permissions.length,
    rows: Array.from(new Set(permissions.map((permission) => permission.category))).map((category) => ({
      category,
      permissions: permissions.filter((permission) => permission.category === category)
    }))
  };
}

async function listRoles(tenantId: string) {
  const rows = await prisma.role.findMany({
    where: {
      tenantId
    },
    orderBy: [
      { isSystem: "desc" },
      { updatedAt: "desc" }
    ],
    select: {
      id: true,
      name: true,
      description: true,
      isSystem: true,
      createdAt: true,
      updatedAt: true,
      permissions: {
        orderBy: {
          createdAt: "asc"
        },
        select: {
          id: true,
          branchScoped: true,
          permission: {
            select: {
              code: true,
              category: true,
              name: true
            }
          }
        }
      },
      users: {
        select: {
          id: true
        }
      }
    }
  });

  return {
    total: rows.length,
    rows: rows.map((row) => ({
      ...row,
      usersCount: row.users.length
    }))
  };
}

async function listUsers(params: {
  tenantId: string;
  branchId: string | null;
  branchScoped: boolean;
}) {
  const rows = await prisma.user.findMany({
    where: {
      tenantId: params.tenantId,
      ...(params.branchScoped ? { branchId: params.branchId } : {})
    },
    orderBy: [
      { isTenantOwner: "desc" },
      { fullName: "asc" }
    ],
    select: {
      id: true,
      fullName: true,
      email: true,
      status: true,
      isTenantOwner: true,
      isSupportUser: true,
      lastLoginAt: true,
      branch: {
        select: {
          id: true,
          name: true,
          code: true
        }
      },
      userRoles: {
        orderBy: {
          createdAt: "asc"
        },
        select: {
          role: {
            select: {
              id: true,
              name: true,
              isSystem: true
            }
          }
        }
      }
    }
  });

  return {
    total: rows.length,
    rows: rows.map((row) => ({
      ...row,
      roles: row.userRoles.map((assignment) => assignment.role)
    }))
  };
}

function actorCanManageSystemRoles(actor: {
  isTenantOwner: boolean;
  isSupportUser: boolean;
}) {
  return actor.isTenantOwner || actor.isSupportUser;
}

export function createUsersRouter() {
  const router = Router();

  router.get("/workspace", asyncHandler(async (req, res) => {
    const query = tenantQuerySchema.parse(req.query);
    await ensurePermissionCatalog();
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "users.view");
    await ensureSystemRoles(tenant.id);

    const userListBranchScoped = actorRequiresBranchScope(actor, "users.view");

    const [permissions, roles, users, branches] = await Promise.all([
      listGroupedPermissions(),
      listRoles(tenant.id),
      listUsers({
        tenantId: tenant.id,
        branchId: actor.branchId,
        branchScoped: userListBranchScoped
      }),
      prisma.branch.findMany({
        where: {
          tenantId: tenant.id,
          isActive: true
        },
        orderBy: [
          { name: "asc" }
        ],
        select: {
          id: true,
          name: true,
          code: true
        }
      })
    ]);

    res.status(200).json({
      tenant,
      permissions: {
        tenant,
        ...permissions
      },
      roles: {
        tenant,
        ...roles
      },
      users: {
        tenant,
        ...users,
        branchScoped: userListBranchScoped
      },
      branches
    });
  }));

  router.get("/permissions", asyncHandler(async (req, res) => {
    const query = tenantQuerySchema.parse(req.query);
    await ensurePermissionCatalog();
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "users.view");

    const permissions = await listGroupedPermissions();
    res.status(200).json({
      tenant,
      ...permissions
    });
  }));

  router.get("/roles", asyncHandler(async (req, res) => {
    const query = tenantQuerySchema.parse(req.query);
    await ensurePermissionCatalog();
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "users.view");
    await ensureSystemRoles(tenant.id);

    const roles = await listRoles(tenant.id);
    res.status(200).json({
      tenant,
      ...roles
    });
  }));

  router.post("/roles", asyncHandler(async (req, res) => {
    const payload = createRoleSchema.parse(req.body);
    await ensurePermissionCatalog();
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "users.manage_roles");

    if (payload.name.trim() === SYSTEM_SUPER_ADMIN_ROLE_NAME) {
      throw new HttpError(409, "Имя системной роли зарезервировано.");
    }

    const codes = Array.from(new Set(payload.permissions.map((permission) => permission.code)));
    const permissions = await loadPermissionsByCodes(codes);
    if (permissions.length !== codes.length) {
      const foundCodes = new Set(permissions.map((permission) => permission.code));
      const missing = codes.filter((code) => !foundCodes.has(code));
      throw new HttpError(422, `Unknown permission codes: ${missing.join(", ")}`);
    }

    const role = await prisma.$transaction(async (tx) => {
      const createdRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: payload.name,
          description: payload.description?.trim() || null
        },
        select: {
          id: true,
          name: true,
          description: true,
          isSystem: true
        }
      });

      for (const permission of permissions) {
        const branchScoped = payload.permissions.find((item) => item.code === permission.code)?.branchScoped ?? false;
        await tx.rolePermission.create({
          data: {
            roleId: createdRole.id,
            permissionId: permission.id,
            branchScoped
          }
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "role",
          entityId: createdRole.id,
          action: "role_created",
          newValueText: JSON.stringify({
            name: payload.name,
            permissions: payload.permissions
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });

      return createdRole;
    });

    res.status(201).json({
      tenant,
      role
    });
  }));

  router.patch("/roles/:roleId", asyncHandler(async (req, res) => {
    const params = roleParamsSchema.parse(req.params);
    const payload = createRoleSchema.parse(req.body);
    await ensurePermissionCatalog();
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "users.manage_roles");

    const existingRole = await prisma.role.findFirst({
      where: {
        id: params.roleId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        description: true,
        isSystem: true
      }
    });

    if (!existingRole) {
      throw new HttpError(404, `Role '${params.roleId}' was not found`);
    }

    if (existingRole.isSystem) {
      throw new HttpError(403, "Системные роли нельзя редактировать вручную.");
    }

    const codes = Array.from(new Set(payload.permissions.map((permission) => permission.code)));
    const permissions = await loadPermissionsByCodes(codes);
    if (permissions.length !== codes.length) {
      const foundCodes = new Set(permissions.map((permission) => permission.code));
      const missing = codes.filter((code) => !foundCodes.has(code));
      throw new HttpError(422, `Unknown permission codes: ${missing.join(", ")}`);
    }

    const desiredPermissionIds = new Set(permissions.map((permission) => permission.id));

    await prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id: existingRole.id },
        data: {
          name: payload.name,
          description: payload.description?.trim() || null
        }
      });

      await tx.rolePermission.deleteMany({
        where: {
          roleId: existingRole.id,
          permissionId: {
            notIn: Array.from(desiredPermissionIds)
          }
        }
      });

      for (const permission of permissions) {
        const branchScoped = payload.permissions.find((item) => item.code === permission.code)?.branchScoped ?? false;
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: existingRole.id,
              permissionId: permission.id
            }
          },
          create: {
            roleId: existingRole.id,
            permissionId: permission.id,
            branchScoped
          },
          update: {
            branchScoped
          }
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "role",
          entityId: existingRole.id,
          action: "role_updated",
          oldValueText: JSON.stringify(existingRole, null, 2),
          newValueText: JSON.stringify({
            name: payload.name,
            description: payload.description?.trim() || null,
            permissions: payload.permissions
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });
    });

    res.status(200).json({
      tenant,
      role: {
        id: existingRole.id,
        name: payload.name,
        description: payload.description?.trim() || null
      }
    });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const payload = createUserSchema.parse(req.body);
    await ensurePermissionCatalog();
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "users.manage_users");
    const branch = await ensureBranchExists(tenant.id, payload.branchId?.trim() || null);

    assertActorBranchAccess(actor, "users.manage_users", branch?.id ?? null);

    const existingUser = await prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        email: payload.email
      },
      select: {
        id: true
      }
    });

    if (existingUser) {
      throw new HttpError(409, "Пользователь с таким email уже существует.");
    }

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          branchId: branch?.id ?? null,
          email: payload.email,
          fullName: payload.fullName,
          passwordHash: hashPassword(payload.password),
          status: payload.status
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          status: true,
          branch: {
            select: {
              id: true,
              name: true,
              code: true
            }
          }
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "user",
          entityId: createdUser.id,
          action: "user_created",
          newValueText: JSON.stringify({
            fullName: createdUser.fullName,
            email: createdUser.email,
            status: createdUser.status,
            branchId: createdUser.branch?.id ?? null
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });

      return createdUser;
    });

    res.status(201).json({
      tenant,
      user
    });
  }));

  router.post("/:userId/roles", asyncHandler(async (req, res) => {
    const params = userParamsSchema.parse(req.params);
    const payload = assignRoleSchema.parse(req.body);
    await ensurePermissionCatalog();
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "users.assign_roles");

    const [user, role] = await Promise.all([
      prisma.user.findFirst({
        where: {
          id: params.userId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          fullName: true,
          branchId: true,
          isTenantOwner: true
        }
      }),
      prisma.role.findFirst({
        where: {
          id: payload.roleId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          name: true,
          isSystem: true
        }
      })
    ]);

    if (!user) {
      throw new HttpError(404, "Пользователь не найден.");
    }

    if (!role) {
      throw new HttpError(404, "Роль не найдена.");
    }

    if (role.isSystem && !actorCanManageSystemRoles(actor)) {
      throw new HttpError(403, "Системные роли может назначать только владелец tenant или support.");
    }

    assertActorBranchAccess(actor, "users.assign_roles", user.branchId);

    await prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: {
          userId_roleId: {
            userId: user.id,
            roleId: role.id
          }
        },
        create: {
          userId: user.id,
          roleId: role.id
        },
        update: {}
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "user_role",
          entityId: `${user.id}:${role.id}`,
          action: "role_assigned",
          newValueText: JSON.stringify({
            userId: user.id,
            userName: user.fullName,
            roleId: role.id,
            roleName: role.name
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });
    });

    res.status(201).json({
      tenant,
      assignment: {
        userId: user.id,
        roleId: role.id
      }
    });
  }));

  router.delete("/:userId/roles/:roleId", asyncHandler(async (req, res) => {
    const params = userRoleParamsSchema.parse(req.params);
    const query = tenantQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "users.assign_roles");

    const [user, role] = await Promise.all([
      prisma.user.findFirst({
        where: {
          id: params.userId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          fullName: true,
          branchId: true,
          isTenantOwner: true
        }
      }),
      prisma.role.findFirst({
        where: {
          id: params.roleId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          name: true,
          isSystem: true
        }
      })
    ]);

    if (!user) {
      throw new HttpError(404, "Пользователь не найден.");
    }

    if (!role) {
      throw new HttpError(404, "Роль не найдена.");
    }

    if (role.isSystem && !actorCanManageSystemRoles(actor)) {
      throw new HttpError(403, "Системные роли может снимать только владелец tenant или support.");
    }

    if (role.name === SYSTEM_SUPER_ADMIN_ROLE_NAME) {
      if (user.isTenantOwner) {
        throw new HttpError(409, "Нельзя снять системную роль с владельца tenant.");
      }

      if (user.id === actor.userId) {
        throw new HttpError(409, "Нельзя снять у себя роль Супер-админ.");
      }

      const superAdminAssignments = await prisma.userRole.count({
        where: {
          roleId: role.id
        }
      });

      if (superAdminAssignments <= 1) {
        throw new HttpError(409, "Нельзя снять последнюю роль Супер-админ в tenant.");
      }
    }

    assertActorBranchAccess(actor, "users.assign_roles", user.branchId);

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({
        where: {
          userId: user.id,
          roleId: role.id
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "user_role",
          entityId: `${user.id}:${role.id}`,
          action: "role_unassigned",
          oldValueText: JSON.stringify({
            userId: user.id,
            userName: user.fullName,
            roleId: role.id,
            roleName: role.name
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });
    });

    res.status(200).json({
      tenant,
      removed: {
        userId: user.id,
        roleId: role.id
      }
    });
  }));

  return router;
}
