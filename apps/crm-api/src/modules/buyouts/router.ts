import { Router } from "express";
import { z } from "zod";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../core/http/errors.js";
import { createBuyoutManualPenalty, payBuyoutPenalty, postBuyoutPayment, updateBuyoutTerms } from "../finance/service.js";
import { createBuyoutDeal } from "../deals/create-service.js";
import { closeBuyoutDeal, setBuyoutProblemFlag } from "../deals/lifecycle-service.js";
import { buildGpsSnapshot } from "../gps/service.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  status: z.enum(["NEW", "ACTIVE", "OVERDUE", "HOLD", "CLOSED", "TERMINATED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

const detailQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const paramsSchema = z.object({
  buyoutId: z.string().trim().min(2).max(128)
});

const penaltyParamsSchema = z.object({
  buyoutId: z.string().trim().min(2).max(128),
  penaltyId: z.string().trim().min(2).max(128)
});

const paymentSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  amountKopecks: z.coerce.number().int().positive(),
  paymentMethod: z.enum(["BANK", "CASH"]),
  bankId: z.string().trim().min(2).max(128).optional(),
  happenedAt: z.string().trim().optional(),
  comment: z.string().trim().max(2000).optional()
});

const createSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  clientId: z.string().trim().min(2).max(128),
  bikeId: z.string().trim().min(2).max(128),
  paymentCadence: z.enum(["WEEKLY", "MONTHLY"]),
  equipment: z.array(z.object({
    catalogItemId: z.string().trim().min(2).max(128).optional(),
    type: z.enum(["BATTERY", "CHARGER", "HELMET", "CHAIN_LOCK", "OTHER"]).default("OTHER"),
    label: z.string().trim().min(1).max(160),
    quantity: z.coerce.number().int().min(1).max(20).default(1),
    comment: z.string().trim().max(1000).optional()
  })).max(20).optional(),
  startsAt: z.string().trim().optional(),
  bankId: z.string().trim().min(2).max(128).optional(),
  comment: z.string().trim().max(2000).optional()
});

const termsSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  depositTargetKopecks: z.coerce.number().int().min(0).optional(),
  autoPenaltyEnabled: z.coerce.boolean().optional(),
  autoPenaltyDailyKopecks: z.coerce.number().int().min(0).optional(),
  graceDays: z.coerce.number().int().min(0).optional(),
  reason: z.string().trim().max(2000).optional()
});

const manualPenaltySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  amountKopecks: z.coerce.number().int().positive(),
  reason: z.string().trim().min(2).max(240),
  happenedAt: z.string().trim().optional(),
  comment: z.string().trim().max(2000).optional()
});

const penaltyPaymentSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  paymentMethod: z.enum(["BANK", "CASH"]),
  bankId: z.string().trim().min(2).max(128).optional(),
  happenedAt: z.string().trim().optional(),
  comment: z.string().trim().max(2000).optional()
});

const closeSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  comment: z.string().trim().max(2000).optional()
});

const problemSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  isProblem: z.coerce.boolean(),
  comment: z.string().trim().max(2000).optional()
});

async function findBuyoutBranchId(tenantId: string, buyoutId: string) {
  const buyout = await prisma.buyout.findFirst({
    where: {
      id: buyoutId,
      tenantId
    },
    select: {
      branchId: true
    }
  });

  return buyout?.branchId;
}

