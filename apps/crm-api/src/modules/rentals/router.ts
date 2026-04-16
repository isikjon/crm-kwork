import { Router } from "express";
import { z } from "zod";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../core/http/errors.js";
import { createRentalDeal } from "../deals/create-service.js";
import { ensureRentalTariffSnapshots } from "../deals/rental-tariff-snapshot-service.js";
import {
  createRentalManualPenalty,
  payRentalPenalty,
  postRentalPayment,
  receiveRentalDeposit,
  refundRentalDeposit,
  runRentalAutoPenaltyAccrual,
  updateRentalTerms
} from "../finance/service.js";
import { completeRentalReturn, extendRentalDeal, setRentalProblemFlag } from "../deals/lifecycle-service.js";
import { buildGpsSnapshot } from "../gps/service.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  status: z.enum(["NEW", "ACTIVE", "OVERDUE", "HOLD", "RETURN_PREP", "COMPLETED", "CANCELED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

const detailQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const paramsSchema = z.object({
  rentalId: z.string().trim().min(2).max(128)
});

const penaltyParamsSchema = z.object({
  rentalId: z.string().trim().min(2).max(128),
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
  durationDays: z.coerce.number().int().positive(),
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

const autoPenaltySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
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

const extendSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  durationDays: z.coerce.number().int().positive(),
  comment: z.string().trim().max(2000).optional()
});

const problemSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  isProblem: z.coerce.boolean(),
  comment: z.string().trim().max(2000).optional()
});

async function findRentalBranchId(tenantId: string, rentalId: string) {
  const rental = await prisma.rental.findFirst({
    where: {
      id: rentalId,
      tenantId
    },
    select: {
      branchId: true
    }
  });

  return rental?.branchId;
}

async function listRentalAvailableBanks(params: {
  tenantId: string;
  branchId?: string | null;
}) {
  return prisma.bank.findMany({
    where: {
      tenantId: params.tenantId,
      isActive: true,
      ...(params.branchId
        ? {
            OR: [
              { branchId: params.branchId },
              { branchId: null }
            ]
          }
        : {})
    },
    orderBy: [
      { updatedAt: "desc" },
      { name: "asc" }
    ],
    select: {
      id: true,
      name: true,
      instructionType: true
    }
  });
}

