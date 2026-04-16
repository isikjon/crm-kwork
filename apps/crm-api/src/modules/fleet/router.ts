import { randomBytes } from "node:crypto";
import { BuyoutStatus, RentalStatus, TransactionStatus, TransactionType, type Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { isAssignableBikeUnitName } from "./bike-unit-classifier.js";
import { buildGpsSnapshot } from "../gps/service.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const revenueTransactionTypes = [
  TransactionType.RENTAL_PAYMENT_IN,
  TransactionType.BUYOUT_PAYMENT_IN,
  TransactionType.DOWN_PAYMENT_IN,
  TransactionType.PARTIAL_PAYMENT_IN,
  TransactionType.PENALTY_PAYMENT_IN
] as const;

const activeRentalStatuses = [
  RentalStatus.NEW,
  RentalStatus.ACTIVE,
  RentalStatus.OVERDUE,
  RentalStatus.HOLD,
  RentalStatus.RETURN_PREP
] as const;

const activeBuyoutStatuses = [
  BuyoutStatus.NEW,
  BuyoutStatus.ACTIVE,
  BuyoutStatus.OVERDUE,
  BuyoutStatus.HOLD
] as const;

const closedRentalStatuses = [
  RentalStatus.COMPLETED,
  RentalStatus.CANCELED
] as const;

const closedBuyoutStatuses = [
  BuyoutStatus.CLOSED,
  BuyoutStatus.TERMINATED
] as const;

const MS_DAY = 24 * 60 * 60 * 1000;

const quickFilterSchema = z.enum([
  "available",
  "rented",
  "buyout",
  "repair",
  "gps_issue",
  "attention"
]);

const listQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  q: z.string().trim().optional(),
  status: z
    .enum(["AVAILABLE", "RESERVED", "RENTED", "BUYOUT", "RETURN_PENDING", "REPAIR", "WRITTEN_OFF"])
    .optional(),
  quick: quickFilterSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

const bikeParamsSchema = z.object({
  bikeId: z.string().trim().min(2).max(128)
});

const workspaceQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64)
});

const managedBikeStatuses = ["RENTED", "BUYOUT", "RETURN_PENDING"] as const;
const bikeStatusSchema = z.enum([
  "AVAILABLE",
  "RESERVED",
  "RENTED",
  "BUYOUT",
  "RETURN_PENDING",
  "REPAIR",
  "WRITTEN_OFF"
]);

const bikeCreateSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  title: z.string().trim().min(2).max(160),
  bikeModelName: z.string().trim().min(1).max(160),
  article: z.string().trim().max(160).optional(),
  serialNumber: z.string().trim().max(160).optional(),
  odometerKm: z.coerce.number().int().min(0).max(1_000_000).default(0),
  purchaseCostRubles: z.coerce.number().min(0).max(100_000_000).default(0),
  salePriceRubles: z.coerce.number().min(0).max(100_000_000).default(0),
  status: bikeStatusSchema.default("AVAILABLE"),
  branchId: z.string().trim().min(2).max(128).optional(),
  conditionNote: z.string().trim().max(1000).optional(),
  comment: z.string().trim().max(4000).optional()
});

const bikeUpdateSchema = bikeCreateSchema.extend({
  tenantSlug: z.string().trim().min(2).max(64)
});

type BikeInputPayload = z.infer<typeof bikeCreateSchema>;
type FleetQuickFilter = z.infer<typeof quickFilterSchema>;

