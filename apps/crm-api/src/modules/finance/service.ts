import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  BuyoutStatus,
  PaymentMethod,
  TransactionCorrectionKind,
  RentalStatus,
  ScheduleItemStatus,
  TransactionDirection,
  TransactionStatus,
  TransactionType
} from "@prisma/client";
import { actorHasPermission, assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../core/http/errors.js";
import type { CurrentActor } from "../../core/auth/request-context.js";
import { queueTelegramNextPaymentAfterConfirmation } from "../notifications/service.js";
import { triggerQueuedTelegramNotificationDispatch } from "../notifications/telegram.js";
import type { TenantRef } from "../tenants/runtime.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";
import {
  backfillSystemTransactionArticles,
  ensureFinanceArticles,
  resolveSystemArticleAssignment
} from "./articles.js";

type TransactionClient = Prisma.TransactionClient;

interface BankRef {
  id: string;
  name: string;
  instructionType: string;
}

interface ScheduleItemSnapshot {
  id?: string;
  sequenceNumber: number;
  dueAt: Date;
  amountKopecks: number;
  paidKopecks: number;
  status: ScheduleItemStatus;
  closedAt: Date | null;
  isNew?: boolean;
}

const FINANCIAL_TRANSACTION_ROW_SELECT = Prisma.validator<Prisma.FinancialTransactionSelect>()({
  // Shared row shape for finance registry and reverse/reconcile UI. Keep it aligned with operator-facing screens.
  id: true,
  type: true,
  direction: true,
  status: true,
  correctionKind: true,
  reversalOfTransactionId: true,
  reversalReason: true,
  reconciledAt: true,
  reconciliationNote: true,
  paymentMethod: true,
  amountKopecks: true,
  happenedAt: true,
  postedAt: true,
  comment: true,
  sourceLabel: true,
  externalReference: true,
  articleNameSnapshot: true,
  articleDirectionSnapshot: true,
  createdBy: {
    select: {
      id: true,
      fullName: true
    }
  },
  reconciledBy: {
    select: {
      id: true,
      fullName: true
    }
  },
  client: {
    select: {
      id: true,
      fullName: true
    }
  },
  rental: {
    select: {
      id: true,
      dealNumber: true
    }
  },
  buyout: {
    select: {
      id: true,
      dealNumber: true
    }
  },
  bank: {
    select: {
      id: true,
      name: true
    }
  },
  branch: {
    select: {
      id: true,
      name: true,
      code: true
    }
  },
  article: {
    select: {
      id: true,
      name: true,
      systemKey: true,
      direction: true,
      isActive: true,
      isSystem: true
    }
  },
  reversalOfTransaction: {
    select: {
      id: true,
      type: true,
      direction: true,
      amountKopecks: true,
      happenedAt: true
    }
  },
  reversedByTransaction: {
    select: {
      id: true,
      type: true,
      direction: true,
      amountKopecks: true,
      happenedAt: true
    }
  }
});

function clampMoney(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.trunc(numeric));
}

function parseOptionalDate(input: string | null | undefined) {
  const value = input?.trim();
  return value ? new Date(value) : new Date();
}

function getOppositeDirection(direction: TransactionDirection): TransactionDirection {
  return direction === "INCOME" ? "EXPENSE" : "INCOME";
}

function buildReversalArticleSnapshotName(name: string | null | undefined) {
  const normalized = name?.trim();
  return normalized ? `Сторно · ${normalized}` : "Сторно";
}

function resolveReversalPermissionCode(type: TransactionType) {
  switch (type) {
    case "MANUAL_ADJUSTMENT":
      return "finance.reverse_manual" as const;
    case "PENALTY_PAYMENT_IN":
      return "finance.reverse_penalty" as const;
    default:
      return null;
  }
}

function assertSupportedReversalTransaction(params: {
  type: TransactionType;
  status: TransactionStatus;
  correctionKind: TransactionCorrectionKind;
  reversalOfTransactionId: string | null;
  reversedByTransactionId: string | null;
}) {
  if (!resolveReversalPermissionCode(params.type)) {
    throw new HttpError(409, "Для этого типа денежной операции reversal пока не поддерживается.");
  }

  if (params.status !== "POSTED") {
    throw new HttpError(409, "Сторнировать можно только проведенную денежную операцию.");
  }

  if (params.correctionKind === "REVERSAL" || params.reversalOfTransactionId) {
    throw new HttpError(409, "Reversal нельзя строить поверх уже корректирующей транзакции.");
  }

  if (params.reversedByTransactionId) {
    throw new HttpError(409, "Для этой денежной операции reversal уже был создан.");
  }
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
    // ignore formatter edge cases
  }

  return new Date().toISOString().slice(0, 10);
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

function shiftByCadence(date: Date, cadence: "DAILY" | "WEEKLY" | "MONTHLY", intervalValue: number) {
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
  const delta = laterDate.getTime() - parseYmdUtcNoon(earlier.toISOString().slice(0, 10)).getTime();
  return Math.max(0, Math.floor(delta / 86_400_000));
}

function resolveScheduleItemStatus(item: { dueAt: Date; amountKopecks: number; paidKopecks: number }) {
  const amountKopecks = clampMoney(item.amountKopecks);
  const paidKopecks = Math.min(amountKopecks, clampMoney(item.paidKopecks));
  const outstandingKopecks = Math.max(0, amountKopecks - paidKopecks);

  if (outstandingKopecks <= 0) {
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

function outstandingKopecks(item: { amountKopecks: number; paidKopecks: number }) {
  return Math.max(0, clampMoney(item.amountKopecks) - clampMoney(item.paidKopecks));
}

function computeRentalDebt(items: ScheduleItemSnapshot[]) {
  const today = formatTodayYmdMoscow();
  return items.reduce((sum, item) => {
    if (outstandingKopecks(item) <= 0) {
      return sum;
    }

    const dueYmd = item.dueAt.toISOString().slice(0, 10);
    return dueYmd <= today ? sum + outstandingKopecks(item) : sum;
  }, 0);
}

function computeOverdueDays(items: ScheduleItemSnapshot[]) {
  const today = formatTodayYmdMoscow();
  const firstOverdue = items
    .filter((item) => outstandingKopecks(item) > 0 && resolveScheduleItemStatus(item) === "OVERDUE")
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0];

  return firstOverdue ? diffDaysByYmd(today, firstOverdue.dueAt) : 0;
}

function getNextOutstanding(items: ScheduleItemSnapshot[]) {
  return items
    .filter((item) => outstandingKopecks(item) > 0)
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0] ?? null;
}

function updateStatuses(items: ScheduleItemSnapshot[]): ScheduleItemSnapshot[] {
  return items.map((item) => {
    const status = resolveScheduleItemStatus(item);
    return {
      ...item,
      status,
      closedAt: outstandingKopecks(item) === 0 ? item.closedAt ?? item.dueAt : null
    };
  });
}

async function resolveBank(params: {
  tx: TransactionClient;
  tenantId: string;
  bankId: string | null;
  paymentMethod: PaymentMethod;
}): Promise<BankRef | null> {
  if (params.paymentMethod !== "BANK") {
    return null;
  }

  const bankId = params.bankId?.trim();
  if (!bankId) {
    throw new HttpError(422, "Для перевода выберите банк из раздела «Банки».");
  }

  const bank = await params.tx.bank.findFirst({
    where: {
      id: bankId,
      tenantId: params.tenantId,
      isActive: true
    },
    select: {
      id: true,
      name: true,
      instructionType: true
    }
  });

  if (!bank) {
    throw new HttpError(404, "Выбранный банк не найден среди активных банков CRM.");
  }

  return bank;
}

async function resolveFinanceBranch(params: {
  tx: TransactionClient;
  tenantId: string;
  branchId: string;
}) {
  const branchId = params.branchId.trim();
  if (!branchId) {
    throw new HttpError(422, "Для ручной операции нужно выбрать точку.");
  }

  const branch = await params.tx.branch.findFirst({
    where: {
      id: branchId,
      tenantId: params.tenantId,
      isActive: true
    },
    select: {
      id: true,
      name: true,
      code: true
    }
  });

  if (!branch) {
    throw new HttpError(404, `Точка '${branchId}' не найдена.`);
  }

  return branch;
}

async function resolveFinanceClient(params: {
  tx: TransactionClient;
  tenantId: string;
  clientId?: string | null;
}) {
  const clientId = params.clientId?.trim();
  if (!clientId) {
    return null;
  }

  const client = await params.tx.client.findFirst({
    where: {
      id: clientId,
      tenantId: params.tenantId
    },
    select: {
      id: true,
      fullName: true,
      branchId: true
    }
  });

  if (!client) {
    throw new HttpError(404, `Клиент '${clientId}' не найден.`);
  }

  return client;
}

async function resolveActiveFinanceArticle(params: {
  tx: TransactionClient;
  tenantId: string;
  articleId: string;
  direction: TransactionDirection;
}) {
  const articleId = params.articleId.trim();
  if (!articleId) {
    throw new HttpError(422, "Для ручной операции нужно выбрать статью.");
  }

  const article = await params.tx.financeArticle.findFirst({
    where: {
      id: articleId,
      tenantId: params.tenantId,
      direction: params.direction,
      isActive: true
    },
    select: {
      id: true,
      direction: true,
      name: true,
      isSystem: true
    }
  });

  if (!article) {
    throw new HttpError(404, "Активная статья с таким направлением не найдена.");
  }

  return article;
}

async function createCompensatingReversalTransaction(tx: TransactionClient, params: {
  tenantId: string;
  originalTransaction: {
    id: string;
    branchId: string | null;
    clientId: string | null;
    rentalId: string | null;
    buyoutId: string | null;
    bankId: string | null;
    type: TransactionType;
    direction: TransactionDirection;
    paymentMethod: PaymentMethod;
    amountKopecks: number;
    articleNameSnapshot: string | null;
  };
  actorUserId: string;
  reason: string;
  happenedAt?: string | null;
  sourceLabel: string;
}) {
  // Reversal is stored as its own posted row with opposite direction and a pointer back to the original transaction.
  const direction = getOppositeDirection(params.originalTransaction.direction);

  return tx.financialTransaction.create({
    data: {
      tenantId: params.tenantId,
      branchId: params.originalTransaction.branchId,
      clientId: params.originalTransaction.clientId,
      rentalId: params.originalTransaction.rentalId,
      buyoutId: params.originalTransaction.buyoutId,
      bankId: params.originalTransaction.bankId,
      articleId: null,
      createdById: params.actorUserId,
      type: params.originalTransaction.type,
      direction,
      status: "POSTED",
      correctionKind: "REVERSAL",
      reversalOfTransactionId: params.originalTransaction.id,
      reversalReason: params.reason,
      paymentMethod: params.originalTransaction.paymentMethod,
      amountKopecks: params.originalTransaction.amountKopecks,
      happenedAt: parseOptionalDate(params.happenedAt),
      postedAt: new Date(),
      articleNameSnapshot: buildReversalArticleSnapshotName(params.originalTransaction.articleNameSnapshot),
      articleDirectionSnapshot: direction,
      comment: params.reason,
      sourceLabel: params.sourceLabel,
      externalReference: params.originalTransaction.id
    },
    select: {
      id: true,
      type: true,
      direction: true,
      status: true,
      correctionKind: true,
      reversalOfTransactionId: true,
      reversalReason: true,
      paymentMethod: true,
      amountKopecks: true,
      happenedAt: true,
      postedAt: true,
      comment: true
    }
  });
}