export function createRentalsRouter() {
  const router = Router();

  router.post("/", asyncHandler(async (req, res) => {
    const payload = createSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.create");

    res.status(201).json(await createRentalDeal({
      ...payload,
      actor,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/:rentalId/return", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = closeSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.change_status");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.change_status", branchId);
    }

    res.status(200).json(await completeRentalReturn({
      ...payload,
      rentalId: params.rentalId,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/:rentalId/extend", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = extendSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.change_status");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.change_status", branchId);
    }

    res.status(200).json(await extendRentalDeal({
      ...payload,
      rentalId: params.rentalId,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/:rentalId/problem", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = problemSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.change_status");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.change_status", branchId);
    }

    res.status(200).json(await setRentalProblemFlag({
      ...payload,
      rentalId: params.rentalId,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "rentals.view");
    const readBranchId = resolveActorBranchReadScope(actor, "rentals.view");

    const search = query.q?.trim();
    const where = {
      tenantId: tenant.id,
      ...(readBranchId ? { branchId: readBranchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { dealNumber: { contains: search, mode: "insensitive" as const } },
              { tariffLabel: { contains: search, mode: "insensitive" as const } },
              { client: { is: { fullName: { contains: search, mode: "insensitive" as const } } } },
              { bikeUnit: { is: { title: { contains: search, mode: "insensitive" as const } } } }
            ]
          }
        : {})
    };

    const rows = await prisma.rental.findMany({
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
        tariffLabel: true,
        startsAt: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        debtKopecks: true,
        overdueDays: true,
        depositTargetKopecks: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
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
              take: 3,
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

    const total = await prisma.rental.count({ where });

    res.status(200).json({
      tenant,
      total,
      query: search ?? null,
      statusFilter: query.status ?? null,
      rows
    });
  }));

  router.get("/:rentalId", asyncHandler(async (req, res) => {
    const query = detailQuerySchema.parse(req.query);
    const params = paramsSchema.parse(req.params);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "rentals.view");
    const branchId = await findRentalBranchId(tenant.id, params.rentalId);
    if (branchId === undefined) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    assertActorBranchAccess(actor, "rentals.view", branchId);

    await prisma.$transaction(async (tx) => {
      await ensureRentalTariffSnapshots(tx, {
        tenantId: tenant.id,
        rentalId: params.rentalId
      });
    });

    const rental = await prisma.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        dealNumber: true,
        status: true,
        isProblem: true,
        tariffCode: true,
        tariffLabel: true,
        startsAt: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        debtKopecks: true,
        overdueDays: true,
        depositTargetKopecks: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        graceDays: true,
        legacyExternalId: true,
        comment: true,
        createdAt: true,
        updatedAt: true,
        tariffSnapshots: {
          orderBy: {
            durationDays: "asc"
          },
          select: {
            id: true,
            tariffCode: true,
            label: true,
            durationDays: true,
            amountKopecks: true
          }
        },
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
            rentalTariffGroup: {
              select: {
                id: true,
                code: true,
                name: true,
                rates: {
                  orderBy: {
                    durationDays: "asc"
                  },
                  select: {
                    id: true,
                    label: true,
                    durationDays: true,
                    amountKopecks: true
                  }
                }
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

    if (!rental) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    const notes = await prisma.note.findMany({
      where: {
        tenantId: tenant.id,
        targetEntityType: "rental",
        targetEntityId: rental.id
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

    const availableBanks = await listRentalAvailableBanks({
      tenantId: tenant.id,
      branchId
    });

    res.status(200).json({
      tenant,
      deal: {
        ...rental,
        bank: rental.bank ? {
          id: rental.bank.id,
          name: rental.bank.name,
          phone: rental.bank.phone,
          comment: rental.bank.comment,
          instructionType: rental.bank.instructionType,
          requisitesTitle: rental.bank.assets[0]?.title ?? null,
          requisitesText: rental.bank.assets[0]?.textBody ?? null
        } : null,
        availableBanks,
        bikeUnit: {
          id: rental.bikeUnit.id,
          title: rental.bikeUnit.title,
          internalCode: rental.bikeUnit.internalCode,
          article: rental.bikeUnit.article,
          serialNumber: rental.bikeUnit.serialNumber,
          status: rental.bikeUnit.status,
          rentalTariffGroup: rental.bikeUnit.rentalTariffGroup,
          bikeModel: rental.bikeUnit.bikeModel
        },
        equipment: rental.equipmentItems,
        gps: buildGpsSnapshot(rental.bikeUnit.gpsTracker),
        notes
      }
    });
  }));

  router.post("/:rentalId/payments", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = paymentSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.post_payment");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.post_payment", branchId);
    }
    const result = await postRentalPayment({
      rentalId: params.rentalId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.patch("/:rentalId/terms", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = termsSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.edit_terms");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.edit_terms", branchId);
    }
    const result = await updateRentalTerms({
      rentalId: params.rentalId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(200).json(result);
  }));

  router.post("/:rentalId/deposits/receive", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = paymentSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.receive_deposit");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.receive_deposit", branchId);
    }
    const result = await receiveRentalDeposit({
      rentalId: params.rentalId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/:rentalId/deposits/refund", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = paymentSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.refund_deposit");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.refund_deposit", branchId);
    }
    const result = await refundRentalDeposit({
      rentalId: params.rentalId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/:rentalId/penalties/manual", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = manualPenaltySchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.manual_penalty");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.manual_penalty", branchId);
    }
    const result = await createRentalManualPenalty({
      rentalId: params.rentalId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/:rentalId/penalties/:penaltyId/pay", asyncHandler(async (req, res) => {
    const params = penaltyParamsSchema.parse(req.params);
    const payload = penaltyPaymentSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.pay_penalty");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.pay_penalty", branchId);
    }
    const result = await payRentalPenalty({
      rentalId: params.rentalId,
      penaltyId: params.penaltyId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/:rentalId/penalties/auto-run", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = autoPenaltySchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "rentals.manage_penalty");
    const branchId = await findRentalBranchId(actor.tenantId, params.rentalId);
    if (branchId !== undefined) {
      assertActorBranchAccess(actor, "rentals.manage_penalty", branchId);
    }
    const result = await runRentalAutoPenaltyAccrual({
      rentalId: params.rentalId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  return router;
}