function tokenizeSearch(value: string | undefined) {
  return (value ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildBikeSearchWhere(
  tenantId: string,
  tokens: string[],
  status?: string,
  branchId?: string | null
): Prisma.BikeUnitWhereInput {
  return {
    tenantId,
    ...(branchId ? { branchId } : {}),
    ...(status ? { status: status as Prisma.EnumBikeStatusFilter["equals"] } : {}),
    ...(tokens.length > 0
      ? {
          AND: tokens.map((token) => ({
            OR: [
              { title: { contains: token, mode: "insensitive" } },
              { internalCode: { contains: token, mode: "insensitive" } },
              { article: { contains: token, mode: "insensitive" } },
              { serialNumber: { contains: token, mode: "insensitive" } },
              { legacyExternalId: { contains: token, mode: "insensitive" } },
              { bikeModel: { is: { name: { contains: token, mode: "insensitive" } } } },
              { currentClient: { is: { fullName: { contains: token, mode: "insensitive" } } } }
            ]
          }))
        }
      : {})
  };
}

function resolveQuickStatusFilter(quick: FleetQuickFilter | undefined) {
  switch (quick) {
    case "available":
      return "AVAILABLE" as const;
    case "rented":
      return "RENTED" as const;
    case "buyout":
      return "BUYOUT" as const;
    case "repair":
      return "REPAIR" as const;
    default:
      return undefined;
  }
}

function isProblematicDealStatus(status: string) {
  return ["OVERDUE", "HOLD", "RETURN_PREP"].includes(status);
}

function addUtcYears(value: Date, years: number) {
  return new Date(Date.UTC(
    value.getUTCFullYear() + years,
    value.getUTCMonth(),
    value.getUTCDate()
  ));
}

function addUtcMonths(value: Date, months: number) {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  return new Date(Date.UTC(
    year + Math.floor(month / 12),
    ((month % 12) + 12) % 12,
    value.getUTCDate()
  ));
}

function formatRussianUnit(value: number, forms: [string, string, string]) {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${value} ${forms[0]}`;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${value} ${forms[1]}`;
  }

  return `${value} ${forms[2]}`;
}

function formatWorkedDurationLabel(totalDays: number) {
  if (totalDays <= 0) {
    return "0 дней";
  }

  const anchor = new Date(Date.UTC(2000, 0, 1));
  const target = new Date(anchor);
  target.setUTCDate(target.getUTCDate() + totalDays);

  let cursor = anchor;
  let years = 0;
  let months = 0;

  while (true) {
    const next = addUtcYears(cursor, 1);
    if (next.getTime() > target.getTime()) {
      break;
    }

    cursor = next;
    years += 1;
  }

  while (true) {
    const next = addUtcMonths(cursor, 1);
    if (next.getTime() > target.getTime()) {
      break;
    }

    cursor = next;
    months += 1;
  }

  const days = Math.max(0, Math.round((target.getTime() - cursor.getTime()) / (24 * 60 * 60 * 1000)));
  const parts = [
    years > 0 ? formatRussianUnit(years, ["год", "года", "лет"]) : null,
    months > 0 ? formatRussianUnit(months, ["месяц", "месяца", "месяцев"]) : null,
    days > 0 ? formatRussianUnit(days, ["день", "дня", "дней"]) : null
  ].filter((value): value is string => Boolean(value));

  return parts.slice(0, 2).join(" ");
}

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate()
  ));
}

function mergeOccupiedIntervals(intervals: Array<{ startsAt: Date; endsAt: Date }>) {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals]
    .filter((interval) => interval.endsAt.getTime() >= interval.startsAt.getTime())
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());

  if (sorted.length === 0) {
    return [];
  }

  const merged: Array<{ startsAt: Date; endsAt: Date }> = [sorted[0]!];

  for (const interval of sorted.slice(1)) {
    const current = merged[merged.length - 1]!;

    if (interval.startsAt.getTime() <= current.endsAt.getTime()) {
      if (interval.endsAt.getTime() > current.endsAt.getTime()) {
        current.endsAt = interval.endsAt;
      }
      continue;
    }

    merged.push({
      startsAt: interval.startsAt,
      endsAt: interval.endsAt
    });
  }

  return merged;
}

function calculateWorkedDurationSummary(intervals: Array<{ startsAt: Date; endsAt: Date }>) {
  const merged = mergeOccupiedIntervals(intervals);
  const totalDays = merged.reduce((sum, interval) => {
    const durationMs = interval.endsAt.getTime() - interval.startsAt.getTime();
    const days = Math.max(1, Math.ceil(durationMs / MS_DAY));
    return sum + days;
  }, 0);

  return {
    workedDurationDays: totalDays,
    workedDurationLabel: formatWorkedDurationLabel(totalDays)
  };
}

function calculateWorkedDaysInWindow(
  mergedIntervals: Array<{ startsAt: Date; endsAt: Date }>,
  windowDays: number,
  now: Date
) {
  if (windowDays <= 0 || mergedIntervals.length === 0) {
    return 0;
  }

  const windowStart = startOfUtcDay(new Date(now.getTime() - (windowDays - 1) * MS_DAY));
  const windowEnd = now;

  return Math.min(windowDays, mergedIntervals.reduce((sum, interval) => {
    const clippedStart = interval.startsAt.getTime() > windowStart.getTime()
      ? interval.startsAt
      : windowStart;
    const clippedEnd = interval.endsAt.getTime() < windowEnd.getTime()
      ? interval.endsAt
      : windowEnd;

    if (clippedEnd.getTime() < clippedStart.getTime()) {
      return sum;
    }

    const startDay = startOfUtcDay(clippedStart);
    const endDay = startOfUtcDay(clippedEnd);
    const workedDays = Math.floor((endDay.getTime() - startDay.getTime()) / MS_DAY) + 1;

    return sum + workedDays;
  }, 0));
}

function calculateUtilizationWindowSummary(
  mergedIntervals: Array<{ startsAt: Date; endsAt: Date }>,
  windowDays: number,
  now: Date
) {
  const workedDays = calculateWorkedDaysInWindow(mergedIntervals, windowDays, now);
  return {
    workedDays,
    utilizationPercent: Math.round((workedDays / windowDays) * 100)
  };
}

function normalizeOptionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function toKopecksFromRubles(value: number) {
  return Math.round(Math.max(0, value) * 100);
}

function sanitizeInternalCodeSeed(value: string | null | undefined) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