export async function refreshClientSnapshot(tx: TransactionClient, params: { tenantId: string; clientId: string }) {
  // Client counters are derived snapshots, so payment and schedule mutations should refresh them through this helper.
  const [rentals, buyouts, paymentCount] = await Promise.all([
    tx.rental.findMany({
      where: {
        tenantId: params.tenantId,
        clientId: params.clientId
      },
      select: {
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
    }),
    tx.buyout.findMany({
      where: {
        tenantId: params.tenantId,
        clientId: params.clientId
      },
      select: {
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
    }),
    tx.financialTransaction.count({
      where: {
        tenantId: params.tenantId,
        clientId: params.clientId,
        status: "POSTED",
        direction: "INCOME",
        correctionKind: "NONE",
        reversedByTransaction: {
          is: null
        }
      }
    })
  ]);

  const activeRentalStatuses = new Set<RentalStatus>(["NEW", "ACTIVE", "OVERDUE", "HOLD", "RETURN_PREP"]);
  const activeBuyoutStatuses = new Set<BuyoutStatus>(["NEW", "ACTIVE", "OVERDUE", "HOLD"]);
  const overdueRentalStatuses = new Set<RentalStatus>(["OVERDUE"]);
  const overdueBuyoutStatuses = new Set<BuyoutStatus>(["OVERDUE"]);

  const currentDebtKopecks = rentals.reduce(
    (sum, rental) => sum + clampMoney(rental.debtKopecks) + rental.penalties.reduce((penaltiesSum, penalty) => penaltiesSum + clampMoney(penalty.amountKopecks), 0),
    0
  ) + buyouts.reduce(
    (sum, buyout) => sum + clampMoney(buyout.residualDebtKopecks) + buyout.penalties.reduce((penaltiesSum, penalty) => penaltiesSum + clampMoney(penalty.amountKopecks), 0),
    0
  );
  const overdueDebtKopecks = rentals.reduce(
    (sum, rental) => sum + (overdueRentalStatuses.has(rental.status)
      ? clampMoney(rental.debtKopecks) + rental.penalties.reduce((penaltiesSum, penalty) => penaltiesSum + clampMoney(penalty.amountKopecks), 0)
      : 0),
    0
  ) + buyouts.reduce(
    (sum, buyout) => sum + (overdueBuyoutStatuses.has(buyout.status)
      ? clampMoney(buyout.residualDebtKopecks) + buyout.penalties.reduce((penaltiesSum, penalty) => penaltiesSum + clampMoney(penalty.amountKopecks), 0)
      : 0),
    0
  );
  const activeDealsCount = rentals.filter((rental) => activeRentalStatuses.has(rental.status)).length
    + buyouts.filter((buyout) => activeBuyoutStatuses.has(buyout.status)).length;
  const overdueCount = rentals.filter((rental) => overdueRentalStatuses.has(rental.status)).length
    + buyouts.filter((buyout) => overdueBuyoutStatuses.has(buyout.status)).length;

  await tx.client.update({
    where: { id: params.clientId },
    data: {
      currentDebtKopecks,
      overdueDebtKopecks,
      activeDealsCount,
      paymentCount,
      overdueCount
    }
  });
}

async function refreshRentalDepositSnapshot(tx: TransactionClient, params: { rentalId: string }) {
  const [deposits, refunds] = await Promise.all([
    tx.deposit.aggregate({
      where: {
        rentalId: params.rentalId
      },
      _sum: {
        amountKopecks: true
      }
    }),
    tx.depositRefund.aggregate({
      where: {
        rentalId: params.rentalId
      },
      _sum: {
        amountKopecks: true
      }
    })
  ]);

  await tx.rental.update({
    where: { id: params.rentalId },
    data: {
      depositCollectedKopecks: deposits._sum.amountKopecks ?? 0,
      depositReturnedKopecks: refunds._sum.amountKopecks ?? 0
    }
  });
}

async function refreshBuyoutDepositSnapshot(tx: TransactionClient, params: { buyoutId: string }) {
  const [deposits, refunds] = await Promise.all([
    tx.deposit.aggregate({
      where: {
        buyoutId: params.buyoutId
      },
      _sum: {
        amountKopecks: true
      }
    }),
    tx.depositRefund.aggregate({
      where: {
        buyoutId: params.buyoutId
      },
      _sum: {
        amountKopecks: true
      }
    })
  ]);

  await tx.buyout.update({
    where: { id: params.buyoutId },
    data: {
      depositCollectedKopecks: deposits._sum.amountKopecks ?? 0,
      depositReturnedKopecks: refunds._sum.amountKopecks ?? 0
    }
  });
}

function buildDailyPenaltyDates(params: {
  dueAt: Date | null;
  overdueDays: number;
  graceDays: number;
}) {
  const overdueDays = Math.max(0, Math.trunc(params.overdueDays || 0));
  const graceDays = Math.max(0, Math.trunc(params.graceDays || 0));

  if (!params.dueAt || overdueDays <= graceDays) {
    return [];
  }

  const result: Date[] = [];
  for (let offset = graceDays + 1; offset <= overdueDays; offset += 1) {
    result.push(addDaysUtc(params.dueAt, offset));
  }

  return result;
}

function computeOpenPenaltyBalance(penalties: Array<{ status: string; amountKopecks: number }>) {
  return penalties.reduce((sum, penalty) => (
    penalty.status === "ACTIVE" ? sum + clampMoney(penalty.amountKopecks) : sum
  ), 0);
}

export async function updateRentalTerms(params: {
  tenantSlug: string;
  rentalId: string;
  actorUserId?: string | null;
  depositTargetKopecks?: number | null;
  autoPenaltyEnabled?: boolean | null;
  autoPenaltyDailyKopecks?: number | null;
  graceDays?: number | null;
  reason?: string | null;
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
        clientId: true,
        dealNumber: true,
        depositTargetKopecks: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        graceDays: true
      }
    });

    if (!rental) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    const data = {
      depositTargetKopecks: params.depositTargetKopecks == null ? rental.depositTargetKopecks : clampMoney(params.depositTargetKopecks),
      autoPenaltyEnabled: params.autoPenaltyEnabled ?? rental.autoPenaltyEnabled,
      autoPenaltyDailyKopecks: params.autoPenaltyDailyKopecks == null ? rental.autoPenaltyDailyKopecks : clampMoney(params.autoPenaltyDailyKopecks),
      graceDays: params.graceDays == null ? rental.graceDays : Math.max(0, Math.trunc(params.graceDays))
    };

    await tx.rental.update({
      where: { id: rental.id },
      data
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "terms_updated",
        reason: params.reason?.trim() || null,
        oldValueText: JSON.stringify({
          depositTargetKopecks: rental.depositTargetKopecks,
          autoPenaltyEnabled: rental.autoPenaltyEnabled,
          autoPenaltyDailyKopecks: rental.autoPenaltyDailyKopecks,
          graceDays: rental.graceDays
        }, null, 2),
        newValueText: JSON.stringify(data, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber,
        ...data
      }
    };
  });
}

export async function updateBuyoutTerms(params: {
  tenantSlug: string;
  buyoutId: string;
  actorUserId?: string | null;
  depositTargetKopecks?: number | null;
  autoPenaltyEnabled?: boolean | null;
  autoPenaltyDailyKopecks?: number | null;
  graceDays?: number | null;
  reason?: string | null;
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
        clientId: true,
        dealNumber: true,
        depositTargetKopecks: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        graceDays: true
      }
    });

    if (!buyout) {
      throw new HttpError(404, `Buyout '${params.buyoutId}' was not found`);
    }

    const data = {
      depositTargetKopecks: params.depositTargetKopecks == null ? buyout.depositTargetKopecks : clampMoney(params.depositTargetKopecks),
      autoPenaltyEnabled: params.autoPenaltyEnabled ?? buyout.autoPenaltyEnabled,
      autoPenaltyDailyKopecks: params.autoPenaltyDailyKopecks == null ? buyout.autoPenaltyDailyKopecks : clampMoney(params.autoPenaltyDailyKopecks),
      graceDays: params.graceDays == null ? buyout.graceDays : Math.max(0, Math.trunc(params.graceDays))
    };

    await tx.buyout.update({
      where: { id: buyout.id },
      data
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "buyout",
        entityId: buyout.id,
        action: "terms_updated",
        reason: params.reason?.trim() || null,
        oldValueText: JSON.stringify({
          depositTargetKopecks: buyout.depositTargetKopecks,
          autoPenaltyEnabled: buyout.autoPenaltyEnabled,
          autoPenaltyDailyKopecks: buyout.autoPenaltyDailyKopecks,
          graceDays: buyout.graceDays
        }, null, 2),
        newValueText: JSON.stringify(data, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      deal: {
        id: buyout.id,
        dealNumber: buyout.dealNumber,
        ...data
      }
    };
  });
}

async function persistScheduleItems(tx: TransactionClient, params: { tenantId: string; scheduleId: string; items: ScheduleItemSnapshot[] }) {
  for (const item of params.items) {
    if (item.isNew) {
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
    } else if (item.id) {
      await tx.paymentScheduleItem.update({
        where: { id: item.id },
        data: {
          paidKopecks: item.paidKopecks,
          status: item.status,
          closedAt: item.closedAt
        }
      });
    }
  }
}

function materializeItems(
  items: Array<{
    id: string;
    sequenceNumber: number;
    dueAt: Date;
    amountKopecks: number;
    paidKopecks: number;
    status: ScheduleItemStatus;
    closedAt: Date | null;
  }>
): ScheduleItemSnapshot[] {
  return items.map((item) => ({
    id: item.id,
    sequenceNumber: item.sequenceNumber,
    dueAt: item.dueAt,
    amountKopecks: item.amountKopecks,
    paidKopecks: item.paidKopecks,
    status: item.status,
    closedAt: item.closedAt
  }));
}

export async function postRentalPayment(params: {
  tenantSlug: string;
  rentalId: string;
  actorUserId?: string | null;
  amountKopecks: number;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  if (amountKopecks <= 0) {
    throw new HttpError(422, "Сумма должна быть больше нуля.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        clientId: true,
        bikeUnitId: true,
        bankId: true,
        dealNumber: true,
        status: true,
        tariffLabel: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        debtKopecks: true,
        client: {
          select: {
            id: true,
            fullName: true,
            primaryPhone: true,
            telegramHandle: true
          }
        },
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
      throw new HttpError(404, "Сделка аренды не найдена.");
    }

    if (rental.status === "COMPLETED" || rental.status === "CANCELED") {
      throw new HttpError(409, "Rental is closed and does not accept new payments");
    }

    const schedule = rental.paymentSchedules[0];
    if (!schedule) {
      throw new HttpError(409, "Rental does not have a payment schedule yet");
    }

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? null,
      paymentMethod: params.paymentMethod
    });

    let remaining = amountKopecks;
    let items = materializeItems(schedule.items);
    const firstOpenItem = items.find((item) => outstandingKopecks(item) > 0) ?? null;

    while (remaining > 0) {
      let target: ScheduleItemSnapshot | null = items.find((item) => outstandingKopecks(item) > 0) ?? null;

      if (!target) {
        const lastItem = items[items.length - 1];
        if (!lastItem) {
          throw new HttpError(409, "Rental schedule is empty");
        }

        const nextItem: ScheduleItemSnapshot = {
          sequenceNumber: lastItem.sequenceNumber + 1,
          dueAt: shiftByCadence(lastItem.dueAt, schedule.cadence, schedule.intervalValue),
          amountKopecks: schedule.cycleAmountKopecks,
          paidKopecks: 0,
          status: "PLANNED",
          closedAt: null,
          isNew: true
        };
        items.push(nextItem);
        target = nextItem;
      }

      const delta = Math.min(remaining, outstandingKopecks(target));
      target.paidKopecks += delta;
      remaining -= delta;
    }

    if (!items.some((item) => outstandingKopecks(item) > 0)) {
      const lastItem = items[items.length - 1];
      if (!lastItem) {
        throw new HttpError(409, "Rental schedule is empty");
      }

      const nextItem: ScheduleItemSnapshot = {
        sequenceNumber: lastItem.sequenceNumber + 1,
        dueAt: shiftByCadence(lastItem.dueAt, schedule.cadence, schedule.intervalValue),
        amountKopecks: schedule.cycleAmountKopecks,
        paidKopecks: 0,
        status: "PLANNED",
        closedAt: null,
        isNew: true
      };
      items.push(nextItem);
    }

    items = updateStatuses(items);
    const nextOutstanding = getNextOutstanding(items);
    const debtKopecks = computeRentalDebt(items);
    const overdueDays = computeOverdueDays(items);
    const firstOpenAfter = firstOpenItem
      ? items.find((item) => item.sequenceNumber === firstOpenItem.sequenceNumber)
      : null;
    const transactionType: TransactionType = firstOpenAfter && outstandingKopecks(firstOpenAfter) > 0
      ? "PARTIAL_PAYMENT_IN"
      : "RENTAL_PAYMENT_IN";
    const article = await resolveSystemArticleAssignment(tx, tenant.id, transactionType);

    await persistScheduleItems(tx, {
      tenantId: tenant.id,
      scheduleId: schedule.id,
      items
    });

    await tx.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        nextDueAt: nextOutstanding?.dueAt ?? null
      }
    });

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: rental.branchId,
        clientId: rental.clientId,
        rentalId: rental.id,
        bankId: bank?.id ?? null,
        articleId: article?.id ?? null,
        createdById: params.actorUserId ?? null,
        type: transactionType,
        direction: "INCOME",
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article?.name ?? null,
        articleDirectionSnapshot: article?.direction ?? null,
        comment: params.comment?.trim() || null,
        sourceLabel: "rental-payment-api"
      },
      select: {
        id: true,
        amountKopecks: true,
        type: true,
        status: true,
        paymentMethod: true,
        happenedAt: true
      }
    });

    await tx.rental.update({
      where: { id: rental.id },
      data: {
        bankId: bank?.id ?? rental.bankId,
        status: overdueDays > 0 ? "OVERDUE" : "ACTIVE",
        nextPaymentAt: nextOutstanding?.dueAt ?? null,
        plannedPaymentKopecks: nextOutstanding ? outstandingKopecks(nextOutstanding) : schedule.cycleAmountKopecks,
        debtKopecks,
        overdueDays
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: rental.clientId
    });

    const notification = await queueTelegramNextPaymentAfterConfirmation(tx, {
      tenantId: tenant.id,
      client: rental.client,
      rentalId: rental.id,
      dealNumber: rental.dealNumber,
      nextPaymentAt: nextOutstanding?.dueAt ?? null,
      nextPaymentAmountKopecks: nextOutstanding ? outstandingKopecks(nextOutstanding) : 0
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "payment_posted",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          transactionId: transaction.id,
          amountKopecks,
          paymentMethod: params.paymentMethod
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber,
        nextPaymentAt: nextOutstanding?.dueAt ?? null,
        plannedPaymentKopecks: nextOutstanding ? outstandingKopecks(nextOutstanding) : schedule.cycleAmountKopecks,
        debtKopecks,
        overdueDays
      },
      notification
    };
  });

  triggerQueuedTelegramNotificationDispatch(result.notification?.status === "QUEUED" ? result.notification.id : null);
  return {
    tenant: result.tenant,
    transaction: result.transaction,
    deal: result.deal
  };
}

