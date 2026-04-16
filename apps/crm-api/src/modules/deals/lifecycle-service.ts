import {
  BikeStatus,
  BuyoutStatus,
  RentalStatus,
  ScheduleCadence,
  type Prisma,
  type ScheduleItemStatus
} from "@prisma/client";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { refreshClientSnapshot } from "../finance/service.js";
import { ensureRentalTariffSnapshots } from "./rental-tariff-snapshot-service.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";

type TransactionClient = Prisma.TransactionClient;
type MutableScheduleItem = {
  id?: string;
  sequenceNumber: number;
  dueAt: Date;
  amountKopecks: number;
  paidKopecks: number;
  status: ScheduleItemStatus;
  closedAt: Date | null;
  isNew?: boolean;
};

function clampMoney(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.trunc(numeric));
}

function computeActivePenaltyBalance(penalties: Array<{ amountKopecks: number }>) {
  return penalties.reduce((sum, penalty) => sum + clampMoney(penalty.amountKopecks), 0);
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

function shiftByCadence(date: Date, cadence: ScheduleCadence, intervalValue: number) {
  const normalizedInterval = Math.max(1, Math.trunc(intervalValue || 1));

  if (cadence === "MONTHLY") {
    return addMonthsUtc(date, normalizedInterval);
  }

  if (cadence === "WEEKLY") {
    return addDaysUtc(date, normalizedInterval * 7);
  }

  return addDaysUtc(date, normalizedInterval);
}

function diffDaysByYmd(laterYmd: string, earlier: Date) {
  const laterDate = parseYmdUtcNoon(laterYmd);
  const earlierDate = parseYmdUtcNoon(earlier.toISOString().slice(0, 10));
  const delta = laterDate.getTime() - earlierDate.getTime();
  return Math.max(0, Math.floor(delta / 86_400_000));
}

function outstandingKopecks(item: { amountKopecks: number; paidKopecks: number }) {
  return Math.max(0, clampMoney(item.amountKopecks) - clampMoney(item.paidKopecks));
}

function resolveScheduleItemStatus(item: { dueAt: Date; amountKopecks: number; paidKopecks: number }) {
  const amountKopecks = clampMoney(item.amountKopecks);
  const paidKopecks = Math.min(amountKopecks, clampMoney(item.paidKopecks));
  const outstanding = Math.max(0, amountKopecks - paidKopecks);

  if (outstanding <= 0) {
    return "PAID" as const;
  }

  const today = parseYmdUtcNoon(formatTodayYmdMoscow()).getTime();
  const dueTime = parseYmdUtcNoon(item.dueAt.toISOString().slice(0, 10)).getTime();

  if (dueTime < today) {
    return "OVERDUE" as const;
  }

  if (paidKopecks > 0) {
    return "PARTIAL" as const;
  }

  return "PLANNED" as const;
}

function updateStatuses(items: MutableScheduleItem[]) {
  return items.map((item) => {
    const status = resolveScheduleItemStatus(item);
    return {
      ...item,
      status,
      closedAt: outstandingKopecks(item) === 0 ? item.closedAt ?? item.dueAt : null
    };
  });
}

function getNextOutstanding(items: MutableScheduleItem[]) {
  return items
    .filter((item) => outstandingKopecks(item) > 0)
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0] ?? null;
}

function computeRentalDebt(items: MutableScheduleItem[]) {
  const today = formatTodayYmdMoscow();
  return items.reduce((sum, item) => {
    if (outstandingKopecks(item) <= 0) {
      return sum;
    }

    const dueYmd = item.dueAt.toISOString().slice(0, 10);
    return dueYmd <= today ? sum + outstandingKopecks(item) : sum;
  }, 0);
}

function computeOverdueDays(items: MutableScheduleItem[]) {
  const today = formatTodayYmdMoscow();
  const firstOverdue = items
    .filter((item) => outstandingKopecks(item) > 0 && resolveScheduleItemStatus(item) === "OVERDUE")
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0];

  return firstOverdue ? diffDaysByYmd(today, firstOverdue.dueAt) : 0;
}

function resolveCadenceFromDays(days: number) {
  const normalizedDays = Math.max(1, Math.trunc(days || 1));

  if (normalizedDays >= 30 && normalizedDays % 30 === 0) {
    return {
      cadence: "MONTHLY" as const,
      intervalValue: Math.max(1, Math.trunc(normalizedDays / 30))
    };
  }

  if (normalizedDays >= 7 && normalizedDays % 7 === 0) {
    return {
      cadence: "WEEKLY" as const,
      intervalValue: Math.max(1, Math.trunc(normalizedDays / 7))
    };
  }

  return {
    cadence: "DAILY" as const,
    intervalValue: normalizedDays
  };
}