async function generateBikeInternalCode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  article?: string | null
) {
  const articleSeed = sanitizeInternalCodeSeed(article);

  if (articleSeed) {
    const taken = await tx.bikeUnit.findFirst({
      where: {
        tenantId,
        internalCode: articleSeed
      },
      select: {
        id: true
      }
    });

    if (!taken) {
      return articleSeed;
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `BIKE-${randomBytes(3).toString("hex").toUpperCase()}`;
    const taken = await tx.bikeUnit.findFirst({
      where: {
        tenantId,
        internalCode: candidate
      },
      select: {
        id: true
      }
    });

    if (!taken) {
      return candidate;
    }
  }

  throw new HttpError(500, "Не удалось сгенерировать код велосипеда.");
}

async function ensureBikeModelId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  bikeModelName: string
) {
  const normalizedName = bikeModelName.trim();
  const existing = await tx.bikeModel.findFirst({
    where: {
      tenantId,
      name: {
        equals: normalizedName,
        mode: "insensitive"
      }
    },
    select: {
      id: true
    }
  });

  if (existing) {
    return existing.id;
  }

  const created = await tx.bikeModel.create({
    data: {
      tenantId,
      name: normalizedName
    },
    select: {
      id: true
    }
  });

  return created.id;
}

async function inferTariffGroupIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  bikeModelId: string
) {
  const bikesOfSameModel = await tx.bikeUnit.findMany({
    where: {
      tenantId,
      bikeModelId
    },
    select: {
      rentalTariffGroupId: true,
      buyoutTariffGroupId: true
    }
  });

  const distinctRentalGroupIds = [...new Set(
    bikesOfSameModel
      .map((bike) => bike.rentalTariffGroupId)
      .filter((value): value is string => Boolean(value))
  )];
  const distinctBuyoutGroupIds = [...new Set(
    bikesOfSameModel
      .map((bike) => bike.buyoutTariffGroupId)
      .filter((value): value is string => Boolean(value))
  )];

  let rentalTariffGroupId = distinctRentalGroupIds.length === 1 ? distinctRentalGroupIds[0] : null;
  let buyoutTariffGroupId = distinctBuyoutGroupIds.length === 1 ? distinctBuyoutGroupIds[0] : null;

  if (!rentalTariffGroupId) {
    const groups = await tx.rentalTariffGroup.findMany({
      where: {
        tenantId,
        kind: "RENTAL",
        isActive: true
      },
      select: {
        id: true,
        _count: {
          select: {
            rentalBikeUnits: true
          }
        }
      }
    });

    if (groups.length === 1) {
      rentalTariffGroupId = groups[0]?.id ?? null;
    } else if (groups.length > 1) {
      const dominantGroup = [...groups]
        .sort((left, right) => right._count.rentalBikeUnits - left._count.rentalBikeUnits)[0];

      if ((dominantGroup?._count.rentalBikeUnits ?? 0) > 0) {
        rentalTariffGroupId = dominantGroup?.id ?? null;
      }
    }
  }

  if (!buyoutTariffGroupId) {
    const groups = await tx.rentalTariffGroup.findMany({
      where: {
        tenantId,
        kind: "BUYOUT",
        isActive: true
      },
      select: {
        id: true,
        _count: {
          select: {
            buyoutBikeUnits: true
          }
        }
      }
    });

    if (groups.length === 1) {
      buyoutTariffGroupId = groups[0]?.id ?? null;
    } else if (groups.length > 1) {
      const dominantGroup = [...groups]
        .sort((left, right) => right._count.buyoutBikeUnits - left._count.buyoutBikeUnits)[0];

      if ((dominantGroup?._count.buyoutBikeUnits ?? 0) > 0) {
        buyoutTariffGroupId = dominantGroup?.id ?? null;
      }
    }
  }

  return {
    rentalTariffGroupId,
    buyoutTariffGroupId
  };
}

async function ensureBranchExists(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string | null
) {
  if (!branchId) {
    return null;
  }

  const branch = await tx.branch.findFirst({
    where: {
      id: branchId,
      tenantId
    },
    select: {
      id: true
    }
  });

  if (!branch) {
    throw new HttpError(404, "Точка не найдена.");
  }

  return branch.id;
}

async function hasActiveDeal(
  tx: Prisma.TransactionClient,
  tenantId: string,
  bikeId: string
) {
  const [activeRentalCount, activeBuyoutCount] = await Promise.all([
    tx.rental.count({
      where: {
        tenantId,
        bikeUnitId: bikeId,
        status: {
          in: [...activeRentalStatuses]
        }
      }
    }),
    tx.buyout.count({
      where: {
        tenantId,
        bikeUnitId: bikeId,
        status: {
          in: [...activeBuyoutStatuses]
        }
      }
    })
  ]);

  return activeRentalCount > 0 || activeBuyoutCount > 0;
}

