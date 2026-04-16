import { BikeStatus, BuyoutStatus, ScheduleCadence, type Prisma, RentalStatus } from "@prisma/client";
import type { CurrentActor } from "../../core/auth/request-context.js";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { refreshClientSnapshot } from "../finance/service.js";
import { queueDealCreatedTelegramInstruction } from "../notifications/service.js";
import { triggerQueuedTelegramNotificationDispatch } from "../notifications/telegram.js";
import { replaceRentalTariffSnapshots } from "./rental-tariff-snapshot-service.js";
import { rebuildBuyoutSchedule, rebuildRentalSchedule } from "./schedule-service.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";

type TransactionClient = Prisma.TransactionClient;
type EquipmentCatalogType = "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
type CreateDealEquipmentInput = {
  catalogItemId?: string | null;
  type: EquipmentCatalogType;
  label: string;
  quantity?: number | null;
  comment?: string | null;
};

const ACTIVE_RENTAL_STATUSES = [
  RentalStatus.NEW,
  RentalStatus.ACTIVE,
  RentalStatus.OVERDUE,
  RentalStatus.HOLD,
  RentalStatus.RETURN_PREP
] as const;

const ACTIVE_BUYOUT_STATUSES = [
  BuyoutStatus.NEW,
  BuyoutStatus.ACTIVE,
  BuyoutStatus.OVERDUE,
  BuyoutStatus.HOLD
] as const;

function clampMoney(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.trunc(numeric));
}

function clampPositiveInt(value: unknown, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const normalized = Math.trunc(numeric);
  return normalized > 0 ? normalized : fallback;
}

function normalizeEquipmentType(value: unknown): EquipmentCatalogType {
  switch (value) {
    case "BATTERY":
    case "CHARGER":
    case "HELMET":
    case "CHAIN_LOCK":
      return value;
    default:
      return "OTHER";
  }
}

function normalizeEquipmentItems(items: CreateDealEquipmentInput[] | undefined) {
  return (items ?? [])
    .map((item) => ({
      catalogItemId: item.catalogItemId?.trim() || null,
      type: normalizeEquipmentType(item.type),
      label: item.label.trim(),
      quantity: clampPositiveInt(item.quantity, 1),
      comment: item.comment?.trim() || null
    }))
    .filter((item) => item.label.length > 0)
    .slice(0, 20);
}

function formatTodayYmdMoscow() {
  const now = new Date();

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);

    const year = parts.find((part) => part.type === "year")?.value ?? "";
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = parts.find((part) => part.type === "day")?.value ?? "";

    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // ignore formatter issues
  }

  return now.toISOString().slice(0, 10);
}

function parseYmdUtcNoon(ymd: string) {
  const match = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return new Date();
  }

  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0));
}

function parseDealDate(input: string | null | undefined) {
  const normalized = input?.trim();
  return normalized ? parseYmdUtcNoon(normalized) : parseYmdUtcNoon(formatTodayYmdMoscow());
}

function addDaysUtc(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonthsUtc(date: Date, months: number) {
  const source = new Date(date);
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const day = source.getUTCDate();
  const cursor = new Date(Date.UTC(year, month, 1, 12, 0, 0, 0));
  cursor.setUTCMonth(cursor.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 12, 0, 0, 0)).getUTCDate();
  cursor.setUTCDate(Math.min(day, lastDay));
  return cursor;
}

function computeRentalNextPaymentAt(startsAt: Date, durationDays: number) {
  const normalizedDays = clampPositiveInt(durationDays, 7);

  if (normalizedDays >= 30 && normalizedDays % 30 === 0) {
    return addMonthsUtc(startsAt, Math.max(1, Math.trunc(normalizedDays / 30)));
  }

  if (normalizedDays >= 7 && normalizedDays % 7 === 0) {
    return addDaysUtc(startsAt, Math.max(1, Math.trunc(normalizedDays / 7)) * 7);
  }

  return addDaysUtc(startsAt, normalizedDays);
}

