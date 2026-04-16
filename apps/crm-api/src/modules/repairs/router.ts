import { BikeStatus, TransactionDirection, TransactionStatus, TransactionType, type Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { HttpError } from "../../core/http/errors.js";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { prisma } from "../../db/prisma.js";
import { resolveSystemArticleAssignment } from "../finance/articles.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  status: z.enum(["OPEN", "COMPLETED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

const paramsSchema = z.object({
  repairId: z.string().trim().min(2).max(128)
});

const createRepairSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  bikeId: z.string().trim().min(2).max(128),
  title: z.string().trim().max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  serviceDate: z.string().trim().optional(),
  initialAmountKopecks: z.coerce.number().int().min(0).optional(),
  bankId: z.string().trim().min(2).max(128).optional(),
  initialItemTitle: z.string().trim().max(160).optional(),
  initialItemComment: z.string().trim().max(2000).optional()
});

const addItemSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  title: z.string().trim().min(2).max(160),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  amountKopecks: z.coerce.number().int().min(0).default(0),
  bankId: z.string().trim().min(2).max(128).optional(),
  comment: z.string().trim().max(2000).optional()
});

const completeSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

type TransactionClient = Prisma.TransactionClient;

function parseOptionalDate(value?: string) {
  if (!value?.trim()) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, "Некорректная дата ремонта.");
  }

  return parsed;
}