export async function postBuyoutPayment(params: {
  tenantSlug: string;
  buyoutId: string;
  actorUserId?: string | null;
  amountKopecks: number;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  if (amountKopecks <= 0) {
    throw new HttpError(422, "Сумма должна быть больше нуля.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const buyout = await tx.buyout.findFirst({
      where: {
        id: params.buyoutId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        clientId: true,
        bankId: true,
        dealNumber: true,
        status: true,
        client: {
          select: {
            id: true,
            fullName: true,
            primaryPhone: true,
            telegramHandle: true
          }
        },
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

    if (!buyout) {
      throw new HttpError(404, `Buyout '${params.buyoutId}' was not found`);
    }

    if (buyout.status === "CLOSED" || buyout.status === "TERMINATED") {
      throw new HttpError(409, "Buyout is closed and does not accept new payments");
    }

    const schedule = buyout.paymentSchedules[0];
    if (!schedule) {
      throw new HttpError(409, "Buyout does not have a payment schedule yet");
    }

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? buyout.bankId,
      paymentMethod: params.paymentMethod
    });

    const article = await resolveSystemArticleAssignment(tx, tenant.id, "BUYOUT_PAYMENT_IN");

    let remaining = amountKopecks;
    const items = materializeItems(schedule.items);

    for (const item of items) {
      const outstanding = outstandingKopecks(item);
      if (outstanding <= 0 || remaining <= 0) {
        continue;
      }

      const delta = Math.min(remaining, outstanding);
      item.paidKopecks += delta;
      remaining -= delta;
    }

    if (remaining > 0) {
      throw new HttpError(409, "Overpayment is not supported for buyout schedule yet");
    }

    const normalizedItems = updateStatuses(items);
    const nextOutstanding = getNextOutstanding(normalizedItems);
    const residualDebtKopecks = normalizedItems.reduce((sum, item) => sum + outstandingKopecks(item), 0);
    const overdueDays = computeOverdueDays(normalizedItems);

    await persistScheduleItems(tx, {
      tenantId: tenant.id,
      scheduleId: schedule.id,
      items: normalizedItems
    });

    await tx.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        nextDueAt: nextOutstanding?.dueAt ?? null
      }
    });

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: buyout.branchId,
        clientId: buyout.clientId,
        buyoutId: buyout.id,
        bankId: bank?.id ?? (params.paymentMethod === "BANK" ? buyout.bankId : null),
        articleId: article?.id ?? null,
        createdById: params.actorUserId ?? null,
        type: "BUYOUT_PAYMENT_IN",
        direction: "INCOME",
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article?.name ?? null,
        articleDirectionSnapshot: article?.direction ?? null,
        comment: params.comment?.trim() || null,
        sourceLabel: "buyout-payment-api"
      },
      select: {
        id: true,
        amountKopecks: true,
        type: true,
        status: true,
        paymentMethod: true,
        happenedAt: true
      }
    });

    await tx.buyout.update({
      where: { id: buyout.id },
      data: {
        bankId: bank?.id ?? buyout.bankId,
        status: residualDebtKopecks <= 0 ? "CLOSED" : overdueDays > 0 ? "OVERDUE" : "ACTIVE",
        nextPaymentAt: nextOutstanding?.dueAt ?? null,
        residualDebtKopecks,
        overdueDays
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: buyout.clientId
    });

    const notification = await queueTelegramNextPaymentAfterConfirmation(tx, {
      tenantId: tenant.id,
      client: buyout.client,
      buyoutId: buyout.id,
      dealNumber: buyout.dealNumber,
      nextPaymentAt: nextOutstanding?.dueAt ?? null,
      nextPaymentAmountKopecks: nextOutstanding ? outstandingKopecks(nextOutstanding) : 0
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "buyout",
        entityId: buyout.id,
        action: "payment_posted",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          transactionId: transaction.id,
          amountKopecks,
          paymentMethod: params.paymentMethod
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      deal: {
        id: buyout.id,
        dealNumber: buyout.dealNumber,
        nextPaymentAt: nextOutstanding?.dueAt ?? null,
        residualDebtKopecks,
        overdueDays
      },
      notification
    };
  });

  triggerQueuedTelegramNotificationDispatch(result.notification?.status === "QUEUED" ? result.notification.id : null);
  return {
    tenant: result.tenant,
    transaction: result.transaction,
    deal: result.deal
  };
}