function computeBuyoutNextPaymentAt(startsAt: Date, cadence: ScheduleCadence) {
  if (cadence === "MONTHLY") {
    return addMonthsUtc(startsAt, 1);
  }

  if (cadence === "WEEKLY") {
    return addDaysUtc(startsAt, 7);
  }

  return addDaysUtc(startsAt, 1);
}

function resolveBuyoutCycleCount(termMonths: number, cadence: ScheduleCadence) {
  if (cadence === "MONTHLY") {
    return clampPositiveInt(termMonths, 6);
  }

  if (cadence === "WEEKLY") {
    return Math.max(1, Math.ceil((clampPositiveInt(termMonths, 6) * 30) / 7));
  }

  return Math.max(1, clampPositiveInt(termMonths, 6) * 30);
}

async function assertBikeIsFree(tx: TransactionClient, params: { tenantId: string; bikeId: string }) {
  const [activeRental, activeBuyout] = await Promise.all([
    tx.rental.findFirst({
      where: {
        tenantId: params.tenantId,
        bikeUnitId: params.bikeId,
        status: { in: [...ACTIVE_RENTAL_STATUSES] }
      },
      select: { id: true, dealNumber: true }
    }),
    tx.buyout.findFirst({
      where: {
        tenantId: params.tenantId,
        bikeUnitId: params.bikeId,
        status: { in: [...ACTIVE_BUYOUT_STATUSES] }
      },
      select: { id: true, dealNumber: true }
    })
  ]);

  if (activeRental) {
    throw new HttpError(409, `Этот велосипед уже участвует в аренде ${activeRental.dealNumber}.`);
  }

  if (activeBuyout) {
    throw new HttpError(409, `Этот велосипед уже участвует в выкупе ${activeBuyout.dealNumber}.`);
  }
}

async function resolveUniqueDealNumber(
  tx: TransactionClient,
  params: {
    tenantId: string;
    entity: "rental" | "buyout";
    prefix: string;
  }
) {
  const rows = params.entity === "rental"
    ? await tx.rental.findMany({
        where: {
          tenantId: params.tenantId,
          dealNumber: { startsWith: params.prefix }
        },
        select: { dealNumber: true }
      })
    : await tx.buyout.findMany({
        where: {
          tenantId: params.tenantId,
          dealNumber: { startsWith: params.prefix }
        },
        select: { dealNumber: true }
      });

  let maxNumeric = 0;
  for (const row of rows) {
    const match = row.dealNumber.match(/(\d+)$/);
    const numeric = Number(match?.[1] ?? 0);
    if (Number.isFinite(numeric) && numeric > maxNumeric) {
      maxNumeric = numeric;
    }
  }

  for (let attempt = maxNumeric + 1; attempt < maxNumeric + 5000; attempt += 1) {
    const dealNumber = `${params.prefix}${String(attempt).padStart(6, "0")}`;
    const existing = params.entity === "rental"
      ? await tx.rental.findFirst({
          where: { tenantId: params.tenantId, dealNumber },
          select: { id: true }
        })
      : await tx.buyout.findFirst({
          where: { tenantId: params.tenantId, dealNumber },
          select: { id: true }
        });

    if (!existing) {
      return dealNumber;
    }
  }

  throw new HttpError(409, "Не удалось подобрать номер сделки.");
}

async function persistDealEquipment(
  tx: TransactionClient,
  params: {
    tenantId: string;
    rentalId?: string;
    buyoutId?: string;
    items: CreateDealEquipmentInput[] | undefined;
  }
) {
  const normalizedItems = normalizeEquipmentItems(params.items);
  if (normalizedItems.length === 0) {
    return [];
  }

  const catalogIds = normalizedItems
    .map((item) => item.catalogItemId)
    .filter((value): value is string => Boolean(value));

  const catalogRows = catalogIds.length > 0
    ? await tx.equipmentCatalogItem.findMany({
        where: {
          tenantId: params.tenantId,
          id: {
            in: catalogIds
          }
        },
        select: {
          id: true,
          type: true,
          label: true
        }
      })
    : [];

  const catalogMap = new Map(catalogRows.map((item) => [item.id, item]));
  const createData = normalizedItems.map((item) => {
    const catalogItem = item.catalogItemId ? catalogMap.get(item.catalogItemId) ?? null : null;

    return {
      tenantId: params.tenantId,
      rentalId: params.rentalId ?? null,
      buyoutId: params.buyoutId ?? null,
      catalogItemId: catalogItem?.id ?? null,
      type: catalogItem?.type ?? item.type,
      label: catalogItem?.label ?? item.label,
      quantity: item.quantity,
      comment: item.comment
    };
  });

  await tx.dealEquipmentItem.createMany({
    data: createData
  });

  return createData;
}