function resolveRentalStatusAfterScheduleChange(currentStatus: RentalStatus, overdueDays: number) {
  // HOLD and RETURN_PREP are operational states and should survive schedule recalculation untouched.
  if (currentStatus === RentalStatus.HOLD || currentStatus === RentalStatus.RETURN_PREP) {
    return currentStatus;
  }

  if (currentStatus === RentalStatus.NEW && overdueDays <= 0) {
    return RentalStatus.NEW;
  }

  return overdueDays > 0 ? RentalStatus.OVERDUE : RentalStatus.ACTIVE;
}

async function persistScheduleItems(tx: TransactionClient, params: {
  tenantId: string;
  scheduleId: string;
  items: MutableScheduleItem[];
}) {
  const existingIds = params.items
    .map((item) => item.id)
    .filter((value): value is string => Boolean(value));

  await tx.paymentScheduleItem.deleteMany({
    where: {
      tenantId: params.tenantId,
      paymentScheduleId: params.scheduleId,
      ...(existingIds.length > 0 ? { id: { notIn: existingIds } } : {})
    }
  });

  for (const item of params.items) {
    if (item.id) {
      await tx.paymentScheduleItem.update({
        where: {
          id: item.id
        },
        data: {
          sequenceNumber: item.sequenceNumber,
          dueAt: item.dueAt,
          amountKopecks: item.amountKopecks,
          paidKopecks: item.paidKopecks,
          status: item.status,
          closedAt: item.closedAt
        }
      });
      continue;
    }

    await tx.paymentScheduleItem.create({
      data: {
        tenantId: params.tenantId,
        paymentScheduleId: params.scheduleId,
        sequenceNumber: item.sequenceNumber,
        dueAt: item.dueAt,
        amountKopecks: item.amountKopecks,
        paidKopecks: item.paidKopecks,
        status: item.status,
        closedAt: item.closedAt
      }
    });
  }
}

async function clearScheduleNextDueAt(tx: TransactionClient, params: {
  tenantId: string;
  ownerType: "RENTAL" | "BUYOUT";
  ownerId: string;
}) {
  await tx.paymentSchedule.updateMany({
    where: {
      tenantId: params.tenantId,
      ...(params.ownerType === "RENTAL" ? { rentalId: params.ownerId } : { buyoutId: params.ownerId })
    },
    data: {
      nextDueAt: null
    }
  });
}

