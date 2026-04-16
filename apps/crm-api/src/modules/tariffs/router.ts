import { Router } from "express";
import { RentalTariffGroupKind } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { prisma } from "../../db/prisma.js";
import {
  createTariffGroup,
  listTariffsWorkspace,
  replaceTariffGroupBikeAssignments,
  updateTariffGroup
} from "./service.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const paramsSchema = z.object({
  groupId: z.string().uuid()
});

const rateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  durationDays: z.coerce.number().int().min(1).max(3650),
  amountKopecks: z.coerce.number().int().min(0),
  bonusDays: z.coerce.number().int().min(0).max(90).optional()
});

const groupBaseSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  kind: z.nativeEnum(RentalTariffGroupKind),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
  depositTargetKopecks: z.coerce.number().int().min(0),
  autoPenaltyEnabled: z.coerce.boolean(),
  autoPenaltyDailyKopecks: z.coerce.number().int().min(0),
  graceDays: z.coerce.number().int().min(0).max(365),
  rates: z.array(rateSchema).min(1).max(20)
});

const assignmentSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  bikeIds: z.array(z.string().uuid()).max(500).default([]),
  syncActiveDeals: z.coerce.boolean().default(true)
});

const updateSchema = groupBaseSchema.extend({
  syncActiveDeals: z.coerce.boolean().default(true)
});

export function createTariffsRouter() {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor } = await requireTenantPermission(req, query.tenantSlug, "tariffs.view");
    const branchId = resolveActorBranchReadScope(actor, "tariffs.view");
    res.status(200).json(await listTariffsWorkspace({
      ...query,
      branchId
    }));
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const body = groupBaseSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, body.tenantSlug, "tariffs.manage");
    const result = await createTariffGroup(body);
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "tariff_group",
        entityId: result.group.id,
        action: "created",
        newValueText: JSON.stringify({
          kind: result.group.kind,
          name: result.group.name
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });
    res.status(201).json(result);
  }));

  router.patch("/:groupId", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const body = updateSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, body.tenantSlug, "tariffs.manage");
    const result = await updateTariffGroup({
      ...body,
      groupId: params.groupId
    });
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "tariff_group",
        entityId: params.groupId,
        action: "updated",
        newValueText: JSON.stringify({
          kind: result.group.kind,
          name: result.group.name,
          syncActiveDeals: body.syncActiveDeals
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });
    res.status(200).json(result);
  }));

  router.post("/:groupId/bikes", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const body = assignmentSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, body.tenantSlug, "tariffs.manage");
    const result = await replaceTariffGroupBikeAssignments({
      ...body,
      groupId: params.groupId
    });
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "tariff_group",
        entityId: params.groupId,
        action: "bike_assignments_replaced",
        newValueText: JSON.stringify({
          bikeIds: body.bikeIds,
          assignedCount: result.assignedCount,
          syncActiveDeals: body.syncActiveDeals
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });
    res.status(200).json(result);
  }));

  return router;
}