async function buildBikeMutationData(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: BikeInputPayload,
  currentBike?: {
    id: string;
    status: string;
    bikeModelId: string | null;
    rentalTariffGroupId: string | null;
    buyoutTariffGroupId: string | null;
    valuationKopecks: number;
    salePriceKopecks: number;
  }
) {
  const branchId = await ensureBranchExists(tx, tenantId, normalizeOptionalText(payload.branchId));
  const bikeModelId = await ensureBikeModelId(tx, tenantId, payload.bikeModelName);
  const inferredGroups = await inferTariffGroupIds(tx, tenantId, bikeModelId);
  const purchaseCostKopecks = toKopecksFromRubles(payload.purchaseCostRubles);
  const salePriceKopecks = toKopecksFromRubles(payload.salePriceRubles);

  if (!currentBike && managedBikeStatuses.includes(payload.status)) {
    throw new HttpError(422, "Статус аренды или выкупа появляется только из сделки.");
  }

  if (currentBike) {
    const bikeIsBusy = await hasActiveDeal(tx, tenantId, currentBike.id);

    if (bikeIsBusy && payload.status !== currentBike.status) {
      throw new HttpError(409, "Статус этого велосипеда сейчас управляется активной сделкой.");
    }

    if (!bikeIsBusy && managedBikeStatuses.includes(payload.status)) {
      throw new HttpError(422, "Без активной сделки нельзя вручную поставить статус аренды или выкупа.");
    }
  }

  return {
    branchId,
    bikeModelId,
    title: payload.title.trim(),
    article: normalizeOptionalText(payload.article),
    serialNumber: normalizeOptionalText(payload.serialNumber),
    odometerKm: payload.odometerKm,
    purchaseCostKopecks,
    salePriceKopecks,
    status: payload.status,
    conditionNote: normalizeOptionalText(payload.conditionNote),
    comment: normalizeOptionalText(payload.comment),
    rentalTariffGroupId: currentBike?.rentalTariffGroupId ?? inferredGroups.rentalTariffGroupId,
    buyoutTariffGroupId: currentBike?.buyoutTariffGroupId ?? inferredGroups.buyoutTariffGroupId,
    valuationKopecks: currentBike ? currentBike.valuationKopecks : salePriceKopecks
  };
}