export async function extendRentalDeal(params: {
  tenantSlug: string;
  rentalId: string;
  durationDays: number;
  actorUserId?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  // Extension mutates the existing schedule instead of posting money so prepayments and overdue state stay coherent.
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const durationDays = Math.max(1, Math.trunc(params.durationDays || 0));

  return prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        dealNumber: true,
        status: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        debtKopecks: true,
        overdueDays: true,
        paymentSchedules: {
          orderBy: {
            createdAt: "desc"
          },
          take: 1,
          select: {
            id: true,
            cadence: true,
            intervalValue: true,
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
        }
      }
    });

    if (!rental) {
      throw new HttpError(404, "Аренда не найдена.");
    }

    if (rental.status === RentalStatus.COMPLETED || rental.status === RentalStatus.CANCELED) {
      throw new HttpError(409, "Эту аренду уже нельзя продлить.");
    }

    const snapshotRates = await ensureRentalTariffSnapshots(tx, {
      tenantId: tenant.id,
      rentalId: rental.id
    });

    const rate = snapshotRates.find((item) => item.durationDays === durationDays);
    if (!rate) {
      throw new HttpError(422, "Для этой аренды нет сохраненной ставки продления.");
    }

    const schedule = rental.paymentSchedules[0];
    if (!schedule) {
      throw new HttpError(409, "У аренды пока нет графика платежей.");
    }

    const items = schedule.items.map((item) => ({
      id: item.id,
      sequenceNumber: item.sequenceNumber,
      dueAt: item.dueAt,
      amountKopecks: item.amountKopecks,
      paidKopecks: item.paidKopecks,
      status: item.status,
      closedAt: item.closedAt
    }));

    const openItems = items
      .filter((item) => outstandingKopecks(item) > 0)
      .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());

    if (openItems.length > 1) {
      throw new HttpError(409, "Сначала выровняйте предоплату: вперед уже есть несколько открытых циклов.");
    }

    let targetItem = openItems[0] ?? null;
    const cadence = resolveCadenceFromDays(rate.durationDays);

    if (targetItem && clampMoney(targetItem.paidKopecks) > clampMoney(rate.amountKopecks)) {
      throw new HttpError(409, "Новая ставка меньше уже оплаченной суммы по ближайшему циклу.");
    }

    if (!targetItem) {
      const lastItem = items[items.length - 1] ?? null;
      const dueAt = lastItem
        ? shiftByCadence(lastItem.dueAt, schedule.cadence, schedule.intervalValue)
        : rental.nextPaymentAt ?? new Date();

      targetItem = {
        sequenceNumber: lastItem ? lastItem.sequenceNumber + 1 : 1,
        dueAt,
        amountKopecks: rate.amountKopecks,
        paidKopecks: 0,
        status: "PLANNED",
        closedAt: null,
        isNew: true
      };
      items.push(targetItem);
    } else {
      targetItem.amountKopecks = rate.amountKopecks;
    }

    const normalizedItems = updateStatuses(items);
    const nextOutstanding = getNextOutstanding(normalizedItems);
    const debtKopecks = computeRentalDebt(normalizedItems);
    const overdueDays = computeOverdueDays(normalizedItems);
    const plannedPaymentKopecks = nextOutstanding
      ? outstandingKopecks(nextOutstanding)
      : rate.amountKopecks;

    await persistScheduleItems(tx, {
      tenantId: tenant.id,
      scheduleId: schedule.id,
      items: normalizedItems
    });

    await tx.paymentSchedule.update({
      where: {
        id: schedule.id
      },
      data: {
        cadence: cadence.cadence,
        intervalValue: cadence.intervalValue,
        cycleAmountKopecks: rate.amountKopecks,
        nextDueAt: nextOutstanding?.dueAt ?? null
      }
    });

    await tx.rental.update({
      where: {
        id: rental.id
      },
      data: {
        status: resolveRentalStatusAfterScheduleChange(rental.status, overdueDays),
        tariffCode: rate.tariffCode,
        tariffLabel: rate.label,
        nextPaymentAt: nextOutstanding?.dueAt ?? null,
        plannedPaymentKopecks,
        debtKopecks,
        overdueDays
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: rental.clientId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "extended",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          tariffLabel: rate.label,
          durationDays: rate.durationDays,
          amountKopecks: rate.amountKopecks
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber,
        status: resolveRentalStatusAfterScheduleChange(rental.status, overdueDays),
        tariffLabel: rate.label,
        durationDays: rate.durationDays,
        nextPaymentAt: nextOutstanding?.dueAt ?? null,
        plannedPaymentKopecks
      }
    };
  });
}

export async function completeRentalReturn(params: {
  tenantSlug: string;
  rentalId: string;
  actorUserId?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  return prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        bikeUnitId: true,
        dealNumber: true,
        status: true,
        debtKopecks: true,
        penalties: {
          where: {
            status: "ACTIVE"
          },
          select: {
            amountKopecks: true
          }
        }
      }
    });

    if (!rental) {
      throw new HttpError(404, "Аренда не найдена.");
    }

    if (rental.status === RentalStatus.COMPLETED || rental.status === RentalStatus.CANCELED) {
      throw new HttpError(409, "Эта аренда уже закрыта.");
    }

    const activePenaltyBalanceKopecks = computeActivePenaltyBalance(rental.penalties);
    if (clampMoney(rental.debtKopecks) > 0 || activePenaltyBalanceKopecks > 0) {
      throw new HttpError(409, "Нельзя завершить аренду, пока есть долг или активные штрафы.");
    }

    await tx.rental.update({
      where: {
        id: rental.id
      },
      data: {
        status: RentalStatus.COMPLETED,
        nextPaymentAt: null,
        overdueDays: 0,
        comment: params.comment?.trim() || undefined
      }
    });

    await clearScheduleNextDueAt(tx, {
      tenantId: tenant.id,
      ownerType: "RENTAL",
      ownerId: rental.id
    });

    await tx.bikeUnit.update({
      where: {
        id: rental.bikeUnitId
      },
      data: {
        status: BikeStatus.AVAILABLE,
        currentClientId: null
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: rental.clientId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "returned",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          status: RentalStatus.COMPLETED,
          bikeStatus: BikeStatus.AVAILABLE
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber,
        status: RentalStatus.COMPLETED
      }
    };
  });
}

