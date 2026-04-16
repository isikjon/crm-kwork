import type { Prisma } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

type RentalRateInput = {
  durationDays: number;
  amountKopecks: number;
  label: string;
};

export function buildRentalTariffSnapshotRows(params: {
  tenantId: string;
  rentalId: string;
  tariffGroupCode: string;
  rates: RentalRateInput[];
}) {
  return params.rates
    .map((rate) => ({
      tenantId: params.tenantId,
      rentalId: params.rentalId,
      durationDays: Math.max(1, Math.trunc(rate.durationDays || 0)),
      tariffCode: `${params.tariffGroupCode}-${Math.max(1, Math.trunc(rate.durationDays || 0))}`,
      label: rate.label.trim(),
      amountKopecks: Math.max(0, Math.trunc(rate.amountKopecks || 0))
    }))
    .filter((rate) => rate.durationDays > 0);
}

export async function replaceRentalTariffSnapshots(tx: TransactionClient, params: {
  tenantId: string;
  rentalId: string;
  tariffGroupCode: string;
  rates: RentalRateInput[];
}) {
  const rows = buildRentalTariffSnapshotRows(params);

  await tx.rentalTariffSnapshot.deleteMany({
    where: {
      tenantId: params.tenantId,
      rentalId: params.rentalId
    }
  });

  if (rows.length === 0) {
    return [];
  }

  await tx.rentalTariffSnapshot.createMany({
    data: rows
  });

  return rows;
}

export async function ensureRentalTariffSnapshots(tx: TransactionClient, params: {
  tenantId: string;
  rentalId: string;
}) {
  const existing = await tx.rentalTariffSnapshot.findMany({
    where: {
      tenantId: params.tenantId,
      rentalId: params.rentalId
    },
    orderBy: {
      durationDays: "asc"
    },
    select: {
      id: true,
      durationDays: true,
      tariffCode: true,
      label: true,
      amountKopecks: true
    }
  });

  if (existing.length > 0) {
    return existing;
  }

  const rental = await tx.rental.findFirst({
    where: {
      id: params.rentalId,
      tenantId: params.tenantId
    },
    select: {
      id: true,
      tariffCode: true,
      tariffLabel: true,
      plannedPaymentKopecks: true,
      bikeUnit: {
        select: {
          rentalTariffGroup: {
            select: {
              code: true,
              rates: {
                orderBy: {
                  durationDays: "asc"
                },
                select: {
                  durationDays: true,
                  amountKopecks: true,
                  label: true
                }
              }
            }
          }
        }
      }
    }
  });

  if (!rental) {
    return [];
  }

  const group = rental.bikeUnit.rentalTariffGroup;
  if (group?.rates?.length) {
    return await replaceRentalTariffSnapshots(tx, {
      tenantId: params.tenantId,
      rentalId: params.rentalId,
      tariffGroupCode: group.code,
      rates: group.rates
    });
  }

  const currentDays = Number(rental.tariffCode.match(/(\d+)/)?.[1] ?? rental.tariffLabel.match(/(\d+)/)?.[1] ?? 0) || 7;
  const fallbackRows = await replaceRentalTariffSnapshots(tx, {
    tenantId: params.tenantId,
    rentalId: params.rentalId,
    tariffGroupCode: rental.tariffCode.replace(/-\d+$/, "") || "legacy",
    rates: [
      {
        durationDays: currentDays,
        amountKopecks: rental.plannedPaymentKopecks,
        label: rental.tariffLabel
      }
    ]
  });

  return fallbackRows.map((row) => ({
    id: "",
    durationDays: row.durationDays,
    tariffCode: row.tariffCode,
    label: row.label,
    amountKopecks: row.amountKopecks
  }));
}
