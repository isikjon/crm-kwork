import type {
  BuyoutStatus,
  Prisma,
  RentalStatus,
  ScheduleCadence,
  ScheduleItemStatus
} from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

interface RentalLegacyCycleInput {
  dueKopecks: number;
  paidKopecks: number;
  paidDays: number;
  updatedAt?: string | null;
}

interface BuyoutPresetInput {
  amountKopecks: number;
  intervalUnit: string;
  intervalValue: number;
}

interface PaymentScheduleSeedItem {
  sequenceNumber: number;
  dueAt: Date;
  amountKopecks: number;
  paidKopecks: number;
  status: ScheduleItemStatus;
  closedAt: Date | null;
}

interface PaymentScheduleSeed {
  cadence: ScheduleCadence;
  intervalValue: number;
  cycleAmountKopecks: number;
  nextDueAt: Date | null;
  nextOutstandingKopecks: number;
  outstandingTotalKopecks: number;
  overdueDays: number;
  items: PaymentScheduleSeedItem[];
}

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

  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function parseYmdUtcNoon(ymd: string) {
  const match = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return new Date();
  }

  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0));
}

function dateToYmd(date: Date) {
  return new Date(date).toISOString().slice(0, 10);
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

function shiftByCadence(date: Date, cadence: ScheduleCadence, intervalValue: number, step = 1) {
  const normalizedStep = clampPositiveInt(step, 1) * clampPositiveInt(intervalValue, 1);

  if (cadence === "MONTHLY") {
    return addMonthsUtc(date, normalizedStep);
  }

  if (cadence === "WEEKLY") {
    return addDaysUtc(date, normalizedStep * 7);
  }

  return addDaysUtc(date, normalizedStep);
}

function diffDaysByYmd(laterYmd: string, earlier: Date) {
  const laterDate = parseYmdUtcNoon(laterYmd);
  const earlierDate = parseYmdUtcNoon(dateToYmd(earlier));
  const delta = laterDate.getTime() - earlierDate.getTime();
  return Math.max(0, Math.floor(delta / 86_400_000));
}

function resolveRentalTariffDays(params: { tariffCode: string; tariffLabel: string }) {
  const fromCode = params.tariffCode.match(/(\d+)/)?.[1];
  if (fromCode) {
    return clampPositiveInt(Number(fromCode), 7);
  }

  const fromLabel = params.tariffLabel.match(/(\d+)/)?.[1];
  if (fromLabel) {
    return clampPositiveInt(Number(fromLabel), 7);
  }

  return 7;
}

function resolveCadenceFromDays(days: number): { cadence: ScheduleCadence; intervalValue: number } {
  const normalizedDays = clampPositiveInt(days, 7);

  if (normalizedDays >= 30 && normalizedDays % 30 === 0) {
    return {
      cadence: "MONTHLY",
      intervalValue: Math.max(1, Math.trunc(normalizedDays / 30))
    };
  }

  if (normalizedDays >= 7 && normalizedDays % 7 === 0) {
    return {
      cadence: "WEEKLY",
      intervalValue: Math.max(1, Math.trunc(normalizedDays / 7))
    };
  }

  return {
    cadence: "DAILY",
    intervalValue: normalizedDays
  };
}

function resolveItemStatus(params: {
  dueAt: Date;
  amountKopecks: number;
  paidKopecks: number;
  graceDays?: number;
}) {
  const amountKopecks = clampMoney(params.amountKopecks);
  const paidKopecks = Math.min(amountKopecks, clampMoney(params.paidKopecks));
  const outstandingKopecks = Math.max(0, amountKopecks - paidKopecks);

  if (outstandingKopecks <= 0) {
    return "PAID" as const;
  }

  const overdueBorder = addDaysUtc(params.dueAt, clampPositiveInt(params.graceDays ?? 0, 0));
  const isOverdue = overdueBorder.getTime() < parseYmdUtcNoon(formatTodayYmdMoscow()).getTime();

  if (isOverdue) {
    return "OVERDUE" as const;
  }

  if (paidKopecks > 0) {
    return "PARTIAL" as const;
  }

  return "PLANNED" as const;
}

// Schedule seed is the source of truth for next due date, debt and overdue snapshot after create/import rebuilds.
function buildScheduleSnapshot(params: {
  cadence: ScheduleCadence;
  intervalValue: number;
  cycleAmountKopecks: number;
  items: Array<{
    sequenceNumber: number;
    dueAt: Date;
    amountKopecks: number;
    paidKopecks: number;
    graceDays?: number;
  }>;
}): PaymentScheduleSeed {
  const items = params.items.map((item) => {
    const status = resolveItemStatus({
      dueAt: item.dueAt,
      amountKopecks: item.amountKopecks,
      paidKopecks: item.paidKopecks,
      graceDays: item.graceDays ?? 0
    });
    const outstandingKopecks = Math.max(0, clampMoney(item.amountKopecks) - clampMoney(item.paidKopecks));

    return {
      sequenceNumber: item.sequenceNumber,
      dueAt: item.dueAt,
      amountKopecks: clampMoney(item.amountKopecks),
      paidKopecks: Math.min(clampMoney(item.amountKopecks), clampMoney(item.paidKopecks)),
      status,
      closedAt: outstandingKopecks === 0 ? item.dueAt : null,
      outstandingKopecks
    };
  });

  const outstandingItems = items
    .filter((item) => item.outstandingKopecks > 0)
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());

  const nextOutstanding = outstandingItems[0] ?? null;
  const overdueCandidate = outstandingItems.find((item) => item.status === "OVERDUE") ?? null;
  const overdueDays = overdueCandidate ? diffDaysByYmd(formatTodayYmdMoscow(), overdueCandidate.dueAt) : 0;

  return {
    cadence: params.cadence,
    intervalValue: clampPositiveInt(params.intervalValue, 1),
    cycleAmountKopecks: clampMoney(params.cycleAmountKopecks),
    nextDueAt: nextOutstanding?.dueAt ?? null,
    nextOutstandingKopecks: nextOutstanding?.outstandingKopecks ?? 0,
    outstandingTotalKopecks: outstandingItems.reduce((sum, item) => sum + item.outstandingKopecks, 0),
    overdueDays,
    items
  };
}