export async function postUnifiedOrderPayment(params: {
  tenantSlug: string;
  kind: "RENTAL" | "BUYOUT";
  dealId: string;
  actorUserId: string;
  totalAmountKopecks: number;
  mainAmountKopecks: number;
  penaltyIds: string[];
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  // One operator payment can split into several finance rows here: main deal payment plus selected penalties linked by one bundle key.
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const totalAmountKopecks = clampMoney(params.totalAmountKopecks);
  const mainAmountKopecks = clampMoney(params.mainAmountKopecks);
  const penaltyIds = Array.from(new Set(
    params.penaltyIds
      .map((value) => value.trim())
      .filter(Boolean)
  ));

  if (totalAmountKopecks <= 0) {
    throw new HttpError(422, "Общая сумма платежа должна быть больше нуля.");
  }

  if (mainAmountKopecks <= 0 && penaltyIds.length === 0) {
    throw new HttpError(422, "Нужно указать сумму на сделку или выбрать штрафы для оплаты.");
  }

  const comment = params.comment?.trim() || null;
  const happenedAt = parseOptionalDate(params.happenedAt);

  const result = await prisma.$transaction(async (tx) => {
    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.paymentMethod === "BANK" ? params.bankId ?? null : null,
      paymentMethod: params.paymentMethod
    });
    const bundleKey = randomUUID();
    const createdTransactions: Array<{
      id: string;
      type: TransactionType;
      amountKopecks: number;
      paymentMethod: PaymentMethod;
      happenedAt: Date;
      bank: {
        id: string;
        name: string;
      } | null;
    }> = [];

    if (params.kind === "RENTAL") {
      const rental = await tx.rental.findFirst({
        where: {
          id: params.dealId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          tenantId: true,
          branchId: true,
          clientId: true,
          bankId: true,
          dealNumber: true,
          status: true,
          nextPaymentAt: true,
          plannedPaymentKopecks: true,
          debtKopecks: true,
          overdueDays: true,
          client: {
            select: {
              id: true,
              fullName: true,
              primaryPhone: true,
              telegramHandle: true
            }
          },
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
        throw new HttpError(404, "Сделка аренды не найдена.");
      }

      const penalties = penaltyIds.length > 0
        ? await tx.penalty.findMany({
            where: {
              id: {
                in: penaltyIds
              },
              tenantId: tenant.id,
              rentalId: rental.id,
              status: "ACTIVE",
              paidTransactionId: null
            },
            select: {
              id: true,
              amountKopecks: true,
              reason: true,
              status: true,
              paidTransactionId: true
            }
          })
        : [];

      if (penalties.length !== penaltyIds.length) {
        throw new HttpError(409, "Один или несколько выбранных штрафов уже недоступны для оплаты.");
      }

      const penaltiesById = new Map(penalties.map((penalty) => [penalty.id, penalty]));
      const orderedPenalties = penaltyIds.map((penaltyId) => penaltiesById.get(penaltyId)).filter(Boolean) as typeof penalties;
      const penaltiesAmountKopecks = orderedPenalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);

      if (mainAmountKopecks + penaltiesAmountKopecks !== totalAmountKopecks) {
        throw new HttpError(422, "Сумма платежа не совпадает с разнесением по сделке и штрафам.");
      }

      let nextPaymentAt = rental.nextPaymentAt;
      let plannedPaymentKopecks = rental.plannedPaymentKopecks;
      let debtKopecks = rental.debtKopecks;
      let overdueDays = rental.overdueDays;
      let mainCoveredPeriodsCount = 0;
      let notification: Awaited<ReturnType<typeof queueTelegramNextPaymentAfterConfirmation>> | null = null;

      if (mainAmountKopecks > 0) {
        if (rental.status === "COMPLETED" || rental.status === "CANCELED") {
          throw new HttpError(409, "Rental is closed and does not accept new payments");
        }

        const schedule = rental.paymentSchedules[0];
        if (!schedule) {
          throw new HttpError(409, "Rental does not have a payment schedule yet");
        }

        let remaining = mainAmountKopecks;
        let items = materializeItems(schedule.items);
        const firstOpenItem = items.find((item) => outstandingKopecks(item) > 0) ?? null;
        const maxInitialSequence = items[items.length - 1]?.sequenceNumber ?? 0;
        const beforeOutstandingBySequence = new Map(items.map((item) => [item.sequenceNumber, outstandingKopecks(item)]));

        while (remaining > 0) {
          let target: ScheduleItemSnapshot | null = items.find((item) => outstandingKopecks(item) > 0) ?? null;

          if (!target) {
            const lastItem = items[items.length - 1];
            if (!lastItem) {
              throw new HttpError(409, "Rental schedule is empty");
            }

            const nextItem: ScheduleItemSnapshot = {
              sequenceNumber: lastItem.sequenceNumber + 1,
              dueAt: shiftByCadence(lastItem.dueAt, schedule.cadence, schedule.intervalValue),
              amountKopecks: schedule.cycleAmountKopecks,
              paidKopecks: 0,
              status: "PLANNED",
              closedAt: null,
              isNew: true
            };
            items.push(nextItem);
            target = nextItem;
          }

          const delta = Math.min(remaining, outstandingKopecks(target));
          target.paidKopecks += delta;
          remaining -= delta;
        }

        if (!items.some((item) => outstandingKopecks(item) > 0)) {
          const lastItem = items[items.length - 1];
          if (!lastItem) {
            throw new HttpError(409, "Rental schedule is empty");
          }

          items.push({
            sequenceNumber: lastItem.sequenceNumber + 1,
            dueAt: shiftByCadence(lastItem.dueAt, schedule.cadence, schedule.intervalValue),
            amountKopecks: schedule.cycleAmountKopecks,
            paidKopecks: 0,
            status: "PLANNED",
            closedAt: null,
            isNew: true
          });
        }

        items = updateStatuses(items);
        const nextOutstanding = getNextOutstanding(items);
        debtKopecks = computeRentalDebt(items);
        overdueDays = computeOverdueDays(items);
        const firstOpenAfter = firstOpenItem
          ? items.find((item) => item.sequenceNumber === firstOpenItem.sequenceNumber)
          : null;
        const transactionType: TransactionType = firstOpenAfter && outstandingKopecks(firstOpenAfter) > 0
          ? "PARTIAL_PAYMENT_IN"
          : "RENTAL_PAYMENT_IN";
        const article = await resolveSystemArticleAssignment(tx, tenant.id, transactionType);

        await persistScheduleItems(tx, {
          tenantId: tenant.id,
          scheduleId: schedule.id,
          items
        });

        await tx.paymentSchedule.update({
          where: { id: schedule.id },
          data: {
            nextDueAt: nextOutstanding?.dueAt ?? null
          }
        });

        const transaction = await tx.financialTransaction.create({
          data: {
            tenantId: tenant.id,
            branchId: rental.branchId,
            clientId: rental.clientId,
            rentalId: rental.id,
            bankId: bank?.id ?? null,
            articleId: article?.id ?? null,
            createdById: params.actorUserId,
            type: transactionType,
            direction: "INCOME",
            status: "POSTED",
            paymentMethod: params.paymentMethod,
            amountKopecks: mainAmountKopecks,
            happenedAt,
            postedAt: new Date(),
            articleNameSnapshot: article?.name ?? null,
            articleDirectionSnapshot: article?.direction ?? null,
            comment,
            sourceLabel: "order-unified-payment-api",
            externalReference: bundleKey
          },
          select: {
            id: true,
            amountKopecks: true,
            type: true,
            status: true,
            paymentMethod: true,
            happenedAt: true
          }
        });

        createdTransactions.push({
          id: transaction.id,
          type: transaction.type,
          amountKopecks: transaction.amountKopecks,
          paymentMethod: transaction.paymentMethod,
          happenedAt: transaction.happenedAt,
          bank: bank ? {
            id: bank.id,
            name: bank.name
          } : null
        });

        nextPaymentAt = nextOutstanding?.dueAt ?? null;
        plannedPaymentKopecks = nextOutstanding ? outstandingKopecks(nextOutstanding) : schedule.cycleAmountKopecks;

        mainCoveredPeriodsCount = items.reduce((sum, item) => {
          const beforeOutstanding = beforeOutstandingBySequence.get(item.sequenceNumber) ?? (item.sequenceNumber > maxInitialSequence ? item.amountKopecks : 0);
          return beforeOutstanding > 0 && outstandingKopecks(item) === 0 ? sum + 1 : sum;
        }, 0);

        await tx.rental.update({
          where: { id: rental.id },
          data: {
            bankId: bank?.id ?? rental.bankId,
            status: overdueDays > 0 ? "OVERDUE" : "ACTIVE",
            nextPaymentAt,
            plannedPaymentKopecks,
            debtKopecks,
            overdueDays
          }
        });

        notification = await queueTelegramNextPaymentAfterConfirmation(tx, {
          tenantId: tenant.id,
          client: rental.client,
          rentalId: rental.id,
          dealNumber: rental.dealNumber,
          nextPaymentAt,
          nextPaymentAmountKopecks: nextOutstanding ? outstandingKopecks(nextOutstanding) : 0
        });

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: params.actorUserId,
            entityType: "rental",
            entityId: rental.id,
            action: "payment_posted",
            reason: comment,
            newValueText: JSON.stringify({
              bundleKey,
              transactionId: transaction.id,
              totalAmountKopecks,
              mainAmountKopecks,
              penaltiesAmountKopecks,
              paymentMethod: params.paymentMethod
            }, null, 2),
            ipAddress: params.ipAddress ?? null,
            userAgent: params.userAgent ?? null
          }
        });
      }

      if (orderedPenalties.length > 0) {
        const article = await resolveSystemArticleAssignment(tx, tenant.id, "PENALTY_PAYMENT_IN");

        for (const penalty of orderedPenalties) {
          const transaction = await tx.financialTransaction.create({
            data: {
              tenantId: tenant.id,
              branchId: rental.branchId,
              clientId: rental.clientId,
              rentalId: rental.id,
              bankId: bank?.id ?? null,
              articleId: article?.id ?? null,
              createdById: params.actorUserId,
              type: "PENALTY_PAYMENT_IN",
              direction: "INCOME",
              status: "POSTED",
              paymentMethod: params.paymentMethod,
              amountKopecks: penalty.amountKopecks,
              happenedAt,
              postedAt: new Date(),
              articleNameSnapshot: article?.name ?? null,
              articleDirectionSnapshot: article?.direction ?? null,
              comment: comment ?? penalty.reason,
              sourceLabel: "order-unified-payment-api",
              externalReference: bundleKey
            },
            select: {
              id: true,
              amountKopecks: true,
              type: true,
              status: true,
              paymentMethod: true,
              happenedAt: true
            }
          });

          await tx.penalty.update({
            where: {
              id: penalty.id
            },
            data: {
              status: "PAID",
              paidTransactionId: transaction.id
            }
          });

          createdTransactions.push({
            id: transaction.id,
            type: transaction.type,
            amountKopecks: transaction.amountKopecks,
            paymentMethod: transaction.paymentMethod,
            happenedAt: transaction.happenedAt,
            bank: bank ? {
              id: bank.id,
              name: bank.name
            } : null
          });

          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: params.actorUserId,
              entityType: "penalty",
              entityId: penalty.id,
              action: "payment_posted",
              reason: comment ?? penalty.reason,
              newValueText: JSON.stringify({
                bundleKey,
                transactionId: transaction.id,
                amountKopecks: transaction.amountKopecks,
                paymentMethod: transaction.paymentMethod
              }, null, 2),
              ipAddress: params.ipAddress ?? null,
              userAgent: params.userAgent ?? null
            }
          });
        }
      }

      await refreshClientSnapshot(tx, {
        tenantId: tenant.id,
        clientId: rental.clientId
      });

      return {
        tenant,
        bundleKey,
        deal: {
          kind: "RENTAL" as const,
          id: rental.id,
          dealNumber: rental.dealNumber,
          nextPaymentAt,
          plannedPaymentKopecks,
          debtKopecks,
          overdueDays
        },
        totals: {
          totalAmountKopecks,
          mainAmountKopecks,
          penaltiesAmountKopecks
        },
        mainCoveredPeriodsCount,
        transactions: createdTransactions,
        notification
      };
    }

    const buyout = await tx.buyout.findFirst({
      where: {
        id: params.dealId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        clientId: true,
        bankId: true,
        dealNumber: true,
        status: true,
        nextPaymentAt: true,
        residualDebtKopecks: true,
        overdueDays: true,
        client: {
          select: {
            id: true,
            fullName: true,
            primaryPhone: true,
            telegramHandle: true
          }
        },
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

    if (!buyout) {
      throw new HttpError(404, "Сделка выкупа не найдена.");
    }

    const penalties = penaltyIds.length > 0
      ? await tx.penalty.findMany({
          where: {
            id: {
              in: penaltyIds
            },
            tenantId: tenant.id,
            buyoutId: buyout.id,
            status: "ACTIVE",
            paidTransactionId: null
          },
          select: {
            id: true,
            amountKopecks: true,
            reason: true,
            status: true,
            paidTransactionId: true
          }
        })
      : [];

    if (penalties.length !== penaltyIds.length) {
      throw new HttpError(409, "Один или несколько выбранных штрафов уже недоступны для оплаты.");
    }

    const penaltiesById = new Map(penalties.map((penalty) => [penalty.id, penalty]));
    const orderedPenalties = penaltyIds.map((penaltyId) => penaltiesById.get(penaltyId)).filter(Boolean) as typeof penalties;
    const penaltiesAmountKopecks = orderedPenalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);

    if (mainAmountKopecks + penaltiesAmountKopecks !== totalAmountKopecks) {
      throw new HttpError(422, "Сумма платежа не совпадает с разнесением по сделке и штрафам.");
    }

    let nextPaymentAt = buyout.nextPaymentAt;
    let residualDebtKopecks = buyout.residualDebtKopecks;
    let overdueDays = buyout.overdueDays;
    let mainCoveredPeriodsCount = 0;
    let notification: Awaited<ReturnType<typeof queueTelegramNextPaymentAfterConfirmation>> | null = null;

    if (mainAmountKopecks > 0) {
      if (buyout.status === "CLOSED" || buyout.status === "TERMINATED") {
        throw new HttpError(409, "Buyout is closed and does not accept new payments");
      }

      const schedule = buyout.paymentSchedules[0];
      if (!schedule) {
        throw new HttpError(409, "Buyout does not have a payment schedule yet");
      }

      let remaining = mainAmountKopecks;
      const items = materializeItems(schedule.items);
      const beforeOutstandingBySequence = new Map(items.map((item) => [item.sequenceNumber, outstandingKopecks(item)]));

      for (const item of items) {
        const outstanding = outstandingKopecks(item);
        if (outstanding <= 0 || remaining <= 0) {
          continue;
        }

        const delta = Math.min(remaining, outstanding);
        item.paidKopecks += delta;
        remaining -= delta;
      }

      if (remaining > 0) {
        throw new HttpError(409, "Переплата сверх графика выкупа пока не поддерживается.");
      }

      const normalizedItems = updateStatuses(items);
      const nextOutstanding = getNextOutstanding(normalizedItems);
      residualDebtKopecks = normalizedItems.reduce((sum, item) => sum + outstandingKopecks(item), 0);
      overdueDays = computeOverdueDays(normalizedItems);
      const article = await resolveSystemArticleAssignment(tx, tenant.id, "BUYOUT_PAYMENT_IN");

      await persistScheduleItems(tx, {
        tenantId: tenant.id,
        scheduleId: schedule.id,
        items: normalizedItems
      });

      await tx.paymentSchedule.update({
        where: { id: schedule.id },
        data: {
          nextDueAt: nextOutstanding?.dueAt ?? null
        }
      });

      const transaction = await tx.financialTransaction.create({
        data: {
          tenantId: tenant.id,
          branchId: buyout.branchId,
          clientId: buyout.clientId,
          buyoutId: buyout.id,
          bankId: bank?.id ?? null,
          articleId: article?.id ?? null,
          createdById: params.actorUserId,
          type: "BUYOUT_PAYMENT_IN",
          direction: "INCOME",
          status: "POSTED",
          paymentMethod: params.paymentMethod,
          amountKopecks: mainAmountKopecks,
          happenedAt,
          postedAt: new Date(),
          articleNameSnapshot: article?.name ?? null,
          articleDirectionSnapshot: article?.direction ?? null,
          comment,
          sourceLabel: "order-unified-payment-api",
          externalReference: bundleKey
        },
        select: {
          id: true,
          amountKopecks: true,
          type: true,
          status: true,
          paymentMethod: true,
          happenedAt: true
        }
      });

      createdTransactions.push({
        id: transaction.id,
        type: transaction.type,
        amountKopecks: transaction.amountKopecks,
        paymentMethod: transaction.paymentMethod,
        happenedAt: transaction.happenedAt,
        bank: bank ? {
          id: bank.id,
          name: bank.name
        } : null
      });

      nextPaymentAt = nextOutstanding?.dueAt ?? null;
      mainCoveredPeriodsCount = normalizedItems.reduce((sum, item) => {
        const beforeOutstanding = beforeOutstandingBySequence.get(item.sequenceNumber) ?? 0;
        return beforeOutstanding > 0 && outstandingKopecks(item) === 0 ? sum + 1 : sum;
      }, 0);

      await tx.buyout.update({
        where: { id: buyout.id },
        data: {
          bankId: bank?.id ?? buyout.bankId,
          status: residualDebtKopecks <= 0 ? "CLOSED" : overdueDays > 0 ? "OVERDUE" : "ACTIVE",
          nextPaymentAt,
          residualDebtKopecks,
          overdueDays
        }
      });

      notification = await queueTelegramNextPaymentAfterConfirmation(tx, {
        tenantId: tenant.id,
        client: buyout.client,
        buyoutId: buyout.id,
        dealNumber: buyout.dealNumber,
        nextPaymentAt,
        nextPaymentAmountKopecks: nextOutstanding ? outstandingKopecks(nextOutstanding) : 0
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: params.actorUserId,
          entityType: "buyout",
          entityId: buyout.id,
          action: "payment_posted",
          reason: comment,
          newValueText: JSON.stringify({
            bundleKey,
            transactionId: transaction.id,
            totalAmountKopecks,
            mainAmountKopecks,
            penaltiesAmountKopecks,
            paymentMethod: params.paymentMethod
          }, null, 2),
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null
        }
      });
    }

    if (orderedPenalties.length > 0) {
      const article = await resolveSystemArticleAssignment(tx, tenant.id, "PENALTY_PAYMENT_IN");

      for (const penalty of orderedPenalties) {
        const transaction = await tx.financialTransaction.create({
          data: {
            tenantId: tenant.id,
            branchId: buyout.branchId,
            clientId: buyout.clientId,
            buyoutId: buyout.id,
            bankId: bank?.id ?? null,
            articleId: article?.id ?? null,
            createdById: params.actorUserId,
            type: "PENALTY_PAYMENT_IN",
            direction: "INCOME",
            status: "POSTED",
            paymentMethod: params.paymentMethod,
            amountKopecks: penalty.amountKopecks,
            happenedAt,
            postedAt: new Date(),
            articleNameSnapshot: article?.name ?? null,
            articleDirectionSnapshot: article?.direction ?? null,
            comment: comment ?? penalty.reason,
            sourceLabel: "order-unified-payment-api",
            externalReference: bundleKey
          },
          select: {
            id: true,
            amountKopecks: true,
            type: true,
            status: true,
            paymentMethod: true,
            happenedAt: true
          }
        });

        await tx.penalty.update({
          where: {
            id: penalty.id
          },
          data: {
            status: "PAID",
            paidTransactionId: transaction.id
          }
        });

        createdTransactions.push({
          id: transaction.id,
          type: transaction.type,
          amountKopecks: transaction.amountKopecks,
          paymentMethod: transaction.paymentMethod,
          happenedAt: transaction.happenedAt,
          bank: bank ? {
            id: bank.id,
            name: bank.name
          } : null
        });

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: params.actorUserId,
            entityType: "penalty",
            entityId: penalty.id,
            action: "payment_posted",
            reason: comment ?? penalty.reason,
            newValueText: JSON.stringify({
              bundleKey,
              transactionId: transaction.id,
              amountKopecks: transaction.amountKopecks,
              paymentMethod: transaction.paymentMethod
            }, null, 2),
            ipAddress: params.ipAddress ?? null,
            userAgent: params.userAgent ?? null
          }
        });
      }
    }

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: buyout.clientId
    });

    return {
      tenant,
      bundleKey,
      deal: {
        kind: "BUYOUT" as const,
        id: buyout.id,
        dealNumber: buyout.dealNumber,
        nextPaymentAt,
        residualDebtKopecks,
        overdueDays
      },
      totals: {
        totalAmountKopecks,
        mainAmountKopecks,
        penaltiesAmountKopecks
      },
      mainCoveredPeriodsCount,
      transactions: createdTransactions,
      notification
    };
  });

  triggerQueuedTelegramNotificationDispatch(result.notification?.status === "QUEUED" ? result.notification.id : null);

  return {
    tenant: result.tenant,
    bundleKey: result.bundleKey,
    deal: result.deal,
    totals: result.totals,
    mainCoveredPeriodsCount: result.mainCoveredPeriodsCount,
    transactions: result.transactions
  };
}