async function loadBikeRevenueMap(tenantId: string, bikeIds: string[]) {
  if (bikeIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await prisma.financialTransaction.findMany({
    where: {
      tenantId,
      status: TransactionStatus.POSTED,
      type: {
        in: [...revenueTransactionTypes]
      },
      OR: [
        { rental: { is: { bikeUnitId: { in: bikeIds } } } },
        { buyout: { is: { bikeUnitId: { in: bikeIds } } } }
      ]
    },
    select: {
      amountKopecks: true,
      rental: {
        select: {
          bikeUnitId: true
        }
      },
      buyout: {
        select: {
          bikeUnitId: true
        }
      }
    }
  });

  const revenueMap = new Map<string, number>();

  for (const row of rows) {
    const bikeId = row.rental?.bikeUnitId ?? row.buyout?.bikeUnitId;
    if (!bikeId) {
      continue;
    }

    revenueMap.set(bikeId, (revenueMap.get(bikeId) ?? 0) + row.amountKopecks);
  }

  return revenueMap;
}

async function loadBikeRepairCostMap(tenantId: string, bikeIds: string[]) {
  if (bikeIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await prisma.repair.groupBy({
    by: ["bikeUnitId"],
    where: {
      tenantId,
      bikeUnitId: {
        in: bikeIds
      }
    },
    _sum: {
      costKopecks: true
    }
  });

  return new Map(rows.map((row) => [row.bikeUnitId, row._sum.costKopecks ?? 0]));
}

async function loadBikeActiveDealMap(tenantId: string, bikeIds: string[], branchId?: string | null) {
  if (bikeIds.length === 0) {
    return new Map<string, {
      kind: "RENTAL" | "BUYOUT";
      id: string;
      dealNumber: string;
      status: string;
      clientName: string;
      nextPaymentAt: string | null;
    }>();
  }

  const [rentals, buyouts] = await Promise.all([
    prisma.rental.findMany({
      where: {
        tenantId,
        bikeUnitId: {
          in: bikeIds
        },
        ...(branchId ? { branchId } : {}),
        status: {
          in: [...activeRentalStatuses]
        }
      },
      orderBy: [
        { updatedAt: "desc" },
        { nextPaymentAt: "asc" }
      ],
      select: {
        id: true,
        bikeUnitId: true,
        dealNumber: true,
        status: true,
        nextPaymentAt: true,
        client: {
          select: {
            fullName: true
          }
        }
      }
    }),
    prisma.buyout.findMany({
      where: {
        tenantId,
        bikeUnitId: {
          in: bikeIds
        },
        ...(branchId ? { branchId } : {}),
        status: {
          in: [...activeBuyoutStatuses]
        }
      },
      orderBy: [
        { updatedAt: "desc" },
        { nextPaymentAt: "asc" }
      ],
      select: {
        id: true,
        bikeUnitId: true,
        dealNumber: true,
        status: true,
        nextPaymentAt: true,
        client: {
          select: {
            fullName: true
          }
        }
      }
    })
  ]);

  const result = new Map<string, {
    kind: "RENTAL" | "BUYOUT";
    id: string;
    dealNumber: string;
    status: string;
    clientName: string;
    nextPaymentAt: string | null;
  }>();

  for (const rental of rentals) {
    if (!result.has(rental.bikeUnitId)) {
      result.set(rental.bikeUnitId, {
        kind: "RENTAL",
        id: rental.id,
        dealNumber: rental.dealNumber,
        status: rental.status,
        clientName: rental.client.fullName,
        nextPaymentAt: rental.nextPaymentAt
      });
    }
  }

  for (const buyout of buyouts) {
    if (!result.has(buyout.bikeUnitId)) {
      result.set(buyout.bikeUnitId, {
        kind: "BUYOUT",
        id: buyout.id,
        dealNumber: buyout.dealNumber,
        status: buyout.status,
        clientName: buyout.client.fullName,
        nextPaymentAt: buyout.nextPaymentAt
      });
    }
  }

  return result;
}

async function loadBikeOpenRepairMap(tenantId: string, bikeIds: string[], branchId?: string | null) {
  if (bikeIds.length === 0) {
    return new Map<string, {
      id: string;
      title: string;
      status: "OPEN";
      serviceDate: string;
      costKopecks: number;
    }>();
  }

  const rows = await prisma.repair.findMany({
    where: {
      tenantId,
      bikeUnitId: {
        in: bikeIds
      },
      ...(branchId ? { branchId } : {}),
      status: "OPEN"
    },
    orderBy: [
      { updatedAt: "desc" },
      { serviceDate: "desc" }
    ],
    select: {
      id: true,
      bikeUnitId: true,
      title: true,
      status: true,
      serviceDate: true,
      costKopecks: true
    }
  });

  const result = new Map<string, {
    id: string;
    title: string;
    status: "OPEN";
    serviceDate: string;
    costKopecks: number;
  }>();

  for (const repair of rows) {
    if (!result.has(repair.bikeUnitId)) {
      result.set(repair.bikeUnitId, {
        id: repair.id,
        title: repair.title,
        status: repair.status,
        serviceDate: repair.serviceDate,
        costKopecks: repair.costKopecks
      });
    }
  }

  return result;
}

function buildBikeAttentionState(input: {
  status: string;
  gps: ReturnType<typeof buildGpsSnapshot>;
  activeDeal: {
    kind: "RENTAL" | "BUYOUT";
    id: string;
    dealNumber: string;
    status: string;
    clientName: string;
    nextPaymentAt: string | null;
  } | null;
  openRepair: {
    id: string;
    title: string;
    status: "OPEN";
    serviceDate: string;
    costKopecks: number;
  } | null;
}) {
  const reasons: string[] = [];
  let hasGpsIssue = false;

  if (!input.gps) {
    hasGpsIssue = true;
    reasons.push("GPS не привязан");
  } else if (input.gps.lastSyncError) {
    hasGpsIssue = true;
    reasons.push("Ошибка синхронизации GPS");
  } else if (input.gps.status !== "ONLINE") {
    hasGpsIssue = true;
    reasons.push("GPS не в сети");
  } else if (input.gps.syncState !== "FRESH") {
    hasGpsIssue = true;
    reasons.push("Снимок GPS устарел");
  }

  if (input.openRepair) {
    reasons.push("Открыт ремонт");
  }

  if (input.activeDeal && isProblematicDealStatus(input.activeDeal.status)) {
    reasons.push("Активная сделка требует внимания");
  }

  return {
    hasGpsIssue,
    needsAttention: reasons.length > 0,
    reasons
  };
}

function matchesBikeQuickFilter(
  bike: {
    status: string;
    attention: {
      hasGpsIssue: boolean;
      needsAttention: boolean;
    };
  },
  quick: FleetQuickFilter | undefined
) {
  if (!quick) {
    return true;
  }

  switch (quick) {
    case "available":
      return bike.status === "AVAILABLE";
    case "rented":
      return bike.status === "RENTED";
    case "buyout":
      return bike.status === "BUYOUT";
    case "repair":
      return bike.status === "REPAIR";
    case "gps_issue":
      return bike.attention.hasGpsIssue;
    case "attention":
      return bike.attention.needsAttention;
    default:
      return true;
  }
}

export function createFleetRouter() {
  const router = Router();

  router.get("/workspace", asyncHandler(async (req, res) => {
    const query = workspaceQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "fleet.view");
    const readBranchId = resolveActorBranchReadScope(actor, "fleet.view");

    const [branches, bikeModelCandidates] = await Promise.all([
      prisma.branch.findMany({
        where: {
          tenantId: tenant.id,
          isActive: true,
          ...(readBranchId ? { id: readBranchId } : {})
        },
        orderBy: [
          { name: "asc" }
        ],
        select: {
          id: true,
          name: true,
          code: true
        }
      }),
      prisma.bikeUnit.findMany({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          bikeModelId: {
            not: null
          }
        },
        orderBy: [
          { updatedAt: "desc" }
        ],
        select: {
          title: true,
          bikeModel: {
            select: {
              id: true,
              name: true,
              article: true
            }
          }
        }
      })
    ]);

    const bikeModels = [...new Map(
      bikeModelCandidates
        .filter((bike) => bike.bikeModel && isAssignableBikeUnitName(bike.title, bike.bikeModel?.name))
        .map((bike) => [bike.bikeModel!.id, bike.bikeModel!])
    ).values()].sort((left, right) => left.name.localeCompare(right.name, "ru"));

    res.status(200).json({
      tenant,
      branches,
      bikeModels
    });
  }));

  router.get("/", asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "fleet.view");
    const readBranchId = resolveActorBranchReadScope(actor, "fleet.view");
    const tokens = tokenizeSearch(query.q);
    const effectiveStatusFilter = query.status ?? resolveQuickStatusFilter(query.quick);
    const where = buildBikeSearchWhere(tenant.id, tokens, effectiveStatusFilter, readBranchId);

    const bikeRows = await prisma.bikeUnit.findMany({
      where,
      orderBy: [
        { updatedAt: "desc" },
        { title: "asc" }
      ],
      select: {
        id: true,
        internalCode: true,
        title: true,
        article: true,
        serialNumber: true,
        status: true,
        odometerKm: true,
        purchaseCostKopecks: true,
        salePriceKopecks: true,
        valuationKopecks: true,
        lastIssuedAt: true,
        conditionNote: true,
        legacyExternalId: true,
        bikeModel: {
          select: {
            id: true,
            name: true
          }
        },
        rentalTariffGroup: {
          select: {
            id: true,
            name: true,
            code: true
          }
        },
        buyoutTariffGroup: {
          select: {
            id: true,
            name: true,
            code: true
          }
        },
        currentClient: {
          select: {
            id: true,
            fullName: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        },
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
        _count: {
          select: {
            rentals: true,
            buyouts: true,
            repairs: true
          }
        }
      }
    });

    const filteredRows = bikeRows.filter((bike) => isAssignableBikeUnitName(bike.title, bike.bikeModel?.name));
    const bikeIds = filteredRows.map((bike) => bike.id);

    const [revenueMap, repairCostMap, activeDealMap, openRepairMap] = await Promise.all([
      loadBikeRevenueMap(tenant.id, bikeIds),
      loadBikeRepairCostMap(tenant.id, bikeIds),
      loadBikeActiveDealMap(tenant.id, bikeIds, readBranchId),
      loadBikeOpenRepairMap(tenant.id, bikeIds, readBranchId)
    ]);

    const enrichedRows = filteredRows.map((bike) => {
      const { gpsTracker, ...bikeRecord } = bike;
      const revenueKopecks = revenueMap.get(bike.id) ?? 0;
      const repairCostKopecks = repairCostMap.get(bike.id) ?? 0;
      const gps = buildGpsSnapshot(gpsTracker);
      const activeDeal = activeDealMap.get(bike.id) ?? null;
      const openRepair = openRepairMap.get(bike.id) ?? null;
      const attention = buildBikeAttentionState({
        status: bike.status,
        gps,
        activeDeal,
        openRepair
      });

      return {
        ...bikeRecord,
        activeDeal,
        openRepair,
        gps,
        attention,
        economics: {
          revenueKopecks,
          repairCostKopecks,
          netProfitKopecks: revenueKopecks - repairCostKopecks
        }
      };
    });

    const operatorRows = enrichedRows.filter((bike) => matchesBikeQuickFilter(bike, query.quick));
    const rows = operatorRows.slice(0, query.limit);

    const summary = operatorRows.reduce((accumulator, bike) => {
      accumulator.total += 1;

      if (bike.status === "AVAILABLE") {
        accumulator.availableCount += 1;
      } else if (bike.status === "RENTED") {
        accumulator.rentedCount += 1;
      } else if (bike.status === "BUYOUT") {
        accumulator.buyoutCount += 1;
      } else if (bike.status === "REPAIR") {
        accumulator.repairCount += 1;
      } else if (bike.status === "RESERVED") {
        accumulator.reservedCount += 1;
      }

      if (bike.attention.hasGpsIssue) {
        accumulator.gpsIssueCount += 1;
      }

      if (bike.attention.needsAttention) {
        accumulator.attentionCount += 1;
      }

      return accumulator;
    }, {
      total: 0,
      availableCount: 0,
      rentedCount: 0,
      buyoutCount: 0,
      repairCount: 0,
      reservedCount: 0,
      gpsIssueCount: 0,
      attentionCount: 0
    });

    res.status(200).json({
      tenant,
      total: operatorRows.length,
      query: query.q?.trim() || null,
      statusFilter: effectiveStatusFilter ?? null,
      quickFilter: query.quick ?? null,
      summary,
      rows
    });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const payload = bikeCreateSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "fleet.edit");

    const bike = await prisma.$transaction(async (tx) => {
      const mutationData = await buildBikeMutationData(tx, tenant.id, payload);
      assertActorBranchAccess(actor, "fleet.edit", mutationData.branchId);
      const internalCode = await generateBikeInternalCode(tx, tenant.id, mutationData.article);

      const created = await tx.bikeUnit.create({
        data: {
          tenantId: tenant.id,
          internalCode,
          bikeModelId: mutationData.bikeModelId,
          branchId: mutationData.branchId,
          title: mutationData.title,
          article: mutationData.article,
          serialNumber: mutationData.serialNumber,
          odometerKm: mutationData.odometerKm,
          purchaseCostKopecks: mutationData.purchaseCostKopecks,
          salePriceKopecks: mutationData.salePriceKopecks,
          valuationKopecks: mutationData.valuationKopecks,
          status: mutationData.status,
          rentalTariffGroupId: mutationData.rentalTariffGroupId,
          buyoutTariffGroupId: mutationData.buyoutTariffGroupId,
          conditionNote: mutationData.conditionNote,
          comment: mutationData.comment
        },
        select: {
          id: true,
          internalCode: true,
          title: true,
          status: true,
          rentalTariffGroup: {
            select: {
              id: true,
              name: true
            }
          },
          buyoutTariffGroup: {
            select: {
              id: true,
              name: true
            }
          }
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "bike_unit",
          entityId: created.id,
          action: "created",
          newValueText: JSON.stringify({
            title: created.title,
            internalCode: created.internalCode,
            status: created.status
          }, null, 2)
        }
      });

      return created;
    });

    res.status(201).json({
      tenant,
      bike
    });
  }));

  router.get("/:bikeId", asyncHandler(async (req, res) => {
    const params = bikeParamsSchema.parse(req.params);
    const tenantSlug = z.string().trim().min(2).max(64).parse(req.query.tenantSlug);
    const { actor, tenant } = await requireTenantPermission(req, tenantSlug, "fleet.view");
    const readBranchId = resolveActorBranchReadScope(actor, "fleet.view");

    const bike = await prisma.bikeUnit.findFirst({
      where: {
        id: params.bikeId,
        tenantId: tenant.id,
        ...(readBranchId ? { branchId: readBranchId } : {})
      },
      select: {
        id: true,
        internalCode: true,
        title: true,
        article: true,
        serialNumber: true,
        status: true,
        odometerKm: true,
        purchaseCostKopecks: true,
        salePriceKopecks: true,
        valuationKopecks: true,
        photoPath: true,
        conditionNote: true,
        comment: true,
        lastIssuedAt: true,
        legacyExternalId: true,
        branch: {
          select: {
            id: true,
            name: true
          }
        },
        bikeModel: {
          select: {
            id: true,
            name: true,
            article: true
          }
        },
        currentClient: {
          select: {
            id: true,
            fullName: true,
            primaryPhone: true
          }
        },
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
            name: true,
            code: true
          }
        },
        buyoutTariffGroup: {
          select: {
            id: true,
            name: true,
            code: true
          }
        },
        repairs: {
          orderBy: [
            { status: "asc" },
            { serviceDate: "desc" }
          ],
          take: 6,
          select: {
            id: true,
            title: true,
            status: true,
            serviceDate: true,
            completedAt: true,
            costKopecks: true,
            description: true
          }
        },
        _count: {
          select: {
            rentals: true,
            buyouts: true,
            repairs: true
          }
        }
      }
    });

    if (!bike || !isAssignableBikeUnitName(bike.title, bike.bikeModel?.name)) {
      throw new HttpError(404, "Велосипед не найден.");
    }

    const [revenueMap, repairCostMap, activeRental, activeBuyout, recentRentals, recentBuyouts, rentalHistory, buyoutHistory] = await Promise.all([
      loadBikeRevenueMap(tenant.id, [bike.id]),
      loadBikeRepairCostMap(tenant.id, [bike.id]),
      prisma.rental.findFirst({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: [...activeRentalStatuses]
          }
        },
        orderBy: [
          { updatedAt: "desc" },
          { nextPaymentAt: "asc" }
        ],
        select: {
          id: true,
          dealNumber: true,
          status: true,
          nextPaymentAt: true,
          debtKopecks: true,
          overdueDays: true,
          plannedPaymentKopecks: true,
          client: {
            select: {
              id: true,
              fullName: true
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
          }
        }
      }),
      prisma.buyout.findFirst({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: [...activeBuyoutStatuses]
          }
        },
        orderBy: [
          { updatedAt: "desc" },
          { nextPaymentAt: "asc" }
        ],
        select: {
          id: true,
          dealNumber: true,
          status: true,
          nextPaymentAt: true,
          residualDebtKopecks: true,
          overdueDays: true,
          financedAmountKopecks: true,
          client: {
            select: {
              id: true,
              fullName: true
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
          }
        }
      }),
      prisma.rental.findMany({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 3,
        select: {
          id: true,
          dealNumber: true,
          status: true,
          startsAt: true,
          nextPaymentAt: true,
          client: {
            select: {
              fullName: true
            }
          }
        }
      }),
      prisma.buyout.findMany({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 3,
        select: {
          id: true,
          dealNumber: true,
          status: true,
          startsAt: true,
          nextPaymentAt: true,
          client: {
            select: {
              fullName: true
            }
          }
        }
      }),
      prisma.rental.findMany({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        select: {
          startsAt: true,
          updatedAt: true,
          status: true
        }
      }),
      prisma.buyout.findMany({
        where: {
          tenantId: tenant.id,
          bikeUnitId: bike.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        select: {
          startsAt: true,
          updatedAt: true,
          status: true
        }
      })
    ]);

    const revenueKopecks = revenueMap.get(bike.id) ?? 0;
    const repairCostKopecks = repairCostMap.get(bike.id) ?? 0;
    const now = new Date();
    const occupiedIntervals = mergeOccupiedIntervals([
      ...rentalHistory.map((deal) => ({
        startsAt: deal.startsAt,
        endsAt: closedRentalStatuses.includes(deal.status) ? deal.updatedAt : now
      })),
      ...buyoutHistory.map((deal) => ({
        startsAt: deal.startsAt,
        endsAt: closedBuyoutStatuses.includes(deal.status) ? deal.updatedAt : now
      }))
    ]);
    const workedDuration = calculateWorkedDurationSummary(occupiedIntervals);

    res.status(200).json({
      tenant,
      bike: {
        ...bike,
        economics: {
          moneyBroughtKopecks: revenueKopecks,
          repairSpentKopecks: repairCostKopecks,
          netProfitKopecks: revenueKopecks - repairCostKopecks
        },
        summary: {
          rentalsCount: bike._count.rentals,
          buyoutsCount: bike._count.buyouts,
          repairsCount: bike._count.repairs,
          workedDurationDays: workedDuration.workedDurationDays,
          workedDurationLabel: workedDuration.workedDurationLabel,
          utilization: {
            last7Days: calculateUtilizationWindowSummary(occupiedIntervals, 7, now),
            last30Days: calculateUtilizationWindowSummary(occupiedIntervals, 30, now),
            last365Days: calculateUtilizationWindowSummary(occupiedIntervals, 365, now)
          }
        },
        activeRental,
        activeBuyout,
        gps: buildGpsSnapshot(bike.gpsTracker),
        issuedEquipment: activeRental?.equipmentItems ?? activeBuyout?.equipmentItems ?? [],
        recentDeals: {
          rentals: recentRentals,
          buyouts: recentBuyouts
        }
      }
    });
  }));

  router.patch("/:bikeId", asyncHandler(async (req, res) => {
    const params = bikeParamsSchema.parse(req.params);
    const payload = bikeUpdateSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "fleet.edit");

    const bike = await prisma.$transaction(async (tx) => {
      const current = await tx.bikeUnit.findFirst({
        where: {
          id: params.bikeId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          status: true,
          bikeModelId: true,
          rentalTariffGroupId: true,
          buyoutTariffGroupId: true,
          valuationKopecks: true,
          salePriceKopecks: true
        }
      });

      if (!current) {
        throw new HttpError(404, "Велосипед не найден.");
      }

      const mutationData = await buildBikeMutationData(tx, tenant.id, payload, current);
      assertActorBranchAccess(actor, "fleet.edit", mutationData.branchId);

      const updated = await tx.bikeUnit.update({
        where: {
          id: current.id
        },
        data: {
          bikeModelId: mutationData.bikeModelId,
          branchId: mutationData.branchId,
          title: mutationData.title,
          article: mutationData.article,
          serialNumber: mutationData.serialNumber,
          odometerKm: mutationData.odometerKm,
          purchaseCostKopecks: mutationData.purchaseCostKopecks,
          salePriceKopecks: mutationData.salePriceKopecks,
          status: mutationData.status,
          conditionNote: mutationData.conditionNote,
          comment: mutationData.comment,
          rentalTariffGroupId: mutationData.rentalTariffGroupId,
          buyoutTariffGroupId: mutationData.buyoutTariffGroupId
        },
        select: {
          id: true,
          internalCode: true,
          title: true,
          status: true,
          rentalTariffGroup: {
            select: {
              id: true,
              name: true
            }
          },
          buyoutTariffGroup: {
            select: {
              id: true,
              name: true
            }
          }
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "bike_unit",
          entityId: updated.id,
          action: "updated",
          newValueText: JSON.stringify({
            title: updated.title,
            status: updated.status
          }, null, 2)
        }
      });

      return updated;
    });

    res.status(200).json({
      tenant,
      bike
    });
  }));

  return router;
}
