import { Router } from "express";
import { z } from "zod";
import { getCurrentActor, loadCurrentActorByUserId } from "../../core/auth/current-actor.js";
import { hashPassword, verifyPassword } from "../../core/auth/password.js";
import { serializeActor } from "../../core/auth/request-context.js";
import { requireAuth } from "../../core/auth/require-auth.js";
import { clearSessionCookie, createSessionToken, setSessionCookie } from "../../core/auth/session.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";
import { assignSystemRoleToUser, ensurePermissionCatalog, ensureSystemRoles } from "../users/permissions.js";

const tenantQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const loginSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().trim().min(8).max(120)
});

const bootstrapSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  fullName: z.string().trim().min(2).max(160),
  password: z.string().trim().min(8).max(120)
});

async function buildAuthStatus(tenantSlug: string) {
  const tenant = await resolveTenantBySlug(tenantSlug);
  await ensurePermissionCatalog();
  await ensureSystemRoles(tenant.id);

  const usersCount = await prisma.user.count({
    where: {
      tenantId: tenant.id
    }
  });

  return {
    tenant,
    hasUsers: usersCount > 0,
    requiresBootstrap: usersCount === 0
  };
}

export function createAuthRouter() {
  const router = Router();

  router.get("/status", asyncHandler(async (req, res) => {
    const query = tenantQuerySchema.parse(req.query);
    const status = await buildAuthStatus(query.tenantSlug);
    const actor = getCurrentActor(req);

    res.status(200).json({
      ...status,
      authenticated: Boolean(actor && actor.tenantId === status.tenant.id),
      actor: actor && actor.tenantId === status.tenant.id ? serializeActor(actor) : null
    });
  }));

  router.post("/bootstrap", asyncHandler(async (req, res) => {
    const payload = bootstrapSchema.parse(req.body);
    const status = await buildAuthStatus(payload.tenantSlug);
    if (!status.requiresBootstrap) {
      throw new HttpError(409, "В этом tenant уже есть пользователи. Bootstrap больше недоступен.");
    }

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          tenantId: status.tenant.id,
          email: payload.email,
          fullName: payload.fullName,
          passwordHash: hashPassword(payload.password),
          status: "ACTIVE",
          isTenantOwner: true,
          lastLoginAt: new Date()
        },
        select: {
          id: true
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: status.tenant.id,
          userId: createdUser.id,
          entityType: "auth",
          entityId: createdUser.id,
          action: "tenant_owner_bootstrapped",
          newValueText: JSON.stringify({
            email: payload.email,
            fullName: payload.fullName
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });

      return createdUser;
    });

    await assignSystemRoleToUser({
      tenantId: status.tenant.id,
      userId: user.id
    });

    const actor = await loadCurrentActorByUserId(user.id, status.tenant.id);
    if (!actor) {
      throw new HttpError(500, "Не удалось загрузить профиль владельца после bootstrap");
    }

    setSessionCookie(res, createSessionToken({
      userId: actor.userId,
      tenantId: actor.tenantId,
      tenantSlug: actor.tenantSlug
    }));

    res.status(201).json({
      tenant: status.tenant,
      actor: serializeActor(actor)
    });
  }));

  router.post("/login", asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body);
    const tenant = await resolveTenantBySlug(payload.tenantSlug);

    const user = await prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        email: payload.email
      },
      select: {
        id: true,
        passwordHash: true,
        status: true
      }
    });

    if (!user || !verifyPassword(payload.password, user.passwordHash)) {
      throw new HttpError(401, "Неверный email или пароль");
    }

    if (user.status !== "ACTIVE") {
      throw new HttpError(403, "Пользователь не активирован");
    }

    await prisma.user.update({
      where: {
        id: user.id
      },
      data: {
        lastLoginAt: new Date()
      }
    });

    const actor = await loadCurrentActorByUserId(user.id, tenant.id);
    if (!actor) {
      throw new HttpError(500, "Не удалось загрузить профиль пользователя после входа");
    }

    setSessionCookie(res, createSessionToken({
      userId: actor.userId,
      tenantId: actor.tenantId,
      tenantSlug: actor.tenantSlug
    }));

    res.status(200).json({
      tenant,
      actor: serializeActor(actor)
    });
  }));

  router.post("/logout", asyncHandler(async (_req, res) => {
    clearSessionCookie(res);
    res.status(200).json({
      ok: true
    });
  }));

  router.get("/me", requireAuth, asyncHandler(async (req, res) => {
    const actor = getCurrentActor(req);
    res.status(200).json({
      actor: serializeActor(actor!)
    });
  }));

  return router;
}