export async function createRentalDeal(params: {
  tenantSlug: string;
  clientId: string;
  bikeId: string;
  durationDays: number;
  equipment?: CreateDealEquipmentInput[];
  startsAt?: string | null;
  bankId?: string | null;
  comment?: string | null;
  actor?: CurrentActor | null;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  // UI only submits deal intent; backend creates tariff snapshots, rebuilds schedule and refreshes client debt in one transaction.
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const startsAt = parseDealDate(params.startsAt);

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.findFirst({
      where: {
        id: params.clientId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        fullName: true,
        primaryPhone: true,
        telegramHandle: true
      }
    });

    if (!client) {
      throw new HttpError(404, "Клиент не найден.");
    }

    const bike = await tx.bikeUnit.findFirst({
      where: {
        id: params.bikeId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        branchId: true,
        title: true,
        status: true,
        rentalTariffGroup: {
          select: {
            id: true,
            code: true,
            name: true,
            depositTargetKopecks: true,
            autoPenaltyEnabled: true,
            autoPenaltyDailyKopecks: true,
            graceDays: true,
            rates: {
              orderBy: { durationDays: "asc" },
              select: {
                id: true,
                label: true,
                durationDays: true,
                amountKopecks: true
              }
            }
          }
        }
      }
    });

    if (!bike) {
      throw new HttpError(404, "Велосипед не найден.");
    }

    assertActorBranchAccess(params.actor, "rentals.create", bike.branchId);

    if (bike.status !== BikeStatus.AVAILABLE) {
      throw new HttpError(409, "Этот велосипед сейчас нельзя выдать.");
    }

    if (!bike.rentalTariffGroup) {
      throw new HttpError(422, "У велосипеда не закреплена группа аренды.");
    }

    const rate = bike.rentalTariffGroup.rates.find((row) => row.durationDays === clampPositiveInt(params.durationDays, 7));
    if (!rate) {
      throw new HttpError(422, "Для этого велосипеда нет выбранной ставки аренды.");
    }

    await assertBikeIsFree(tx, {
      tenantId: tenant.id,
      bikeId: bike.id
    });

    let bankId: string | null = null;
    if (params.bankId?.trim()) {
      const bank = await tx.bank.findFirst({
        where: {
          id: params.bankId.trim(),
          tenantId: tenant.id,
          isActive: true
        },
        select: { id: true }
      });

      if (!bank) {
        throw new HttpError(404, "Банк не найден.");
      }

      bankId = bank.id;
    }

    const dealNumber = await resolveUniqueDealNumber(tx, {
      tenantId: tenant.id,
      entity: "rental",
      prefix: "AR-"
    });

    const rental = await tx.rental.create({
      data: {
        tenantId: tenant.id,
        branchId: bike.branchId,
        clientId: client.id,
        bikeUnitId: bike.id,
        createdById: params.actorUserId ?? null,
        dealNumber,
        status: RentalStatus.NEW,
        tariffCode: `${bike.rentalTariffGroup.code}-${rate.durationDays}`,
        tariffLabel: rate.label,
        startsAt,
        nextPaymentAt: computeRentalNextPaymentAt(startsAt, rate.durationDays),
        plannedPaymentKopecks: rate.amountKopecks,
        debtKopecks: 0,
        overdueDays: 0,
        depositTargetKopecks: bike.rentalTariffGroup.depositTargetKopecks,
        autoPenaltyEnabled: bike.rentalTariffGroup.autoPenaltyEnabled,
        manualPenaltyEnabled: true,
        autoPenaltyDailyKopecks: bike.rentalTariffGroup.autoPenaltyDailyKopecks,
        graceDays: bike.rentalTariffGroup.graceDays,
        bankId,
        comment: params.comment?.trim() || null
      },
      select: {
        id: true,
        dealNumber: true,
        tenantId: true,
        clientId: true,
        status: true,
        startsAt: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        graceDays: true,
        tariffCode: true,
        tariffLabel: true
      }
    });

    await replaceRentalTariffSnapshots(tx, {
      tenantId: tenant.id,
      rentalId: rental.id,
      tariffGroupCode: bike.rentalTariffGroup.code,
      rates: bike.rentalTariffGroup.rates
    });

    await rebuildRentalSchedule({
      tx,
      rental,
      cycles: []
    });

    const persistedEquipment = await persistDealEquipment(tx, {
      tenantId: tenant.id,
      rentalId: rental.id,
      items: params.equipment
    });

    await tx.bikeUnit.update({
      where: { id: bike.id },
      data: {
        status: BikeStatus.RENTED,
        currentClientId: client.id,
        lastIssuedAt: startsAt
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: client.id
    });

    const notification = await queueDealCreatedTelegramInstruction(tx, {
      tenantId: tenant.id,
      client,
      rentalId: rental.id,
      dealNumber: rental.dealNumber,
      bankId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "created",
        newValueText: JSON.stringify({
          dealNumber: rental.dealNumber,
          clientId: client.id,
          bikeId: bike.id,
          tariffLabel: rate.label,
          amountKopecks: rate.amountKopecks,
          equipment: persistedEquipment.map((item) => ({
            type: item.type,
            label: item.label,
            quantity: item.quantity
          }))
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: rental.id,
        kind: "RENTAL" as const,
        detailHref: `/rentals/${rental.id}`,
        dealNumber: rental.dealNumber
      },
      notification
    };
  });

  triggerQueuedTelegramNotificationDispatch(result.notification?.status === "QUEUED" ? result.notification.id : null);
  return {
    tenant: result.tenant,
    deal: result.deal
  };
}

export async function createBuyoutDeal(params: {
  tenantSlug: string;
  clientId: string;
  bikeId: string;
  paymentCadence: ScheduleCadence;
  equipment?: CreateDealEquipmentInput[];
  startsAt?: string | null;
  bankId?: string | null;
  comment?: string | null;
  actor?: CurrentActor | null;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  // Buyout creation also owns initial financed amount, first schedule build and client snapshot refresh inside the transaction.
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const startsAt = parseDealDate(params.startsAt);
  const cadence = params.paymentCadence === "MONTHLY" ? "MONTHLY" : "WEEKLY";

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.findFirst({
      where: {
        id: params.clientId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        fullName: true,
        primaryPhone: true,
        telegramHandle: true
      }
    });

    if (!client) {
      throw new HttpError(404, "Клиент не найден.");
    }

    const bike = await tx.bikeUnit.findFirst({
      where: {
        id: params.bikeId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        branchId: true,
        title: true,
        status: true,
        buyoutTariffGroup: {
          select: {
            id: true,
            code: true,
            name: true,
            depositTargetKopecks: true,
            autoPenaltyEnabled: true,
            autoPenaltyDailyKopecks: true,
            graceDays: true,
            rates: {
              orderBy: { durationDays: "asc" },
              select: {
                id: true,
                label: true,
                durationDays: true,
                amountKopecks: true
              }
            }
          }
        }
      }
    });

    if (!bike) {
      throw new HttpError(404, "Велосипед не найден.");
    }

    assertActorBranchAccess(params.actor, "buyouts.create", bike.branchId);

    if (bike.status !== BikeStatus.AVAILABLE) {
      throw new HttpError(409, "Этот велосипед сейчас нельзя оформить в выкуп.");
    }

    if (!bike.buyoutTariffGroup) {
      throw new HttpError(422, "У велосипеда не закреплена группа выкупа.");
    }

    const targetDuration = cadence === "MONTHLY" ? 30 : 7;
    const rate = bike.buyoutTariffGroup.rates.find((row) => row.durationDays === targetDuration);
    if (!rate) {
      throw new HttpError(422, "Для этого велосипеда нет подходящей ставки выкупа.");
    }

    await assertBikeIsFree(tx, {
      tenantId: tenant.id,
      bikeId: bike.id
    });

    let bankId: string | null = null;
    if (params.bankId?.trim()) {
      const bank = await tx.bank.findFirst({
        where: {
          id: params.bankId.trim(),
          tenantId: tenant.id,
          isActive: true
        },
        select: { id: true }
      });

      if (!bank) {
        throw new HttpError(404, "Банк не найден.");
      }

      bankId = bank.id;
    }

    const termMonths = 6;
    const cycleCount = resolveBuyoutCycleCount(termMonths, cadence);
    const totalPriceKopecks = rate.amountKopecks * cycleCount;
    const financedAmountKopecks = clampMoney(totalPriceKopecks);

    const dealNumber = await resolveUniqueDealNumber(tx, {
      tenantId: tenant.id,
      entity: "buyout",
      prefix: "VY-"
    });

    const buyout = await tx.buyout.create({
      data: {
        tenantId: tenant.id,
        branchId: bike.branchId,
        clientId: client.id,
        bikeUnitId: bike.id,
        createdById: params.actorUserId ?? null,
        dealNumber,
        status: BuyoutStatus.NEW,
        termMonths,
        paymentCadence: cadence,
        totalPriceKopecks,
        downPaymentKopecks: 0,
        financedAmountKopecks,
        residualDebtKopecks: financedAmountKopecks,
        overdueDays: 0,
        depositTargetKopecks: bike.buyoutTariffGroup.depositTargetKopecks,
        autoPenaltyEnabled: bike.buyoutTariffGroup.autoPenaltyEnabled,
        manualPenaltyEnabled: true,
        autoPenaltyDailyKopecks: bike.buyoutTariffGroup.autoPenaltyDailyKopecks,
        graceDays: bike.buyoutTariffGroup.graceDays,
        startsAt,
        nextPaymentAt: computeBuyoutNextPaymentAt(startsAt, cadence),
        bankId,
        comment: params.comment?.trim() || null
      },
      select: {
        id: true,
        dealNumber: true,
        tenantId: true,
        status: true,
        startsAt: true,
        nextPaymentAt: true,
        termMonths: true,
        paymentCadence: true,
        financedAmountKopecks: true,
        residualDebtKopecks: true
      }
    });

    await rebuildBuyoutSchedule({
      tx,
      buyout,
      presets: bike.buyoutTariffGroup.rates.map((groupRate) => ({
        amountKopecks: groupRate.amountKopecks,
        intervalUnit: groupRate.durationDays >= 30 ? "months" : "days",
        intervalValue: groupRate.durationDays >= 30 ? Math.max(1, Math.trunc(groupRate.durationDays / 30)) : groupRate.durationDays
      }))
    });

    const persistedEquipment = await persistDealEquipment(tx, {
      tenantId: tenant.id,
      buyoutId: buyout.id,
      items: params.equipment
    });

    await tx.bikeUnit.update({
      where: { id: bike.id },
      data: {
        status: BikeStatus.BUYOUT,
        currentClientId: client.id,
        lastIssuedAt: startsAt
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: client.id
    });

    const notification = await queueDealCreatedTelegramInstruction(tx, {
      tenantId: tenant.id,
      client,
      buyoutId: buyout.id,
      dealNumber: buyout.dealNumber,
      bankId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "buyout",
        entityId: buyout.id,
        action: "created",
        newValueText: JSON.stringify({
          dealNumber: buyout.dealNumber,
          clientId: client.id,
          bikeId: bike.id,
          cadence,
          cycleAmountKopecks: rate.amountKopecks,
          totalPriceKopecks,
          equipment: persistedEquipment.map((item) => ({
            type: item.type,
            label: item.label,
            quantity: item.quantity
          }))
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: buyout.id,
        kind: "BUYOUT" as const,
        detailHref: `/buyouts/${buyout.id}`,
        dealNumber: buyout.dealNumber
      },
      notification
    };
  });

  triggerQueuedTelegramNotificationDispatch(result.notification?.status === "QUEUED" ? result.notification.id : null);
  return {
    tenant: result.tenant,
    deal: result.deal
  };
}