function tokenizeSearch(value: string | undefined) {
  return (value ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function createRepairExpenseTransaction(tx: TransactionClient, params: {
  tenantId: string;
  branchId?: string | null;
  bankId: string;
  repairId: string;
  bikeTitle: string;
  amountKopecks: number;
  comment?: string | null;
  happenedAt: Date;
  actorUserId?: string | null;
}) {
  const article = await resolveSystemArticleAssignment(tx, params.tenantId, TransactionType.REPAIR_EXPENSE);

  return tx.financialTransaction.create({
    data: {
      tenantId: params.tenantId,
      branchId: params.branchId ?? null,
      bankId: params.bankId,
      articleId: article?.id ?? null,
      createdById: params.actorUserId ?? null,
      type: TransactionType.REPAIR_EXPENSE,
      direction: TransactionDirection.EXPENSE,
      status: TransactionStatus.POSTED,
      paymentMethod: "BANK",
      amountKopecks: params.amountKopecks,
      happenedAt: params.happenedAt,
      postedAt: params.happenedAt,
      articleNameSnapshot: article?.name ?? null,
      articleDirectionSnapshot: article?.direction ?? null,
      comment: params.comment?.trim() || null,
      sourceLabel: `Ремонт · ${params.bikeTitle}`,
      externalReference: params.repairId
    },
    select: {
      id: true
    }
  });
}

async function recomputeRepairTotal(tx: TransactionClient, params: {
  repairId: string;
}) {
  const aggregate = await tx.repairLineItem.aggregate({
    where: {
      repairId: params.repairId
    },
    _sum: {
      amountKopecks: true
    }
  });

  const costKopecks = aggregate._sum.amountKopecks ?? 0;
  await tx.repair.update({
    where: {
      id: params.repairId
    },
    data: {
      costKopecks
    }
  });

  return costKopecks;
}

export function createRepairsRouter() {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "repairs.view");
    const readBranchId = resolveActorBranchReadScope(actor, "repairs.view");
    const search = query.q?.trim();
    const tokens = tokenizeSearch(search);

    const where = {
      tenantId: tenant.id,
      ...(readBranchId ? { branchId: readBranchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(tokens.length > 0
        ? {
            AND: tokens.map((token) => ({
              OR: [
                { title: { contains: token, mode: "insensitive" as const } },
                { description: { contains: token, mode: "insensitive" as const } },
                { executorName: { contains: token, mode: "insensitive" as const } },
                { sourceName: { contains: token, mode: "insensitive" as const } },
                {
                  bikeUnit: {
                    is: {
                      OR: [
                        { title: { contains: token, mode: "insensitive" as const } },
                        { article: { contains: token, mode: "insensitive" as const } },
                        { internalCode: { contains: token, mode: "insensitive" as const } },
                        { serialNumber: { contains: token, mode: "insensitive" as const } }
                      ]
                    }
                  }
                }
              ]
            }))
          }
        : {})
    };

    const rows = await prisma.repair.findMany({
      where,
      orderBy: [
        { status: "asc" },
        { serviceDate: "desc" },
        { createdAt: "desc" }
      ],
      take: query.limit,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        serviceDate: true,
        completedAt: true,
        executorName: true,
        sourceName: true,
        costKopecks: true,
        bikeUnit: {
          select: {
            id: true,
            title: true,
            article: true,
            internalCode: true,
            status: true
          }
        },
        items: {
          orderBy: {
            createdAt: "asc"
          },
          select: {
            id: true,
            title: true,
            quantity: true,
            amountKopecks: true,
            transactionId: true,
            comment: true,
            createdAt: true,
            bank: {
              select: {
                name: true
              }
            }
          }
        }
      }
    });

    const banks = await prisma.bank.findMany({
      where: {
        tenantId: tenant.id,
        isActive: true,
        ...(readBranchId
          ? {
              OR: [
                { branchId: readBranchId },
                { branchId: null }
              ]
            }
          : {})
      },
      orderBy: [
        { name: "asc" }
      ],
      select: {
        id: true,
        name: true,
        instructionType: true,
        branch: {
          select: {
            name: true
          }
        }
      }
    });

    const total = await prisma.repair.count({ where });
    const openCount = await prisma.repair.count({
      where: {
        tenantId: tenant.id,
        ...(readBranchId ? { branchId: readBranchId } : {}),
        status: "OPEN"
      }
    });
    const completedCount = await prisma.repair.count({
      where: {
        tenantId: tenant.id,
        ...(readBranchId ? { branchId: readBranchId } : {}),
        status: "COMPLETED"
      }
    });

    res.status(200).json({
      tenant,
      total,
      query: search ?? null,
      statusFilter: query.status ?? null,
      summary: {
        openCount,
        completedCount
      },
      banks,
      rows
    });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const payload = createRepairSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "repairs.edit");
    const serviceDate = parseOptionalDate(payload.serviceDate);
    const initialAmountKopecks = Math.max(0, payload.initialAmountKopecks ?? 0);

    if (initialAmountKopecks > 0 && !payload.bankId?.trim()) {
      throw new HttpError(400, "Если сразу указываем сумму ремонта, нужно выбрать банк списания.");
    }

    const result = await prisma.$transaction(async (tx) => {
      const bike = await tx.bikeUnit.findFirst({
        where: {
          id: payload.bikeId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          title: true,
          article: true,
          internalCode: true,
          status: true,
          branchId: true
        }
      });

      if (!bike) {
        throw new HttpError(404, "Велосипед не найден.");
      }

      assertActorBranchAccess(actor, "repairs.edit", bike.branchId);

      if (bike.status === BikeStatus.RENTED || bike.status === BikeStatus.BUYOUT || bike.status === BikeStatus.RESERVED) {
        throw new HttpError(409, "Нельзя оформить ремонт на велосипед, который сейчас в работе.");
      }

      const existingOpenRepair = await tx.repair.findFirst({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          status: "OPEN"
        },
        select: {
          id: true
        }
      });

      if (existingOpenRepair) {
        throw new HttpError(409, "По этому велосипеду уже есть открытый ремонт.");
      }

      if (initialAmountKopecks > 0) {
        const bank = await tx.bank.findFirst({
          where: {
            id: payload.bankId?.trim(),
            tenantId: tenant.id,
            isActive: true
          },
          select: {
            id: true
          }
        });

        if (!bank) {
          throw new HttpError(404, "Банк для списания ремонта не найден.");
        }
      }

      const repair = await tx.repair.create({
        data: {
          tenantId: tenant.id,
          branchId: bike.branchId ?? null,
          bikeUnitId: bike.id,
          createdById: actor.userId,
          serviceDate,
          title: payload.title?.trim() || "Ремонт",
          description: payload.description?.trim() || null,
          costKopecks: 0
        },
        select: {
          id: true,
          title: true
        }
      });

      await tx.bikeUnit.update({
        where: {
          id: bike.id
        },
        data: {
          status: BikeStatus.REPAIR
        }
      });

      if (initialAmountKopecks > 0) {
        const transaction = await createRepairExpenseTransaction(tx, {
          tenantId: tenant.id,
          branchId: bike.branchId ?? null,
          bankId: payload.bankId!.trim(),
          repairId: repair.id,
          bikeTitle: bike.title,
          amountKopecks: initialAmountKopecks,
          comment: payload.initialItemComment?.trim() || payload.description?.trim() || null,
          happenedAt: serviceDate,
          actorUserId: actor.userId
        });

        await tx.repairLineItem.create({
          data: {
            tenantId: tenant.id,
            repairId: repair.id,
            bankId: payload.bankId!.trim(),
            transactionId: transaction.id,
            title: payload.initialItemTitle?.trim() || payload.title?.trim() || "Основной ремонт",
            amountKopecks: initialAmountKopecks,
            comment: payload.initialItemComment?.trim() || null
          }
        });

        await recomputeRepairTotal(tx, {
          repairId: repair.id
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "repair",
          entityId: repair.id,
          action: "created",
          newValueText: JSON.stringify({
            bikeId: bike.id,
            bikeTitle: bike.title,
            initialAmountKopecks
          }, null, 2)
        }
      });

      return repair;
    });

    res.status(201).json({
      tenant,
      repair: result
    });
  }));

  router.post("/:repairId/items", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = addItemSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "repairs.edit");

    if (payload.amountKopecks > 0 && !payload.bankId?.trim()) {
      throw new HttpError(400, "Для списания суммы ремонта выберите банк.");
    }

    const result = await prisma.$transaction(async (tx) => {
      const repair = await tx.repair.findFirst({
        where: {
          id: params.repairId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          title: true,
          status: true,
          branchId: true,
          bikeUnit: {
            select: {
              title: true
            }
          }
        }
      });

      if (!repair) {
        throw new HttpError(404, "Ремонт не найден.");
      }

      assertActorBranchAccess(actor, "repairs.edit", repair.branchId);

      if (repair.status === "COMPLETED") {
        throw new HttpError(409, "Ремонт уже завершен. Добавлять позиции больше нельзя.");
      }

      if (payload.amountKopecks > 0) {
        const bank = await tx.bank.findFirst({
          where: {
            id: payload.bankId?.trim(),
            tenantId: tenant.id,
            isActive: true
          },
          select: {
            id: true
          }
        });

        if (!bank) {
          throw new HttpError(404, "Банк для списания ремонта не найден.");
        }
      }

      const transaction = payload.amountKopecks > 0
        ? await createRepairExpenseTransaction(tx, {
            tenantId: tenant.id,
            branchId: repair.branchId ?? null,
            bankId: payload.bankId!.trim(),
            repairId: repair.id,
            bikeTitle: repair.bikeUnit.title,
            amountKopecks: payload.amountKopecks,
            comment: payload.comment?.trim() || null,
            happenedAt: new Date(),
            actorUserId: actor.userId
          })
        : null;

      const item = await tx.repairLineItem.create({
        data: {
          tenantId: tenant.id,
          repairId: repair.id,
          bankId: payload.bankId?.trim() || null,
          transactionId: transaction?.id ?? null,
          title: payload.title,
          quantity: payload.quantity,
          amountKopecks: payload.amountKopecks,
          comment: payload.comment?.trim() || null
        },
        select: {
          id: true,
          title: true,
          amountKopecks: true
        }
      });

      const totalCostKopecks = await recomputeRepairTotal(tx, {
        repairId: repair.id
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "repair",
          entityId: repair.id,
          action: "item_added",
          newValueText: JSON.stringify({
            itemId: item.id,
            title: item.title,
            amountKopecks: item.amountKopecks,
            totalCostKopecks
          }, null, 2)
        }
      });

      return {
        item,
        totalCostKopecks
      };
    });

    res.status(201).json({
      tenant,
      repairId: params.repairId,
      ...result
    });
  }));

  router.post("/:repairId/complete", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const payload = completeSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "repairs.edit");

    const result = await prisma.$transaction(async (tx) => {
      const repair = await tx.repair.findFirst({
        where: {
          id: params.repairId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          title: true,
          bikeUnitId: true,
          branchId: true,
          status: true
        }
      });

      if (!repair) {
        throw new HttpError(404, "Ремонт не найден.");
      }

      assertActorBranchAccess(actor, "repairs.edit", repair.branchId ?? null);

      if (repair.status === "COMPLETED") {
        throw new HttpError(409, "Ремонт уже завершен.");
      }

      const completedAt = new Date();

      await tx.repair.update({
        where: {
          id: repair.id
        },
        data: {
          status: "COMPLETED",
          completedAt
        }
      });

      await tx.bikeUnit.update({
        where: {
          id: repair.bikeUnitId
        },
        data: {
          status: BikeStatus.AVAILABLE,
          currentClientId: null
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "repair",
          entityId: repair.id,
          action: "completed",
          newValueText: JSON.stringify({
            completedAt,
            bikeStatus: BikeStatus.AVAILABLE
          }, null, 2)
        }
      });

      return {
        id: repair.id,
        title: repair.title,
        completedAt
      };
    });

    res.status(200).json({
      tenant,
      repair: result
    });
  }));

  return router;
}