export async function closeBuyoutDeal(params: {
  tenantSlug: string;
  buyoutId: string;
  actorUserId?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  return prisma.$transaction(async (tx) => {
    const buyout = await tx.buyout.findFirst({
      where: {
        id: params.buyoutId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        bikeUnitId: true,
        dealNumber: true,
        status: true,
        residualDebtKopecks: true,
        penalties: {
          where: {
            status: "ACTIVE"
          },
          select: {
            amountKopecks: true
          }
        }
      }
    });

    if (!buyout) {
      throw new HttpError(404, "Выкуп не найден.");
    }

    if (buyout.status === BuyoutStatus.CLOSED || buyout.status === BuyoutStatus.TERMINATED) {
      throw new HttpError(409, "Этот выкуп уже закрыт.");
    }

    const activePenaltyBalanceKopecks = computeActivePenaltyBalance(buyout.penalties);
    if (clampMoney(buyout.residualDebtKopecks) > 0 || activePenaltyBalanceKopecks > 0) {
      throw new HttpError(409, "Нельзя закрыть выкуп, пока есть остаток долга или активные штрафы.");
    }

    await tx.buyout.update({
      where: {
        id: buyout.id
      },
      data: {
        status: BuyoutStatus.CLOSED,
        nextPaymentAt: null,
        overdueDays: 0,
        comment: params.comment?.trim() || undefined
      }
    });

    await clearScheduleNextDueAt(tx, {
      tenantId: tenant.id,
      ownerType: "BUYOUT",
      ownerId: buyout.id
    });

    await tx.bikeUnit.update({
      where: {
        id: buyout.bikeUnitId
      },
      data: {
        status: BikeStatus.WRITTEN_OFF,
        currentClientId: null
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: buyout.clientId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "buyout",
        entityId: buyout.id,
        action: "closed",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          status: BuyoutStatus.CLOSED,
          bikeStatus: BikeStatus.WRITTEN_OFF
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: buyout.id,
        dealNumber: buyout.dealNumber,
        status: BuyoutStatus.CLOSED
      }
    };
  });
}

export async function setRentalProblemFlag(params: {
  tenantSlug: string;
  rentalId: string;
  isProblem: boolean;
  actorUserId?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  return prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        dealNumber: true,
        isProblem: true
      }
    });

    if (!rental) {
      throw new HttpError(404, "Аренда не найдена.");
    }

    const nextValue = Boolean(params.isProblem);
    if (rental.isProblem === nextValue) {
      return {
        tenant,
        deal: {
          id: rental.id,
          dealNumber: rental.dealNumber,
          isProblem: rental.isProblem
        }
      };
    }

    await tx.rental.update({
      where: {
        id: rental.id
      },
      data: {
        isProblem: nextValue
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: nextValue ? "problem_marked" : "problem_cleared",
        reason: params.comment?.trim() || null,
        oldValueText: JSON.stringify({
          isProblem: rental.isProblem
        }, null, 2),
        newValueText: JSON.stringify({
          isProblem: nextValue
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber,
        isProblem: nextValue
      }
    };
  });
}

export async function setBuyoutProblemFlag(params: {
  tenantSlug: string;
  buyoutId: string;
  isProblem: boolean;
  actorUserId?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  return prisma.$transaction(async (tx) => {
    const buyout = await tx.buyout.findFirst({
      where: {
        id: params.buyoutId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        dealNumber: true,
        isProblem: true
      }
    });

    if (!buyout) {
      throw new HttpError(404, "Выкуп не найден.");
    }

    const nextValue = Boolean(params.isProblem);
    if (buyout.isProblem === nextValue) {
      return {
        tenant,
        deal: {
          id: buyout.id,
          dealNumber: buyout.dealNumber,
          isProblem: buyout.isProblem
        }
      };
    }

    await tx.buyout.update({
      where: {
        id: buyout.id
      },
      data: {
        isProblem: nextValue
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "buyout",
        entityId: buyout.id,
        action: nextValue ? "problem_marked" : "problem_cleared",
        reason: params.comment?.trim() || null,
        oldValueText: JSON.stringify({
          isProblem: buyout.isProblem
        }, null, 2),
        newValueText: JSON.stringify({
          isProblem: nextValue
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: buyout.id,
        dealNumber: buyout.dealNumber,
        isProblem: nextValue
      }
    };
  });
}