export async function receiveRentalDeposit(params: {
  tenantSlug: string;
  rentalId: string;
  actorUserId?: string | null;
  amountKopecks: number;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  if (amountKopecks <= 0) {
    throw new HttpError(422, "amountKopecks must be greater than 0");
  }

  return prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        clientId: true,
        bankId: true,
        dealNumber: true,
        depositTargetKopecks: true
      }
    });

    if (!rental) {
      throw new HttpError(404, "Сделка аренды не найдена.");
    }

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? null,
      paymentMethod: params.paymentMethod
    });

    const article = await resolveSystemArticleAssignment(tx, tenant.id, "DEPOSIT_IN");

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: rental.branchId,
        clientId: rental.clientId,
        rentalId: rental.id,
        bankId: bank?.id ?? null,
        articleId: article?.id ?? null,
        createdById: params.actorUserId ?? null,
        type: "DEPOSIT_IN",
        direction: "INCOME",
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article?.name ?? null,
        articleDirectionSnapshot: article?.direction ?? null,
        comment: params.comment?.trim() || null,
        sourceLabel: "rental-deposit-api"
      },
      select: {
        id: true,
        amountKopecks: true,
        type: true,
        status: true,
        paymentMethod: true,
        happenedAt: true
      }
    });

    await tx.deposit.create({
      data: {
        tenantId: tenant.id,
        clientId: rental.clientId,
        rentalId: rental.id,
        receivedTransactionId: transaction.id,
        amountKopecks,
        status: "RECEIVED",
        comment: params.comment?.trim() || null
      }
    });

    await refreshRentalDepositSnapshot(tx, {
      rentalId: rental.id
    });

    const refreshed = await tx.rental.findUnique({
      where: { id: rental.id },
      select: {
        id: true,
        dealNumber: true,
        depositTargetKopecks: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "deposit_received",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          transactionId: transaction.id,
          amountKopecks,
          paymentMethod: params.paymentMethod
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      deal: refreshed
    };
  });
}

export async function refundRentalDeposit(params: {
  tenantSlug: string;
  rentalId: string;
  actorUserId?: string | null;
  amountKopecks: number;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  if (amountKopecks <= 0) {
    throw new HttpError(422, "amountKopecks must be greater than 0");
  }

  return prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        branchId: true,
        clientId: true,
        bankId: true,
        dealNumber: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true
      }
    });

    if (!rental) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    const refundableKopecks = Math.max(0, clampMoney(rental.depositCollectedKopecks) - clampMoney(rental.depositReturnedKopecks));
    if (amountKopecks > refundableKopecks) {
      throw new HttpError(409, `Сумма возврата превышает доступный остаток залога: ${Math.round(refundableKopecks / 100)} руб.`);
    }

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? null,
      paymentMethod: params.paymentMethod
    });

    const article = await resolveSystemArticleAssignment(tx, tenant.id, "DEPOSIT_REFUND_OUT");

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: rental.branchId,
        clientId: rental.clientId,
        rentalId: rental.id,
        bankId: bank?.id ?? null,
        articleId: article?.id ?? null,
        createdById: params.actorUserId ?? null,
        type: "DEPOSIT_REFUND_OUT",
        direction: "EXPENSE",
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article?.name ?? null,
        articleDirectionSnapshot: article?.direction ?? null,
        comment: params.comment?.trim() || null,
        sourceLabel: "rental-deposit-refund-api"
      },
      select: {
        id: true,
        amountKopecks: true,
        type: true,
        status: true,
        paymentMethod: true,
        happenedAt: true
      }
    });

    await tx.depositRefund.create({
      data: {
        tenantId: tenant.id,
        clientId: rental.clientId,
        rentalId: rental.id,
        transactionId: transaction.id,
        amountKopecks,
        comment: params.comment?.trim() || null
      }
    });

    await refreshRentalDepositSnapshot(tx, {
      rentalId: rental.id
    });

    const refreshed = await tx.rental.findUnique({
      where: { id: rental.id },
      select: {
        id: true,
        dealNumber: true,
        depositTargetKopecks: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId ?? null,
        entityType: "rental",
        entityId: rental.id,
        action: "deposit_refunded",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          transactionId: transaction.id,
          amountKopecks,
          paymentMethod: params.paymentMethod
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      deal: refreshed
    };
  });
}

export async function createRentalManualPenalty(params: {
  tenantSlug: string;
  rentalId: string;
  actorUserId?: string | null;
  amountKopecks: number;
  reason: string;
  comment?: string | null;
  happenedAt?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  const reason = params.reason.trim();

  if (amountKopecks <= 0) {
    throw new HttpError(422, "amountKopecks must be greater than 0");
  }

  if (!reason) {
    throw new HttpError(422, "reason is required");
  }

  return prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findFirst({
      where: {
        id: params.rentalId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        clientId: true,
        dealNumber: true
      }
    });

    if (!rental) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    const penalty = await tx.penalty.create({
      data: {
        tenantId: tenant.id,
        rentalId: rental.id,
        mode: "MANUAL",
        status: "ACTIVE",
        amountKopecks,
        accrualDate: parseOptionalDate(params.happenedAt),
        reason,
        comment: params.comment?.trim() || null
      },
      select: {
        id: true,
        mode: true,
        status: true,
        amountKopecks: true,
        accrualDate: true,
        reason: true,
        comment: true
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
        action: "penalty_manual_accrued",
        reason,
        newValueText: JSON.stringify(penalty, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      penalty,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber
      }
    };
  });
}

export async function createBuyoutManualPenalty(params: {
  tenantSlug: string;
  buyoutId: string;
  actorUserId?: string | null;
  amountKopecks: number;
  reason: string;
  comment?: string | null;
  happenedAt?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  const reason = params.reason.trim();

  if (amountKopecks <= 0) {
    throw new HttpError(422, "amountKopecks must be greater than 0");
  }

  if (!reason) {
    throw new HttpError(422, "reason is required");
  }

  return prisma.$transaction(async (tx) => {
    const buyout = await tx.buyout.findFirst({
      where: {
        id: params.buyoutId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        clientId: true,
        dealNumber: true
      }
    });

    if (!buyout) {
      throw new HttpError(404, `Buyout '${params.buyoutId}' was not found`);
    }

    const penalty = await tx.penalty.create({
      data: {
        tenantId: tenant.id,
        buyoutId: buyout.id,
        mode: "MANUAL",
        status: "ACTIVE",
        amountKopecks,
        accrualDate: parseOptionalDate(params.happenedAt),
        reason,
        comment: params.comment?.trim() || null
      },
      select: {
        id: true,
        mode: true,
        status: true,
        amountKopecks: true,
        accrualDate: true,
        reason: true,
        comment: true
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
        action: "penalty_manual_accrued",
        reason,
        newValueText: JSON.stringify(penalty, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      penalty,
      deal: {
        id: buyout.id,
        dealNumber: buyout.dealNumber
      }
    };
  });
}

export async function runRentalAutoPenaltyAccrual(params: {
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
        clientId: true,
        dealNumber: true,
        status: true,
        nextPaymentAt: true,
        overdueDays: true,
        graceDays: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        penalties: {
          where: {
            mode: "AUTO"
          },
          select: {
            id: true,
            accrualDate: true
          }
        }
      }
    });

    if (!rental) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    if (!rental.autoPenaltyEnabled || clampMoney(rental.autoPenaltyDailyKopecks) <= 0) {
      throw new HttpError(409, "Auto penalties are not configured for this rental");
    }

    const penaltyDates = buildDailyPenaltyDates({
      dueAt: rental.nextPaymentAt,
      overdueDays: rental.overdueDays,
      graceDays: rental.graceDays
    });
    const existingKeys = new Set(rental.penalties.map((penalty) => penalty.accrualDate.toISOString().slice(0, 10)));
    const missingDates = penaltyDates.filter((date) => !existingKeys.has(date.toISOString().slice(0, 10)));

    const penalties = [];
    for (const accrualDate of missingDates) {
      const penalty = await tx.penalty.create({
        data: {
          tenantId: tenant.id,
          rentalId: rental.id,
          mode: "AUTO",
          status: "ACTIVE",
          amountKopecks: clampMoney(rental.autoPenaltyDailyKopecks),
          accrualDate,
          reason: "AUTO_OVERDUE_DAILY",
          comment: params.comment?.trim() || "Автоначисление за просрочку аренды"
        },
        select: {
          id: true,
          amountKopecks: true,
          accrualDate: true,
          status: true
        }
      });
      penalties.push(penalty);
    }

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
        action: "penalty_auto_run",
        reason: params.comment?.trim() || null,
        newValueText: JSON.stringify({
          createdCount: penalties.length,
          dates: penalties.map((penalty) => penalty.accrualDate)
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
        createdPenalties: penalties.length,
        totalAccruedKopecks: penalties.reduce((sum, penalty) => sum + clampMoney(penalty.amountKopecks), 0)
      },
      penalties
    };
  });
}

type FinanceQuickPeriod =
  | "TODAY"
  | "LAST_7_DAYS"
  | "LAST_30_DAYS"
  | "THIS_MONTH"
  | "PREVIOUS_MONTH";

type FinanceMoneyContour =
  | "RENTAL"
  | "BUYOUT"
  | "PENALTY"
  | "DEPOSIT"
  | "BUSINESS_EXPENSE";

type FinanceRegistryParams = {
  q?: string;
  type?: TransactionType;
  contour?: FinanceMoneyContour;
  status?: TransactionStatus;
  direction?: TransactionDirection;
  articleId?: string;
  bankId?: string;
  clientId?: string;
  branchId?: string;
  dealKind?: "RENTAL" | "BUYOUT";
  paymentMethod?: PaymentMethod;
  dealNumber?: string;
  amountFrom?: string;
  amountTo?: string;
  reconciled?: boolean;
  period?: FinanceQuickPeriod;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
};

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 23, 59, 59, 999));
}

function startOfUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function resolveRegistryDateBounds(params: {
  period?: FinanceQuickPeriod;
  dateFrom?: string;
  dateTo?: string;
}) {
  const explicitFrom = params.dateFrom?.trim();
  const explicitTo = params.dateTo?.trim();

  if (explicitFrom || explicitTo) {
    return {
      from: explicitFrom ? startOfUtcDay(parseYmdUtcNoon(explicitFrom)) : null,
      to: explicitTo ? endOfUtcDay(parseYmdUtcNoon(explicitTo)) : null
    };
  }

  const today = parseYmdUtcNoon(formatTodayYmdMoscow());
  switch (params.period) {
    case "TODAY":
      return { from: startOfUtcDay(today), to: endOfUtcDay(today) };
    case "LAST_7_DAYS":
      return { from: startOfUtcDay(addDaysUtc(today, -6)), to: endOfUtcDay(today) };
    case "LAST_30_DAYS":
      return { from: startOfUtcDay(addDaysUtc(today, -29)), to: endOfUtcDay(today) };
    case "THIS_MONTH":
      return { from: startOfUtcMonth(today), to: endOfUtcMonth(today) };
    case "PREVIOUS_MONTH": {
      const previousMonth = addMonthsUtc(today, -1);
      return { from: startOfUtcMonth(previousMonth), to: endOfUtcMonth(previousMonth) };
    }
    default:
      return { from: null, to: null };
  }
}

function parseAmountFilterKopecks(value: string | null | undefined) {
  const normalized = value?.trim().replace(",", ".");
  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return Math.round(numeric * 100);
}

function resolveContourWhere(contour: FinanceMoneyContour): Prisma.FinancialTransactionWhereInput {
  switch (contour) {
    case "RENTAL":
      return {
        OR: [
          { rentalId: { not: null } },
          { type: "RENTAL_PAYMENT_IN" },
          { article: { is: { systemKey: "income_rental" } } }
        ]
      };
    case "BUYOUT":
      return {
        OR: [
          { buyoutId: { not: null } },
          { type: "BUYOUT_PAYMENT_IN" },
          { type: "DOWN_PAYMENT_IN" },
          { article: { is: { systemKey: "income_buyout" } } }
        ]
      };
    case "PENALTY":
      return {
        OR: [
          { type: "PENALTY_ACCRUAL" },
          { type: "PENALTY_PAYMENT_IN" },
          { article: { is: { systemKey: "income_penalty" } } }
        ]
      };
    case "DEPOSIT":
      return {
        OR: [
          { type: "DEPOSIT_IN" },
          { type: "DEPOSIT_REFUND_OUT" },
          { type: "REFUND_OUT" },
          {
            article: {
              is: {
                systemKey: {
                  in: ["income_deposit", "expense_deposit_refund"]
                }
              }
            }
          }
        ]
      };
    case "BUSINESS_EXPENSE":
      return {
        AND: [
          { direction: "EXPENSE" },
          {
            OR: [
              {
                article: {
                  is: {
                    systemKey: {
                      in: [
                        "expense_repair",
                        "expense_procurement",
                        "expense_misc",
                        "expense_admin",
                        "expense_logistics"
                      ]
                    }
                  }
                }
              },
              {
                type: {
                  in: ["REPAIR_EXPENSE", "SERVICE_EXPENSE", "MANUAL_ADJUSTMENT", "WRITE_OFF"]
                }
              }
            ]
          },
          {
            NOT: {
              OR: [
                { type: "DEPOSIT_REFUND_OUT" },
                { type: "REFUND_OUT" },
                { article: { is: { systemKey: "expense_deposit_refund" } } }
              ]
            }
          }
        ]
      };
  }
}