function distributeEvenly(totalKopecks: number, cycles: number) {
  const total = clampMoney(totalKopecks);
  const normalizedCycles = clampPositiveInt(cycles, 1);
  const base = Math.floor(total / normalizedCycles);
  let remainder = total - base * normalizedCycles;

  return Array.from({ length: normalizedCycles }, () => {
    const amount = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return amount;
  });
}

function buildPresetAmounts(totalKopecks: number, presetAmountKopecks: number) {
  const amounts: number[] = [];
  let remaining = clampMoney(totalKopecks);
  const presetAmount = clampMoney(presetAmountKopecks);

  if (presetAmount <= 0 || remaining <= 0) {
    return amounts;
  }

  while (remaining > 0) {
    const amount = Math.min(presetAmount, remaining);
    amounts.push(amount);
    remaining -= amount;
  }

  return amounts;
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

function resolveBuyoutPresetForCadence(
  cadence: ScheduleCadence,
  presets: BuyoutPresetInput[]
) {
  return presets.find((preset) => {
    if (cadence === "MONTHLY") {
      return preset.intervalUnit === "months";
    }

    if (cadence === "WEEKLY") {
      return preset.intervalUnit === "days" && clampPositiveInt(preset.intervalValue, 1) === 7;
    }

    return preset.intervalUnit === "days" && clampPositiveInt(preset.intervalValue, 1) === 1;
  }) ?? presets[0] ?? null;
}

function buildRentalScheduleSeed(params: {
  status: RentalStatus;
  startsAt: Date;
  nextPaymentAt: Date | null;
  tariffCode: string;
  tariffLabel: string;
  plannedPaymentKopecks: number;
  graceDays: number;
  cycles: RentalLegacyCycleInput[];
}): PaymentScheduleSeed {
  const tariffDays = resolveRentalTariffDays({
    tariffCode: params.tariffCode,
    tariffLabel: params.tariffLabel
  });
  const cadence = resolveCadenceFromDays(tariffDays);
  const dueAt = params.nextPaymentAt ?? params.startsAt;
  const aggregatedCycle = params.cycles.reduce(
    (summary, cycle) => {
      summary.dueKopecks += clampMoney(cycle.dueKopecks);
      summary.paidKopecks += clampMoney(cycle.paidKopecks);
      return summary;
    },
    {
      dueKopecks: 0,
      paidKopecks: 0
    }
  );

  const cycleAmountKopecks = aggregatedCycle.dueKopecks > 0
    ? aggregatedCycle.dueKopecks
    : clampMoney(params.plannedPaymentKopecks);
  const currentOutstandingKopecks = Math.max(0, aggregatedCycle.dueKopecks - aggregatedCycle.paidKopecks);
  const forceClosedCycle = (params.status === "COMPLETED" || params.status === "CANCELED")
    && currentOutstandingKopecks === 0;
  const paidKopecks = forceClosedCycle
    ? cycleAmountKopecks
    : aggregatedCycle.paidKopecks;

  return buildScheduleSnapshot({
    cadence: cadence.cadence,
    intervalValue: cadence.intervalValue,
    cycleAmountKopecks,
    items: [
      {
        sequenceNumber: 1,
        dueAt,
        amountKopecks: cycleAmountKopecks,
        paidKopecks,
        graceDays: params.graceDays
      }
    ]
  });
}

function buildBuyoutScheduleSeed(params: {
  startsAt: Date;
  nextPaymentAt: Date | null;
  cadence: ScheduleCadence;
  termMonths: number;
  financedAmountKopecks: number;
  residualDebtKopecks: number;
  preset: BuyoutPresetInput | null;
  status: BuyoutStatus;
}): PaymentScheduleSeed {
  const dueAt = params.nextPaymentAt ?? params.startsAt;
  const presetAmounts = params.preset
    ? buildPresetAmounts(params.financedAmountKopecks, params.preset.amountKopecks)
    : [];
  const distributedAmounts = presetAmounts.length > 0
    ? presetAmounts
    : distributeEvenly(
        params.financedAmountKopecks,
        resolveBuyoutCycleCount(params.termMonths, params.cadence)
      );
  const effectiveCadence = params.preset?.intervalUnit === "months"
    ? "MONTHLY"
    : params.cadence;
  const intervalValue = params.preset
    ? params.preset.intervalUnit === "months"
      ? clampPositiveInt(params.preset.intervalValue, 1)
      : effectiveCadence === "WEEKLY"
        ? Math.max(1, Math.trunc(clampPositiveInt(params.preset.intervalValue, 7) / 7))
        : clampPositiveInt(params.preset.intervalValue, 1)
    : 1;
  let remainingPaid = Math.max(
    0,
    clampMoney(params.financedAmountKopecks) - clampMoney(params.residualDebtKopecks)
  );
  const forceFullyPaid = params.status === "CLOSED" && clampMoney(params.residualDebtKopecks) === 0;

  const items = distributedAmounts.map((amountKopecks, index) => {
    let paidKopecks = 0;
    if (forceFullyPaid) {
      paidKopecks = amountKopecks;
    } else if (remainingPaid > 0) {
      paidKopecks = Math.min(amountKopecks, remainingPaid);
      remainingPaid -= paidKopecks;
    }

    return {
      sequenceNumber: index + 1,
      dueAt: index === 0 ? dueAt : shiftByCadence(dueAt, effectiveCadence, intervalValue, index),
      amountKopecks,
      paidKopecks
    };
  });

  return buildScheduleSnapshot({
    cadence: effectiveCadence,
    intervalValue,
    cycleAmountKopecks: distributedAmounts[0] ?? clampMoney(params.financedAmountKopecks),
    items
  });
}

function resolveRentalOperationalStatus(currentStatus: RentalStatus, overdueDays: number) {
  if (currentStatus === "COMPLETED" || currentStatus === "CANCELED" || currentStatus === "RETURN_PREP" || currentStatus === "HOLD") {
    return currentStatus;
  }

  return overdueDays > 0 ? "OVERDUE" : "ACTIVE";
}

function resolveBuyoutOperationalStatus(currentStatus: BuyoutStatus, overdueDays: number) {
  if (currentStatus === "CLOSED" || currentStatus === "TERMINATED" || currentStatus === "HOLD") {
    return currentStatus;
  }

  return overdueDays > 0 ? "OVERDUE" : "ACTIVE";
}

async function replaceScheduleForOwner(params: {
  tx: TransactionClient;
  tenantId: string;
  ownerType: "RENTAL" | "BUYOUT";
  rentalId?: string;
  buyoutId?: string;
  seed: PaymentScheduleSeed;
}) {
  // Replace the whole persisted schedule atomically so create/import flows never leave mixed old/new payment items.
  await params.tx.paymentSchedule.deleteMany({
    where: {
      tenantId: params.tenantId,
      ...(params.ownerType === "RENTAL" ? { rentalId: params.rentalId } : { buyoutId: params.buyoutId })
    }
  });

  const schedule = await params.tx.paymentSchedule.create({
    data: {
      tenantId: params.tenantId,
      rentalId: params.ownerType === "RENTAL" ? params.rentalId ?? null : null,
      buyoutId: params.ownerType === "BUYOUT" ? params.buyoutId ?? null : null,
      ownerType: params.ownerType,
      cadence: params.seed.cadence,
      intervalValue: params.seed.intervalValue,
      startsAt: params.seed.items[0]?.dueAt ?? new Date(),
      nextDueAt: params.seed.nextDueAt,
      cycleAmountKopecks: params.seed.cycleAmountKopecks
    },
    select: { id: true }
  });

  if (params.seed.items.length > 0) {
    await params.tx.paymentScheduleItem.createMany({
      data: params.seed.items.map((item) => ({
        tenantId: params.tenantId,
        paymentScheduleId: schedule.id,
        sequenceNumber: item.sequenceNumber,
        dueAt: item.dueAt,
        amountKopecks: item.amountKopecks,
        paidKopecks: item.paidKopecks,
        status: item.status,
        closedAt: item.closedAt
      }))
    });
  }

  return schedule.id;
}

export async function rebuildRentalSchedule(params: {
  tx: TransactionClient;
  rental: {
    id: string;
    tenantId: string;
    status: RentalStatus;
    startsAt: Date;
    nextPaymentAt: Date | null;
    plannedPaymentKopecks: number;
    graceDays: number;
    tariffCode: string;
    tariffLabel: string;
  };
  cycles: RentalLegacyCycleInput[];
}) {
  // Rental rebuild converts current tariff data plus legacy partial cycles into one deterministic schedule snapshot.
  const seed = buildRentalScheduleSeed({
    status: params.rental.status,
    startsAt: params.rental.startsAt,
    nextPaymentAt: params.rental.nextPaymentAt,
    tariffCode: params.rental.tariffCode,
    tariffLabel: params.rental.tariffLabel,
    plannedPaymentKopecks: params.rental.plannedPaymentKopecks,
    graceDays: params.rental.graceDays,
    cycles: params.cycles
  });

  await replaceScheduleForOwner({
    tx: params.tx,
    tenantId: params.rental.tenantId,
    ownerType: "RENTAL",
    rentalId: params.rental.id,
    seed
  });

  await params.tx.rental.update({
    where: { id: params.rental.id },
    data: {
      status: resolveRentalOperationalStatus(params.rental.status, seed.overdueDays),
      nextPaymentAt: seed.nextDueAt,
      plannedPaymentKopecks: seed.cycleAmountKopecks,
      debtKopecks: seed.outstandingTotalKopecks,
      overdueDays: seed.overdueDays
    }
  });

  return seed;
}

export async function rebuildBuyoutSchedule(params: {
  tx: TransactionClient;
  buyout: {
    id: string;
    tenantId: string;
    status: BuyoutStatus;
    startsAt: Date;
    nextPaymentAt: Date | null;
    termMonths: number;
    paymentCadence: ScheduleCadence;
    financedAmountKopecks: number;
    residualDebtKopecks: number;
  };
  presets: BuyoutPresetInput[];
}) {
  // Buyout rebuild recalculates residual debt from financed amount and cadence preset instead of trusting UI-level totals.
  const preset = resolveBuyoutPresetForCadence(params.buyout.paymentCadence, params.presets);
  const seed = buildBuyoutScheduleSeed({
    startsAt: params.buyout.startsAt,
    nextPaymentAt: params.buyout.nextPaymentAt,
    cadence: params.buyout.paymentCadence,
    termMonths: params.buyout.termMonths,
    financedAmountKopecks: params.buyout.financedAmountKopecks,
    residualDebtKopecks: params.buyout.residualDebtKopecks,
    preset,
    status: params.buyout.status
  });

  await replaceScheduleForOwner({
    tx: params.tx,
    tenantId: params.buyout.tenantId,
    ownerType: "BUYOUT",
    buyoutId: params.buyout.id,
    seed
  });

  await params.tx.buyout.update({
    where: { id: params.buyout.id },
    data: {
      status: resolveBuyoutOperationalStatus(params.buyout.status, seed.overdueDays),
      nextPaymentAt: seed.nextDueAt,
      residualDebtKopecks: seed.outstandingTotalKopecks,
      overdueDays: seed.overdueDays
    }
  });

  return seed;
}