export function createBuyoutsRouter() {
  const router = Router();

  router.post("/", asyncHandler(async (req, res) => {
    const payload = createSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.create");

    res.status(201).json(await createBuyoutDeal({
      ...payload,
      actor,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/:buyoutId/close", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = closeSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.change_status");
    const branchId = await findBuyoutBranchId(actor.tenantId, params.buyoutId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "buyouts.change_status", branchId);
    }

    res.status(200).json(await closeBuyoutDeal({
      ...payload,
      buyoutId: params.buyoutId,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/:buyoutId/problem", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = problemSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.change_status");
    const branchId = await findBuyoutBranchId(actor.tenantId, params.buyoutId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "buyouts.change_status", branchId);
    }

    res.status(200).json(await setBuyoutProblemFlag({
      ...payload,
      buyoutId: params.buyoutId,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "buyouts.view");
    const readBranchId = resolveActorBranchReadScope(actor, "buyouts.view");

    const search = query.q?.trim();
    const where = {
      tenantId: tenant.id,
      ...(readBranchId ? { branchId: readBranchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { dealNumber: { contains: search, mode: "insensitive" as const } },
              { client: { is: { fullName: { contains: search, mode: "insensitive" as const } } } },
              { bikeUnit: { is: { title: { contains: search, mode: "insensitive" as const } } } }
            ]
          }
        : {})
    };

    const rows = await prisma.buyout.findMany({
      where,
      orderBy: [
        { updatedAt: "desc" },
        { startsAt: "desc" }
      ],
      take: query.limit,
      select: {
        id: true,
        dealNumber: true,
        status: true,
        paymentCadence: true,
        startsAt: true,
        nextPaymentAt: true,
        totalPriceKopecks: true,
        residualDebtKopecks: true,
        overdueDays: true,
        legacyExternalId: true,
        client: {
          select: {
            fullName: true
          }
        },
        bikeUnit: {
          select: {
            title: true
          }
        },
        _count: {
          select: {
            penalties: true,
            deposits: true,
            notifications: true
          }
        },
        paymentSchedules: {
          take: 1,
          orderBy: {
            createdAt: "desc"
          },
          select: {
            cadence: true,
            intervalValue: true,
            cycleAmountKopecks: true,
            nextDueAt: true,
            items: {
              take: 4,
              orderBy: {
                sequenceNumber: "asc"
              },
              select: {
                sequenceNumber: true,
                dueAt: true,
                amountKopecks: true,
                paidKopecks: true,
                status: true
              }
            }
          }
        }
      }
    });

    const total = await prisma.buyout.count({ where });

    res.status(200).json({
      tenant,
      total,
      query: search ?? null,
      statusFilter: query.status ?? null,
      rows
    });
  }));

  router.get("/:buyoutId", asyncHandler(async (req, res) => {
    const query = detailQuerySchema.parse(req.query);
    const params = paramsSchema.parse(req.params);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "buyouts.view");
    const branchId = await findBuyoutBranchId(tenant.id, params.buyoutId);
    if (branchId === undefined) {
      throw new HttpError(404, `Buyout '${params.buyoutId}' was not found`);
    }

    assertActorBranchAccess(actor, "buyouts.view", branchId);

    const buyout = await prisma.buyout.findFirst({
      where: {
        id: params.buyoutId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        dealNumber: true,
        status: true,
        isProblem: true,
        termMonths: true,
        paymentCadence: true,
        totalPriceKopecks: true,
        downPaymentKopecks: true,
        financedAmountKopecks: true,
        residualDebtKopecks: true,
        overdueDays: true,
        depositTargetKopecks: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        graceDays: true,
        startsAt: true,
        nextPaymentAt: true,
        legacyExternalId: true,
        comment: true,
        createdAt: true,
        updatedAt: true,
        branch: {
          select: {
            id: true,
            name: true,
            code: true
          }
        },
        bank: {
          select: {
            id: true,
            name: true,
            phone: true,
            comment: true,
            instructionType: true,
            assets: {
              where: {
                type: "REQUISITES"
              },
              orderBy: [
                { isPrimary: "desc" },
                { createdAt: "asc" }
              ],
              take: 1,
              select: {
                title: true,
                textBody: true
              }
            }
          }
        },
        client: {
          select: {
            id: true,
            fullName: true,
            primaryPhone: true,
            telegramHandle: true,
            currentDebtKopecks: true,
            overdueDebtKopecks: true,
            activeDealsCount: true,
            paymentCount: true,
            overdueCount: true
          }
        },
        bikeUnit: {
          select: {
            id: true,
            title: true,
            internalCode: true,
            article: true,
            serialNumber: true,
            status: true,
            gpsTracker: {
              select: {
                id: true,
                externalDeviceId: true,
                deviceName: true,
                deviceAlias: true,
                status: true,
                lastSeenAt: true,
                lastOnlineAt: true,
                lastSyncAt: true,
                lastSyncError: true
              }
            },
            bikeModel: {
              select: {
                name: true,
                article: true
              }
            }
          }
        },
        equipmentItems: {
          orderBy: [
            { createdAt: "asc" },
            { label: "asc" }
          ],
          select: {
            id: true,
            type: true,
            label: true,
            quantity: true,
            comment: true
          }
        },
        deposits: {
          orderBy: {
            createdAt: "desc"
          },
          take: 5,
          select: {
            id: true,
            amountKopecks: true,
            refundedKopecks: true,
            status: true,
            comment: true,
            createdAt: true
          }
        },
        depositRefunds: {
          orderBy: {
            createdAt: "desc"
          },
          take: 8,
          select: {
            id: true,
            amountKopecks: true,
            comment: true,
            createdAt: true
          }
        },
        penalties: {
          orderBy: {
            accrualDate: "desc"
          },
          take: 8,
          select: {
            id: true,
            mode: true,
            status: true,
            amountKopecks: true,
            accrualDate: true,
            reason: true,
            comment: true
          }
        },
        notifications: {
          orderBy: {
            createdAt: "desc"
          },
          take: 8,
          select: {
            id: true,
            channel: true,
            status: true,
            recipient: true,
            createdAt: true,
            sentAt: true
          }
        },
        paymentSchedules: {
          orderBy: {
            createdAt: "desc"
          },
          select: {
            id: true,
            cadence: true,
            intervalValue: true,
            startsAt: true,
            nextDueAt: true,
            cycleAmountKopecks: true,
            items: {
              orderBy: {
                sequenceNumber: "asc"
              },
              select: {
                id: true,
                sequenceNumber: true,
                dueAt: true,
                amountKopecks: true,
                paidKopecks: true,
                status: true,
                closedAt: true
              }
            }
          }
        },
        _count: {
          select: {
            deposits: true,
            penalties: true,
            notifications: true,
            documents: true
          }
        }
      }
    });

    if (!buyout) {
      throw new HttpError(404, `Buyout '${params.buyoutId}' was not found`);
    }

    const notes = await prisma.note.findMany({
      where: {
        tenantId: tenant.id,
        targetEntityType: "buyout",
        targetEntityId: buyout.id
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 12,
      select: {
        id: true,
        text: true,
        colorHex: true,
        createdAt: true
      }
    });

    res.status(200).json({
      tenant,
      deal: {
        ...buyout,
        bank: buyout.bank ? {
          id: buyout.bank.id,
          name: buyout.bank.name,
          phone: buyout.bank.phone,
          comment: buyout.bank.comment,
          instructionType: buyout.bank.instructionType,
          requisitesTitle: buyout.bank.assets[0]?.title ?? null,
          requisitesText: buyout.bank.assets[0]?.textBody ?? null
        } : null,
        bikeUnit: {
          id: buyout.bikeUnit.id,
          title: buyout.bikeUnit.title,
          internalCode: buyout.bikeUnit.internalCode,
          article: buyout.bikeUnit.article,
          serialNumber: buyout.bikeUnit.serialNumber,
          status: buyout.bikeUnit.status,
          bikeModel: buyout.bikeUnit.bikeModel
        },
        equipment: buyout.equipmentItems,
        gps: buildGpsSnapshot(buyout.bikeUnit.gpsTracker),
        notes
      }
    });
  }));

  router.post("/:buyoutId/payments", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = paymentSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.post_payment");
    const branchId = await findBuyoutBranchId(actor.tenantId, params.buyoutId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "buyouts.post_payment", branchId);
    }
    const result = await postBuyoutPayment({
      buyoutId: params.buyoutId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.patch("/:buyoutId/terms", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = termsSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.edit_terms");
    const branchId = await findBuyoutBranchId(actor.tenantId, params.buyoutId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "buyouts.edit_terms", branchId);
    }
    const result = await updateBuyoutTerms({
      buyoutId: params.buyoutId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(200).json(result);
  }));

  router.post("/:buyoutId/penalties/manual", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = manualPenaltySchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.manual_penalty");
    const branchId = await findBuyoutBranchId(actor.tenantId, params.buyoutId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "buyouts.manual_penalty", branchId);
    }
    const result = await createBuyoutManualPenalty({
      buyoutId: params.buyoutId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/:buyoutId/penalties/:penaltyId/pay", asyncHandler(async (req, res) => {
    const params = penaltyParamsSchema.parse(req.params);
    const payload = penaltyPaymentSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "buyouts.pay_penalty");
    const branchId = await findBuyoutBranchId(actor.tenantId, params.buyoutId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "buyouts.pay_penalty", branchId);
    }
    const result = await payBuyoutPenalty({
      buyoutId: params.buyoutId,
      penaltyId: params.penaltyId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  return router;
}