function buildFinancialTransactionsWhere(tenant: TenantRef, params: FinanceRegistryParams): Prisma.FinancialTransactionWhereInput {
  const search = params.q?.trim();
  const bounds = resolveRegistryDateBounds({
    period: params.period,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo
  });
  const amountFromKopecks = parseAmountFilterKopecks(params.amountFrom);
  const amountToKopecks = parseAmountFilterKopecks(params.amountTo);
  const dealNumber = params.dealNumber?.trim();
  const conditions: Prisma.FinancialTransactionWhereInput[] = [{ tenantId: tenant.id }];

  if (params.type) {
    conditions.push({ type: params.type });
  }

  if (params.contour) {
    conditions.push(resolveContourWhere(params.contour));
  }

  if (params.status) {
    conditions.push({ status: params.status });
  }

  if (params.direction) {
    conditions.push({ direction: params.direction });
  }

  if (params.paymentMethod) {
    conditions.push({ paymentMethod: params.paymentMethod });
  }

  if (params.articleId?.trim()) {
    conditions.push({ articleId: params.articleId.trim() });
  }

  if (params.bankId?.trim()) {
    conditions.push({ bankId: params.bankId.trim() });
  }

  if (params.clientId?.trim()) {
    conditions.push({ clientId: params.clientId.trim() });
  }

  if (params.branchId?.trim()) {
    conditions.push({ branchId: params.branchId.trim() });
  }

  if (typeof params.reconciled === "boolean") {
    conditions.push({
      reconciledAt: params.reconciled
        ? { not: null }
        : null
    });
  }

  if (params.dealKind === "RENTAL") {
    conditions.push({ rentalId: { not: null } });
  } else if (params.dealKind === "BUYOUT") {
    conditions.push({ buyoutId: { not: null } });
  }

  if (dealNumber) {
    conditions.push({
      OR: [
        { rental: { is: { dealNumber: { contains: dealNumber, mode: "insensitive" } } } },
        { buyout: { is: { dealNumber: { contains: dealNumber, mode: "insensitive" } } } }
      ]
    });
  }

  if (amountFromKopecks != null || amountToKopecks != null) {
    conditions.push({
      amountKopecks: {
        ...(amountFromKopecks != null ? { gte: amountFromKopecks } : {}),
        ...(amountToKopecks != null ? { lte: amountToKopecks } : {})
      }
    });
  }

  if (bounds.from || bounds.to) {
    conditions.push({
      happenedAt: {
        ...(bounds.from ? { gte: bounds.from } : {}),
        ...(bounds.to ? { lte: bounds.to } : {})
      }
    });
  }

  if (search) {
    conditions.push({
      OR: [
        { comment: { contains: search, mode: "insensitive" } },
        { sourceLabel: { contains: search, mode: "insensitive" } },
        { externalReference: { contains: search, mode: "insensitive" } },
        { articleNameSnapshot: { contains: search, mode: "insensitive" } },
        { client: { is: { fullName: { contains: search, mode: "insensitive" } } } },
        { rental: { is: { dealNumber: { contains: search, mode: "insensitive" } } } },
        { buyout: { is: { dealNumber: { contains: search, mode: "insensitive" } } } },
        { bank: { is: { name: { contains: search, mode: "insensitive" } } } },
        { branch: { is: { name: { contains: search, mode: "insensitive" } } } },
        { article: { is: { name: { contains: search, mode: "insensitive" } } } }
      ]
    });
  }

  return conditions.length === 1 ? conditions[0] : { AND: conditions };
}

async function fetchFinancialTransactionRows(
  where: Prisma.FinancialTransactionWhereInput,
  limit?: number
) {
  return prisma.financialTransaction.findMany({
    where,
    orderBy: [
      { happenedAt: "desc" },
      { createdAt: "desc" }
    ],
    ...(typeof limit === "number" ? { take: limit } : {}),
    select: FINANCIAL_TRANSACTION_ROW_SELECT
  });
}

function mapFinancialTransactionRow(row: Awaited<ReturnType<typeof fetchFinancialTransactionRows>>[number]) {
  return {
    id: row.id,
    type: row.type,
    direction: row.direction,
    status: row.status,
    correctionKind: row.correctionKind,
    reversalOfTransactionId: row.reversalOfTransactionId,
    reversalReason: row.reversalReason,
    reconciledAt: row.reconciledAt,
    reconciliationNote: row.reconciliationNote,
    paymentMethod: row.paymentMethod,
    amountKopecks: row.amountKopecks,
    happenedAt: row.happenedAt,
    postedAt: row.postedAt,
    comment: row.comment,
    sourceLabel: row.sourceLabel,
    externalReference: row.externalReference,
    createdBy: row.createdBy,
    reconciledBy: row.reconciledBy,
    article: row.article || row.articleNameSnapshot
      ? {
          id: row.article?.id ?? null,
          name: row.articleNameSnapshot ?? row.article?.name ?? "Без статьи",
          systemKey: row.article?.systemKey ?? null,
          direction: row.articleDirectionSnapshot ?? row.article?.direction ?? row.direction,
          isActive: row.article?.isActive ?? false,
          isSystem: row.article?.isSystem ?? false
        }
      : null,
    client: row.client,
    bank: row.bank,
    branch: row.branch,
    reversalOfTransaction: row.reversalOfTransaction,
    reversedByTransaction: row.reversedByTransaction,
    deal: row.rental
      ? { kind: "RENTAL" as const, id: row.rental.id, dealNumber: row.rental.dealNumber }
      : row.buyout
        ? { kind: "BUYOUT" as const, id: row.buyout.id, dealNumber: row.buyout.dealNumber }
        : null
  };
}

async function buildFinanceReconciliationSummary(
  where: Prisma.FinancialTransactionWhereInput,
  reconciledFilter?: boolean
) {
  const reconciledWhere: Prisma.FinancialTransactionWhereInput = {
    ...where,
    reconciledAt: { not: null }
  };
  const unreconciledWhere: Prisma.FinancialTransactionWhereInput = {
    ...where,
    reconciledAt: null
  };

  const [reconciledCount, unreconciledCount, reconciledGrouped, unreconciledGrouped] = await Promise.all([
    reconciledFilter === false
      ? Promise.resolve(0)
      : prisma.financialTransaction.count({ where: reconciledWhere }),
    reconciledFilter === true
      ? Promise.resolve(0)
      : prisma.financialTransaction.count({ where: unreconciledWhere }),
    reconciledFilter === false
      ? Promise.resolve([])
      : prisma.financialTransaction.groupBy({
          by: ["bankId", "direction"],
          where: reconciledWhere,
          _sum: {
            amountKopecks: true
          }
        }),
    reconciledFilter === true
      ? Promise.resolve([])
      : prisma.financialTransaction.groupBy({
          by: ["bankId", "direction"],
          where: unreconciledWhere,
          _sum: {
            amountKopecks: true
          }
        })
  ]);

  const bankIds = Array.from(new Set([
    ...reconciledGrouped.map((row) => row.bankId).filter((value): value is string => Boolean(value)),
    ...unreconciledGrouped.map((row) => row.bankId).filter((value): value is string => Boolean(value))
  ]));

  const banks = bankIds.length > 0
    ? await prisma.bank.findMany({
        where: {
          id: {
            in: bankIds
          }
        },
        select: {
          id: true,
          name: true
        }
      })
    : [];

  const bankMap = new Map(banks.map((bank) => [bank.id, bank.name]));
  const summaryMap = new Map<string, {
    bankId: string | null;
    bankName: string;
    reconciledIncomeKopecks: number;
    reconciledExpenseKopecks: number;
    unreconciledIncomeKopecks: number;
    unreconciledExpenseKopecks: number;
  }>();

  function ensureBankBucket(bankId: string | null) {
    const key = bankId ?? "__none__";
    const existing = summaryMap.get(key);
    if (existing) {
      return existing;
    }

    const created = {
      bankId,
      bankName: bankId ? (bankMap.get(bankId) ?? "Неизвестный банк") : "Без банка",
      reconciledIncomeKopecks: 0,
      reconciledExpenseKopecks: 0,
      unreconciledIncomeKopecks: 0,
      unreconciledExpenseKopecks: 0
    };
    summaryMap.set(key, created);
    return created;
  }

  for (const row of reconciledGrouped) {
    const bucket = ensureBankBucket(row.bankId ?? null);
    if (row.direction === "INCOME") {
      bucket.reconciledIncomeKopecks += row._sum.amountKopecks ?? 0;
    } else {
      bucket.reconciledExpenseKopecks += row._sum.amountKopecks ?? 0;
    }
  }

  for (const row of unreconciledGrouped) {
    const bucket = ensureBankBucket(row.bankId ?? null);
    if (row.direction === "INCOME") {
      bucket.unreconciledIncomeKopecks += row._sum.amountKopecks ?? 0;
    } else {
      bucket.unreconciledExpenseKopecks += row._sum.amountKopecks ?? 0;
    }
  }

  return {
    reconciledCount,
    unreconciledCount,
    banks: Array.from(summaryMap.values()).sort((left, right) => left.bankName.localeCompare(right.bankName, "ru"))
  };
}

async function listFinancialTransactionsForTenant(tenant: TenantRef, params: FinanceRegistryParams) {
  const search = params.q?.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 48)));
  const where = buildFinancialTransactionsWhere(tenant, params);

  const [rows, total, grouped, reconciliation] = await Promise.all([
    fetchFinancialTransactionRows(where, limit),
    prisma.financialTransaction.count({ where }),
    prisma.financialTransaction.groupBy({
      by: ["direction"],
      where,
      _sum: {
        amountKopecks: true
      }
    }),
    buildFinanceReconciliationSummary(where, params.reconciled)
  ]);

  const incomeKopecks = grouped.find((row) => row.direction === "INCOME")?._sum.amountKopecks ?? 0;
  const expenseKopecks = grouped.find((row) => row.direction === "EXPENSE")?._sum.amountKopecks ?? 0;

  return {
    tenant,
    total,
    query: search ?? null,
    filters: {
      type: params.type ?? null,
      contour: params.contour ?? null,
      status: params.status ?? null,
      direction: params.direction ?? null,
      paymentMethod: params.paymentMethod ?? null,
      articleId: params.articleId ?? null,
      bankId: params.bankId ?? null,
      clientId: params.clientId ?? null,
      branchId: params.branchId ?? null,
      dealKind: params.dealKind ?? null,
      dealNumber: params.dealNumber ?? null,
      amountFrom: params.amountFrom ?? null,
      amountTo: params.amountTo ?? null,
      reconciled: typeof params.reconciled === "boolean" ? params.reconciled : null,
      period: params.period ?? null,
      dateFrom: params.dateFrom ?? null,
      dateTo: params.dateTo ?? null
    },
    summary: {
      incomeKopecks,
      expenseKopecks,
      netKopecks: incomeKopecks - expenseKopecks
    },
    reconciliation,
    rows: rows.map(mapFinancialTransactionRow)
  };
}

export async function listFinanceArticles(params: {
  tenantSlug: string;
  includeArchived?: boolean;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  const rows = await prisma.$transaction(async (tx) => {
    await ensureFinanceArticles(tx, tenant.id);

    return tx.financeArticle.findMany({
      where: {
        tenantId: tenant.id,
        ...(params.includeArchived ? {} : { isActive: true })
      },
      orderBy: [
        { direction: "asc" },
        { sortOrder: "asc" },
        { name: "asc" }
      ],
      select: {
        id: true,
        direction: true,
        name: true,
        systemKey: true,
        isSystem: true,
        isActive: true,
        archivedAt: true,
        sortOrder: true,
        _count: {
          select: {
            transactions: true
          }
        }
      }
    });
  });

  return {
    tenant,
    total: rows.length,
    rows
  };
}

export async function createFinanceArticle(params: {
  tenantSlug: string;
  actorUserId: string;
  direction: TransactionDirection;
  name: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const name = params.name.trim();

  if (!name) {
    throw new HttpError(422, "Название статьи обязательно.");
  }

  return prisma.$transaction(async (tx) => {
    await ensureFinanceArticles(tx, tenant.id);

    const duplicate = await tx.financeArticle.findFirst({
      where: {
        tenantId: tenant.id,
        direction: params.direction,
        isActive: true,
        name: {
          equals: name,
          mode: "insensitive"
        }
      },
      select: {
        id: true
      }
    });

    if (duplicate) {
      throw new HttpError(409, "Активная статья с таким названием уже существует.");
    }

    const currentMax = await tx.financeArticle.aggregate({
      where: {
        tenantId: tenant.id,
        direction: params.direction
      },
      _max: {
        sortOrder: true
      }
    });

    const article = await tx.financeArticle.create({
      data: {
        tenantId: tenant.id,
        direction: params.direction,
        name,
        isSystem: false,
        isActive: true,
        sortOrder: (currentMax._max.sortOrder ?? 0) + 10
      },
      select: {
        id: true,
        direction: true,
        name: true,
        systemKey: true,
        isSystem: true,
        isActive: true,
        archivedAt: true,
        sortOrder: true
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId,
        entityType: "finance_article",
        entityId: article.id,
        action: "created",
        newValueText: JSON.stringify(article, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      article
    };
  });
}

export async function updateFinanceArticle(params: {
  tenantSlug: string;
  articleId: string;
  actorUserId: string;
  name?: string | null;
  isActive?: boolean | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  return prisma.$transaction(async (tx) => {
    await ensureFinanceArticles(tx, tenant.id);

    const article = await tx.financeArticle.findFirst({
      where: {
        id: params.articleId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        direction: true,
        name: true,
        systemKey: true,
        isSystem: true,
        isActive: true,
        archivedAt: true
      }
    });

    if (!article) {
      throw new HttpError(404, "Статья не найдена.");
    }

    const nextName = params.name?.trim() ? params.name.trim() : article.name;
    const nextIsActive = params.isActive == null ? article.isActive : params.isActive;

    const duplicate = await tx.financeArticle.findFirst({
      where: {
        tenantId: tenant.id,
        direction: article.direction,
        id: {
          not: article.id
        },
        isActive: true,
        name: {
          equals: nextName,
          mode: "insensitive"
        }
      },
      select: {
        id: true
      }
    });

    if (duplicate && nextIsActive) {
      throw new HttpError(409, "Активная статья с таким названием уже существует.");
    }

    const updated = await tx.financeArticle.update({
      where: {
        id: article.id
      },
      data: {
        name: nextName,
        isActive: nextIsActive,
        archivedAt: nextIsActive ? null : article.archivedAt ?? new Date()
      },
      select: {
        id: true,
        direction: true,
        name: true,
        systemKey: true,
        isSystem: true,
        isActive: true,
        archivedAt: true,
        sortOrder: true
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId,
        entityType: "finance_article",
        entityId: updated.id,
        action: "updated",
        oldValueText: JSON.stringify(article, null, 2),
        newValueText: JSON.stringify(updated, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      article: updated
    };
  });
}

export async function postManualFinanceTransaction(params: {
  tenantSlug: string;
  actorUserId: string;
  direction: TransactionDirection;
  articleId: string;
  amountKopecks: number;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  clientId?: string | null;
  branchId: string;
  happenedAt?: string | null;
  comment?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const amountKopecks = clampMoney(params.amountKopecks);
  const comment = params.comment?.trim() || null;

  if (amountKopecks <= 0) {
    throw new HttpError(422, "amountKopecks must be greater than 0");
  }

  return prisma.$transaction(async (tx) => {
    await ensureFinanceArticles(tx, tenant.id);

    const [branch, client, article] = await Promise.all([
      resolveFinanceBranch({
        tx,
        tenantId: tenant.id,
        branchId: params.branchId
      }),
      resolveFinanceClient({
        tx,
        tenantId: tenant.id,
        clientId: params.clientId
      }),
      resolveActiveFinanceArticle({
        tx,
        tenantId: tenant.id,
        articleId: params.articleId,
        direction: params.direction
      })
    ]);

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? null,
      paymentMethod: params.paymentMethod
    });

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        clientId: client?.id ?? null,
        bankId: bank?.id ?? null,
        articleId: article.id,
        createdById: params.actorUserId,
        type: "MANUAL_ADJUSTMENT",
        direction: params.direction,
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article.name,
        articleDirectionSnapshot: article.direction,
        comment,
        sourceLabel: "manual-finance-panel"
      },
      select: {
        id: true,
        type: true,
        direction: true,
        status: true,
        paymentMethod: true,
        amountKopecks: true,
        happenedAt: true,
        postedAt: true,
        comment: true
      }
    });

    if (client) {
      await refreshClientSnapshot(tx, {
        tenantId: tenant.id,
        clientId: client.id
      });
    }

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId,
        entityType: "financial_transaction",
        entityId: transaction.id,
        action: "manual_posted",
        reason: comment,
        newValueText: JSON.stringify({
          type: transaction.type,
          direction: transaction.direction,
          amountKopecks: transaction.amountKopecks,
          articleId: article.id,
          articleName: article.name,
          branchId: branch.id,
          bankId: bank?.id ?? null,
          clientId: client?.id ?? null
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      article,
      branch,
      client: client
        ? {
            id: client.id,
            fullName: client.fullName
          }
        : null,
      bank
    };
  });
}

export async function payRentalPenalty(params: {
  tenantSlug: string;
  rentalId: string;
  penaltyId: string;
  actorUserId: string;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
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
        branchId: true,
        clientId: true,
        bankId: true,
        dealNumber: true
      }
    });

    if (!rental) {
      throw new HttpError(404, `Rental '${params.rentalId}' was not found`);
    }

    const penalty = await tx.penalty.findFirst({
      where: {
        id: params.penaltyId,
        tenantId: tenant.id,
        rentalId: rental.id
      },
      select: {
        id: true,
        status: true,
        amountKopecks: true,
        reason: true,
        comment: true,
        paidTransactionId: true
      }
    });

    if (!penalty) {
      throw new HttpError(404, "Штраф аренды не найден.");
    }

    if (penalty.status !== "ACTIVE" || penalty.paidTransactionId) {
      throw new HttpError(409, "Этот штраф уже не доступен для оплаты.");
    }

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? rental.bankId,
      paymentMethod: params.paymentMethod
    });
    const article = await resolveSystemArticleAssignment(tx, tenant.id, "PENALTY_PAYMENT_IN");

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: rental.branchId,
        clientId: rental.clientId,
        rentalId: rental.id,
        bankId: bank?.id ?? (params.paymentMethod === "BANK" ? rental.bankId : null),
        articleId: article?.id ?? null,
        createdById: params.actorUserId,
        type: "PENALTY_PAYMENT_IN",
        direction: "INCOME",
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks: penalty.amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article?.name ?? null,
        articleDirectionSnapshot: article?.direction ?? null,
        comment: params.comment?.trim() || penalty.reason,
        sourceLabel: "rental-penalty-payment-api"
      },
      select: {
        id: true,
        amountKopecks: true,
        type: true,
        status: true,
        paymentMethod: true,
        happenedAt: true
      }
    });

    const updatedPenalty = await tx.penalty.update({
      where: {
        id: penalty.id
      },
      data: {
        status: "PAID",
        paidTransactionId: transaction.id
      },
      select: {
        id: true,
        status: true,
        amountKopecks: true,
        reason: true
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: rental.clientId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId,
        entityType: "penalty",
        entityId: penalty.id,
        action: "payment_posted",
        reason: params.comment?.trim() || penalty.reason,
        oldValueText: JSON.stringify({
          status: penalty.status,
          paidTransactionId: penalty.paidTransactionId
        }, null, 2),
        newValueText: JSON.stringify({
          status: updatedPenalty.status,
          transactionId: transaction.id,
          amountKopecks: transaction.amountKopecks,
          paymentMethod: transaction.paymentMethod
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      penalty: updatedPenalty,
      deal: {
        id: rental.id,
        dealNumber: rental.dealNumber
      }
    };
  });
}

export async function payBuyoutPenalty(params: {
  tenantSlug: string;
  buyoutId: string;
  penaltyId: string;
  actorUserId: string;
  paymentMethod: PaymentMethod;
  bankId?: string | null;
  happenedAt?: string | null;
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
        branchId: true,
        clientId: true,
        bankId: true,
        dealNumber: true
      }
    });

    if (!buyout) {
      throw new HttpError(404, `Buyout '${params.buyoutId}' was not found`);
    }

    const penalty = await tx.penalty.findFirst({
      where: {
        id: params.penaltyId,
        tenantId: tenant.id,
        buyoutId: buyout.id
      },
      select: {
        id: true,
        status: true,
        amountKopecks: true,
        reason: true,
        comment: true,
        paidTransactionId: true
      }
    });

    if (!penalty) {
      throw new HttpError(404, "Штраф выкупа не найден.");
    }

    if (penalty.status !== "ACTIVE" || penalty.paidTransactionId) {
      throw new HttpError(409, "Этот штраф уже не доступен для оплаты.");
    }

    const bank = await resolveBank({
      tx,
      tenantId: tenant.id,
      bankId: params.bankId ?? buyout.bankId,
      paymentMethod: params.paymentMethod
    });
    const article = await resolveSystemArticleAssignment(tx, tenant.id, "PENALTY_PAYMENT_IN");

    const transaction = await tx.financialTransaction.create({
      data: {
        tenantId: tenant.id,
        branchId: buyout.branchId,
        clientId: buyout.clientId,
        buyoutId: buyout.id,
        bankId: bank?.id ?? (params.paymentMethod === "BANK" ? buyout.bankId : null),
        articleId: article?.id ?? null,
        createdById: params.actorUserId,
        type: "PENALTY_PAYMENT_IN",
        direction: "INCOME",
        status: "POSTED",
        paymentMethod: params.paymentMethod,
        amountKopecks: penalty.amountKopecks,
        happenedAt: parseOptionalDate(params.happenedAt),
        postedAt: new Date(),
        articleNameSnapshot: article?.name ?? null,
        articleDirectionSnapshot: article?.direction ?? null,
        comment: params.comment?.trim() || penalty.reason,
        sourceLabel: "buyout-penalty-payment-api"
      },
      select: {
        id: true,
        amountKopecks: true,
        type: true,
        status: true,
        paymentMethod: true,
        happenedAt: true
      }
    });

    const updatedPenalty = await tx.penalty.update({
      where: {
        id: penalty.id
      },
      data: {
        status: "PAID",
        paidTransactionId: transaction.id
      },
      select: {
        id: true,
        status: true,
        amountKopecks: true,
        reason: true
      }
    });

    await refreshClientSnapshot(tx, {
      tenantId: tenant.id,
      clientId: buyout.clientId
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actorUserId,
        entityType: "penalty",
        entityId: penalty.id,
        action: "payment_posted",
        reason: params.comment?.trim() || penalty.reason,
        oldValueText: JSON.stringify({
          status: penalty.status,
          paidTransactionId: penalty.paidTransactionId
        }, null, 2),
        newValueText: JSON.stringify({
          status: updatedPenalty.status,
          transactionId: transaction.id,
          amountKopecks: transaction.amountKopecks,
          paymentMethod: transaction.paymentMethod
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      transaction,
      penalty: updatedPenalty,
      deal: {
        id: buyout.id,
        dealNumber: buyout.dealNumber
      }
    };
  });
}

export async function reverseFinancialTransaction(params: {
  tenantSlug: string;
  transactionId: string;
  actor: CurrentActor;
  reason: string;
  happenedAt?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const reason = params.reason.trim();

  if (!reason) {
    throw new HttpError(422, "Для reversal нужно указать причину.");
  }

  if (params.actor.tenantId !== tenant.id && !params.actor.isSupportUser) {
    throw new HttpError(403, "Нет доступа к этому tenant");
  }

  return prisma.$transaction(async (tx) => {
    const original = await tx.financialTransaction.findFirst({
      where: {
        id: params.transactionId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        clientId: true,
        rentalId: true,
        buyoutId: true,
        bankId: true,
        articleNameSnapshot: true,
        type: true,
        direction: true,
        status: true,
        correctionKind: true,
        reversalOfTransactionId: true,
        reversalReason: true,
        paymentMethod: true,
        amountKopecks: true,
        happenedAt: true,
        postedAt: true,
        comment: true,
        sourceLabel: true,
        externalReference: true,
        createdById: true,
        reversedByTransaction: {
          select: {
            id: true
          }
        },
        penalty: {
          select: {
            id: true,
            status: true,
            paidTransactionId: true,
            amountKopecks: true,
            reason: true,
            rentalId: true,
            buyoutId: true
          }
        }
      }
    });

    if (!original) {
      throw new HttpError(404, "Денежная операция не найдена.");
    }

    assertSupportedReversalTransaction({
      type: original.type,
      status: original.status,
      correctionKind: original.correctionKind,
      reversalOfTransactionId: original.reversalOfTransactionId ?? null,
      reversedByTransactionId: original.reversedByTransaction?.id ?? null
    });

    const permissionCode = resolveReversalPermissionCode(original.type);
    if (!permissionCode) {
      throw new HttpError(409, "Для этого типа денежной операции reversal пока не поддерживается.");
    }

    if (!actorHasPermission(params.actor, permissionCode)) {
      throw new HttpError(403, "Недостаточно прав для reversal этой денежной операции.", {
        required: permissionCode,
        transactionType: original.type
      });
    }

    assertActorBranchAccess(params.actor, permissionCode, original.branchId);

    if (original.type === "PENALTY_PAYMENT_IN") {
      if (!original.penalty || original.penalty.status !== "PAID" || original.penalty.paidTransactionId !== original.id) {
        throw new HttpError(409, "Нельзя сторнировать оплату штрафа: штраф уже не связан с этой транзакцией.");
      }
    }

    const reversal = await createCompensatingReversalTransaction(tx, {
      tenantId: tenant.id,
      originalTransaction: {
        id: original.id,
        branchId: original.branchId,
        clientId: original.clientId,
        rentalId: original.rentalId,
        buyoutId: original.buyoutId,
        bankId: original.bankId,
        type: original.type,
        direction: original.direction,
        paymentMethod: original.paymentMethod,
        amountKopecks: original.amountKopecks,
        articleNameSnapshot: original.articleNameSnapshot
      },
      actorUserId: params.actor.userId,
      reason,
      happenedAt: params.happenedAt,
      sourceLabel: original.type === "MANUAL_ADJUSTMENT"
        ? "manual-reversal-api"
        : "penalty-reversal-api"
    });

    let penaltyResult: {
      id: string;
      status: string;
      paidTransactionId: string | null;
    } | null = null;

    if (original.type === "PENALTY_PAYMENT_IN" && original.penalty) {
      penaltyResult = await tx.penalty.update({
        where: {
          id: original.penalty.id
        },
        data: {
          status: "ACTIVE",
          paidTransactionId: null
        },
        select: {
          id: true,
          status: true,
          paidTransactionId: true
        }
      });
    }

    if (original.clientId) {
      await refreshClientSnapshot(tx, {
        tenantId: tenant.id,
        clientId: original.clientId
      });
    }

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actor.userId,
        entityType: "financial_transaction",
        entityId: original.id,
        action: "reversal_posted",
        reason,
        oldValueText: JSON.stringify({
          transactionId: original.id,
          type: original.type,
          direction: original.direction,
          amountKopecks: original.amountKopecks,
          status: original.status,
          correctionKind: original.correctionKind
        }, null, 2),
        newValueText: JSON.stringify({
          reversalTransactionId: reversal.id,
          direction: reversal.direction,
          correctionKind: reversal.correctionKind,
          amountKopecks: reversal.amountKopecks,
          originalTransactionId: original.id
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    if (original.type === "PENALTY_PAYMENT_IN" && original.penalty && penaltyResult) {
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: params.actor.userId,
          entityType: "penalty",
          entityId: original.penalty.id,
          action: "payment_reversed",
          reason,
          oldValueText: JSON.stringify({
            status: original.penalty.status,
            paidTransactionId: original.penalty.paidTransactionId
          }, null, 2),
          newValueText: JSON.stringify({
            status: penaltyResult.status,
            paidTransactionId: penaltyResult.paidTransactionId,
            reversalTransactionId: reversal.id
          }, null, 2),
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null
        }
      });
    }

    return {
      tenant,
      originalTransaction: {
        id: original.id,
        type: original.type,
        direction: original.direction,
        amountKopecks: original.amountKopecks,
        status: original.status,
        correctionKind: original.correctionKind
      },
      reversalTransaction: reversal,
      penalty: penaltyResult
    };
  });
}

export async function setFinancialTransactionReconciled(params: {
  tenantSlug: string;
  transactionId: string;
  actor: CurrentActor;
  reconciled: boolean;
  note?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const note = params.note?.trim() || null;

  if (params.actor.tenantId !== tenant.id && !params.actor.isSupportUser) {
    throw new HttpError(403, "Нет доступа к этому tenant");
  }

  if (!actorHasPermission(params.actor, "finance.reconcile")) {
    throw new HttpError(403, "Недостаточно прав для сверки финансовой операции.", {
      required: "finance.reconcile"
    });
  }

  return prisma.$transaction(async (tx) => {
    const transaction = await tx.financialTransaction.findFirst({
      where: {
        id: params.transactionId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        branchId: true,
        type: true,
        direction: true,
        status: true,
        amountKopecks: true,
        reconciledAt: true,
        reconciledById: true,
        reconciliationNote: true
      }
    });

    if (!transaction) {
      throw new HttpError(404, "Денежная операция не найдена.");
    }

    if (transaction.status !== "POSTED") {
      throw new HttpError(409, "Сверять можно только проведенную денежную операцию.");
    }

    assertActorBranchAccess(params.actor, "finance.reconcile", transaction.branchId);

    const alreadyReconciled = Boolean(transaction.reconciledAt);
    const noteChanged = (transaction.reconciliationNote ?? null) !== note;
    const stateChanged = alreadyReconciled !== params.reconciled;

    if (!stateChanged && !noteChanged) {
      return {
        tenant,
        changed: false,
        transaction: {
          id: transaction.id,
          reconciledAt: transaction.reconciledAt,
          reconciliationNote: transaction.reconciliationNote,
          reconciledBy: transaction.reconciledById
            ? {
                id: transaction.reconciledById,
                fullName: params.actor.userId === transaction.reconciledById ? params.actor.fullName : null
              }
            : null
        }
      };
    }

    const updated = await tx.financialTransaction.update({
      where: {
        id: transaction.id
      },
      data: {
        reconciledAt: params.reconciled ? new Date() : null,
        reconciledById: params.reconciled ? params.actor.userId : null,
        reconciliationNote: params.reconciled ? note : null
      },
      select: {
        id: true,
        type: true,
        direction: true,
        amountKopecks: true,
        reconciledAt: true,
        reconciliationNote: true,
        reconciledBy: {
          select: {
            id: true,
            fullName: true
          }
        }
      }
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: params.actor.userId,
        entityType: "financial_transaction",
        entityId: transaction.id,
        action: params.reconciled ? "reconciled" : "reconciliation_cleared",
        reason: note,
        oldValueText: JSON.stringify({
          reconciledAt: transaction.reconciledAt,
          reconciledById: transaction.reconciledById,
          reconciliationNote: transaction.reconciliationNote
        }, null, 2),
        newValueText: JSON.stringify({
          reconciledAt: updated.reconciledAt,
          reconciledById: updated.reconciledBy?.id ?? null,
          reconciliationNote: updated.reconciliationNote
        }, null, 2),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null
      }
    });

    return {
      tenant,
      changed: true,
      transaction: updated
    };
  });
}

function escapeCsvCell(value: string | number | null | undefined) {
  const normalized = value == null ? "" : String(value);
  return `"${normalized.replaceAll("\"", "\"\"")}"`;
}

function formatCsvDate(value: Date | null | undefined) {
  return value ? value.toISOString() : "";
}

function formatCsvMoney(kopecks: number) {
  return (kopecks / 100).toFixed(2);
}

export async function exportFinancialTransactionsCsv(params: {
  tenantSlug: string;
  q?: string;
  type?: TransactionType;
  contour?: FinanceMoneyContour;
  status?: TransactionStatus;
  direction?: TransactionDirection;
  articleId?: string;
  bankId?: string;
  clientId?: string;
  branchId?: string;
  dealKind?: "RENTAL" | "BUYOUT";
  paymentMethod?: PaymentMethod;
  dealNumber?: string;
  amountFrom?: string;
  amountTo?: string;
  reconciled?: boolean;
  period?: FinanceQuickPeriod;
  dateFrom?: string;
  dateTo?: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  await prisma.$transaction(async (tx) => {
    await backfillSystemTransactionArticles(tx, tenant.id);
  });

  const where = buildFinancialTransactionsWhere(tenant, params);
  const rows = await fetchFinancialTransactionRows(where, 5000);

  const header = [
    "id",
    "type",
    "direction",
    "status",
    "correction_kind",
    "original_transaction_id",
    "reversed_by_transaction_id",
    "reversal_reason",
    "reconciled",
    "reconciled_at",
    "reconciled_by",
    "reconciliation_note",
    "amount_rub",
    "payment_method",
    "article",
    "client",
    "deal_kind",
    "deal_number",
    "bank",
    "branch",
    "happened_at",
    "posted_at",
    "source_label",
    "comment",
    "created_by"
  ];

  const lines = rows.map((row) => {
    const deal = row.rental
      ? { kind: "RENTAL", dealNumber: row.rental.dealNumber }
      : row.buyout
        ? { kind: "BUYOUT", dealNumber: row.buyout.dealNumber }
        : null;

    return [
      row.id,
      row.type,
      row.direction,
      row.status,
      row.correctionKind,
      row.reversalOfTransactionId,
      row.reversedByTransaction?.id ?? null,
      row.reversalReason,
      row.reconciledAt ? "true" : "false",
      formatCsvDate(row.reconciledAt),
      row.reconciledBy?.fullName ?? null,
      row.reconciliationNote,
      formatCsvMoney(row.amountKopecks),
      row.paymentMethod,
      row.articleNameSnapshot ?? row.article?.name ?? null,
      row.client?.fullName ?? null,
      deal?.kind ?? null,
      deal?.dealNumber ?? null,
      row.bank?.name ?? null,
      row.branch?.name ?? null,
      formatCsvDate(row.happenedAt),
      formatCsvDate(row.postedAt),
      row.sourceLabel,
      row.comment,
      row.createdBy?.fullName ?? null
    ].map(escapeCsvCell).join(",");
  });

  return {
    tenant,
    total: rows.length,
    fileName: `finance-export-${tenant.slug}-${formatTodayYmdMoscow()}.csv`,
    content: `\uFEFF${header.map(escapeCsvCell).join(",")}\n${lines.join("\n")}`
  };
}

export async function getFinanceWorkspace(params: {
  tenantSlug: string;
  q?: string;
  type?: TransactionType;
  contour?: FinanceMoneyContour;
  status?: TransactionStatus;
  direction?: TransactionDirection;
  articleId?: string;
  bankId?: string;
  clientId?: string;
  branchId?: string;
  dealKind?: "RENTAL" | "BUYOUT";
  paymentMethod?: PaymentMethod;
  dealNumber?: string;
  amountFrom?: string;
  amountTo?: string;
  reconciled?: boolean;
  period?: FinanceQuickPeriod;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  await prisma.$transaction(async (tx) => {
    await backfillSystemTransactionArticles(tx, tenant.id);
  });

  const [registry, articles, banks, branches, clients] = await Promise.all([
    listFinancialTransactionsForTenant(tenant, params),
    prisma.financeArticle.findMany({
      where: {
        tenantId: tenant.id
      },
      orderBy: [
        { direction: "asc" },
        { sortOrder: "asc" },
        { name: "asc" }
      ],
      select: {
        id: true,
        direction: true,
        name: true,
        systemKey: true,
        isSystem: true,
        isActive: true,
        archivedAt: true,
        sortOrder: true,
        _count: {
          select: {
            transactions: true
          }
        }
      }
    }),
    prisma.bank.findMany({
      where: {
        tenantId: tenant.id,
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
      orderBy: {
        name: "asc"
      },
      select: {
        id: true,
        name: true
      }
    }),
    prisma.branch.findMany({
      where: {
        tenantId: tenant.id,
        isActive: true,
        ...(params.branchId ? { id: params.branchId } : {})
      },
      orderBy: {
        name: "asc"
      },
      select: {
        id: true,
        name: true,
        code: true
      }
    }),
    prisma.client.findMany({
      where: {
        tenantId: tenant.id,
        ...(params.branchId ? { branchId: params.branchId } : {})
      },
      orderBy: [
        { updatedAt: "desc" },
        { fullName: "asc" }
      ],
      take: 240,
      select: {
        id: true,
        fullName: true,
        branch: {
          select: {
            id: true,
            name: true,
            code: true
          }
        }
      }
    })
  ]);

  return {
    tenant,
    registry,
    filters: {
      periods: [
        { code: "TODAY", label: "Сегодня" },
        { code: "LAST_7_DAYS", label: "7 дней" },
        { code: "LAST_30_DAYS", label: "30 дней" },
        { code: "THIS_MONTH", label: "Этот месяц" },
        { code: "PREVIOUS_MONTH", label: "Прошлый месяц" }
      ],
      dealKinds: [
        { code: "RENTAL", label: "Аренда" },
        { code: "BUYOUT", label: "Выкуп" }
      ],
      directions: [
        { code: "INCOME", label: "Приход" },
        { code: "EXPENSE", label: "Расход" }
      ],
      paymentMethods: [
        { code: "CASH", label: "Наличные" },
        { code: "BANK", label: "Перевод" }
      ],
      reconciliationStates: [
        { code: "true", label: "Сверено" },
        { code: "false", label: "Не сверено" }
      ],
      statuses: [
        { code: "DRAFT", label: "Черновик" },
        { code: "POSTED", label: "Проведено" },
        { code: "CANCELED", label: "Отменено" }
      ],
      banks,
      branches,
      clients,
      articles
    }
  };
}

export async function listFinancialTransactions(params: {
  tenantSlug: string;
  q?: string;
  type?: TransactionType;
  contour?: FinanceMoneyContour;
  status?: TransactionStatus;
  direction?: TransactionDirection;
  articleId?: string;
  bankId?: string;
  clientId?: string;
  branchId?: string;
  dealKind?: "RENTAL" | "BUYOUT";
  paymentMethod?: PaymentMethod;
  dealNumber?: string;
  amountFrom?: string;
  amountTo?: string;
  reconciled?: boolean;
  period?: FinanceQuickPeriod;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  await prisma.$transaction(async (tx) => {
    await backfillSystemTransactionArticles(tx, tenant.id);
  });

  return listFinancialTransactionsForTenant(tenant, params);
}

export async function listBanks(params: {
  tenantSlug: string;
  q?: string;
  branchId?: string | null;
  limit?: number;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const search = params.q?.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 24)));
  const andConditions: Prisma.BankWhereInput[] = [];

  if (params.branchId) {
    andConditions.push({
      OR: [
        { branchId: params.branchId },
        { branchId: null }
      ]
    });
  }

  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { comment: { contains: search, mode: "insensitive" } }
      ]
    });
  }

  const where: Prisma.BankWhereInput = {
    tenantId: tenant.id,
    ...(andConditions.length > 0 ? { AND: andConditions } : {})
  };

  const rows = await prisma.bank.findMany({
    where,
    orderBy: [
      { isActive: "desc" },
      { updatedAt: "desc" }
    ],
    take: limit,
    select: {
      id: true,
      name: true,
      phone: true,
      comment: true,
      isActive: true,
      instructionType: true,
      branch: {
        select: {
          name: true
        }
      },
      assets: {
        orderBy: {
          updatedAt: "desc"
        },
        take: 3,
        select: {
          id: true,
          type: true,
          title: true,
          textBody: true,
          filePath: true,
          isPrimary: true
        }
      },
      _count: {
        select: {
          rentals: true,
          buyouts: true,
          transactions: true
        }
      }
    }
  });

  const total = await prisma.bank.count({ where });

  return {
    tenant,
    total,
    query: search ?? null,
    rows
  };
}
