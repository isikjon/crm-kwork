import { BuyoutStatus, RentalStatus, RentalTariffGroupKind, type Prisma } from "@prisma/client";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { replaceRentalTariffSnapshots } from "../deals/rental-tariff-snapshot-service.js";
import { isAssignableBikeUnitName } from "../fleet/bike-unit-classifier.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";

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

type TariffRateInput = {
  label: string;
  durationDays: number;
  amountKopecks: number;
  bonusDays?: number;
};

type TariffRulesInput = {
  depositTargetKopecks: number;
  autoPenaltyEnabled: boolean;
  autoPenaltyDailyKopecks: number;
  graceDays: number;
};

function clampMoney(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(500_000_000, Math.trunc(value)));
}

function clampCount(value: number, max = 365) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(max, Math.trunc(value)));
}

function sanitizeText(value: string, fallback: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

function slugifyName(value: string) {
  return value
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "tariff-group";
}

function normalizeRates(rates: TariffRateInput[], kind: RentalTariffGroupKind) {
  const prepared = rates
    .map((rate, index) => ({
      label: sanitizeText(rate.label, `Ставка ${index + 1}`),
      durationDays: Math.max(1, Math.min(3650, Math.trunc(rate.durationDays))),
      amountKopecks: clampMoney(rate.amountKopecks),
      bonusDays: kind === RentalTariffGroupKind.RENTAL ? clampCount(rate.bonusDays ?? 0, 90) : 0
    }))
    .sort((left, right) => left.durationDays - right.durationDays);

  const dedup = new Set<number>();
  for (const rate of prepared) {
    if (dedup.has(rate.durationDays)) {
      throw new HttpError(422, `Повторяющийся срок тарифа: ${rate.durationDays} дн.`);
    }
    dedup.add(rate.durationDays);
  }

  if (!prepared.length) {
    throw new HttpError(422, "Нужно добавить хотя бы одну ставку.");
  }

  return prepared;
}

function normalizeRules(input: TariffRulesInput) {
  return {
    depositTargetKopecks: clampMoney(input.depositTargetKopecks),
    autoPenaltyEnabled: Boolean(input.autoPenaltyEnabled),
    manualPenaltyEnabled: true,
    autoPenaltyDailyKopecks: clampMoney(input.autoPenaltyDailyKopecks),
    graceDays: clampCount(input.graceDays)
  };
}

async function resolveUniqueCode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  requestedName: string
) {
  const base = slugifyName(requestedName);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await tx.rentalTariffGroup.findFirst({
      where: {
        tenantId,
        code: candidate
      },
      select: {
        id: true
      }
    });

    if (!existing) {
      return candidate;
    }
  }

  throw new HttpError(409, "Не удалось подобрать уникальный код тарифной группы.");
}

async function createStarterGroup(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    code: string;
    name: string;
    description: string;
    kind: RentalTariffGroupKind;
    depositTargetKopecks: number;
    autoPenaltyEnabled: boolean;
    autoPenaltyDailyKopecks: number;
    graceDays: number;
    rates: TariffRateInput[];
  }
) {
  const existing = await tx.rentalTariffGroup.findFirst({
    where: {
      tenantId: params.tenantId,
      code: params.code
    },
    select: {
      id: true
    }
  });

  if (existing) {
    return;
  }

  const rates = normalizeRates(params.rates, params.kind);
  await tx.rentalTariffGroup.create({
    data: {
      tenantId: params.tenantId,
      code: params.code,
      kind: params.kind,
      name: params.name,
      description: params.description,
      depositTargetKopecks: params.depositTargetKopecks,
      autoPenaltyEnabled: params.autoPenaltyEnabled,
      manualPenaltyEnabled: true,
      autoPenaltyDailyKopecks: params.autoPenaltyDailyKopecks,
      graceDays: params.graceDays,
      rates: {
        create: rates.map((rate, index) => ({
          tenantId: params.tenantId,
          label: rate.label,
          durationDays: rate.durationDays,
          amountKopecks: rate.amountKopecks,
          bonusDays: rate.bonusDays,
          sortOrder: index
        }))
      }
    }
  });
}

async function ensureStarterTariffGroups(tenantId: string) {
  const [rentalCount, buyoutCount] = await Promise.all([
    prisma.rentalTariffGroup.count({
      where: {
        tenantId,
        kind: RentalTariffGroupKind.RENTAL
      }
    }),
    prisma.rentalTariffGroup.count({
      where: {
        tenantId,
        kind: RentalTariffGroupKind.BUYOUT
      }
    })
  ]);

  await prisma.$transaction(async (tx) => {
    if (rentalCount === 0) {
      await createStarterGroup(tx, {
        tenantId,
        code: "base-rental-group",
        kind: RentalTariffGroupKind.RENTAL,
        name: "Базовая аренда 700 / 4500 / 15000",
        description: "Стартовая группа аренды: 1 день = 700 руб., 7 дней = 4500 руб., 30 дней = 15000 руб.",
        depositTargetKopecks: 0,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: 0,
        graceDays: 0,
        rates: [
          { label: "1 день", durationDays: 1, amountKopecks: 70_000, bonusDays: 0 },
          { label: "7 дней", durationDays: 7, amountKopecks: 450_000, bonusDays: 0 },
          { label: "30 дней", durationDays: 30, amountKopecks: 1_500_000, bonusDays: 0 }
        ]
      });
    }

    if (buyoutCount === 0) {
      await createStarterGroup(tx, {
        tenantId,
        code: "buyout-5500-22000",
        kind: RentalTariffGroupKind.BUYOUT,
        name: "Выкуп 5 500 / 22 000",
        description: "Стартовая группа выкупа: неделя = 5500 руб., месяц = 22000 руб.",
        depositTargetKopecks: 0,
        autoPenaltyEnabled: false,
        autoPenaltyDailyKopecks: 0,
        graceDays: 0,
        rates: [
          { label: "Неделя", durationDays: 7, amountKopecks: 550_000 },
          { label: "Месяц", durationDays: 30, amountKopecks: 2_200_000 }
        ]
      });

      await createStarterGroup(tx, {
        tenantId,
        code: "buyout-6000-22000",
        kind: RentalTariffGroupKind.BUYOUT,
        name: "Выкуп 6 000 / 22 000",
        description: "Вторая стартовая группа выкупа: неделя = 6000 руб., месяц = 22000 руб.",
        depositTargetKopecks: 0,
        autoPenaltyEnabled: false,
        autoPenaltyDailyKopecks: 0,
        graceDays: 0,
        rates: [
          { label: "Неделя", durationDays: 7, amountKopecks: 600_000 },
          { label: "Месяц", durationDays: 30, amountKopecks: 2_200_000 }
        ]
      });
    }
  });
}

async function syncActiveRentalRulesForGroup(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rentalTariffGroupId: string,
  rules: ReturnType<typeof normalizeRules>
) {
  await tx.rental.updateMany({
    where: {
      tenantId,
      status: {
        in: [...ACTIVE_RENTAL_STATUSES]
      },
      bikeUnit: {
        is: {
          rentalTariffGroupId
        }
      }
    },
    data: rules
  });
}

async function syncActiveBuyoutRulesForGroup(
  tx: Prisma.TransactionClient,
  tenantId: string,
  buyoutTariffGroupId: string,
  rules: ReturnType<typeof normalizeRules>
) {
  await tx.buyout.updateMany({
    where: {
      tenantId,
      status: {
        in: [...ACTIVE_BUYOUT_STATUSES]
      },
      bikeUnit: {
        is: {
          buyoutTariffGroupId
        }
      }
    },
    data: rules
  });
}

async function freezeActiveRentalRatesForGroup(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    groupId: string;
    groupCode: string;
    rates: Array<{
      label: string;
      durationDays: number;
      amountKopecks: number;
    }>;
  }
) {
  if (params.rates.length === 0) {
    return;
  }

  const rentals = await tx.rental.findMany({
    where: {
      tenantId: params.tenantId,
      status: {
        in: [...ACTIVE_RENTAL_STATUSES]
      },
      bikeUnit: {
        is: {
          rentalTariffGroupId: params.groupId
        }
      },
      tariffSnapshots: {
        none: {}
      }
    },
    select: {
      id: true
    }
  });

  for (const rental of rentals) {
    await replaceRentalTariffSnapshots(tx, {
      tenantId: params.tenantId,
      rentalId: rental.id,
      tariffGroupCode: params.groupCode,
      rates: params.rates
    });
  }
}

async function freezeActiveRentalRatesForBikeAssignments(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    bikeIds: string[];
  }
) {
  const uniqueBikeIds = Array.from(new Set(params.bikeIds.map((bikeId) => bikeId.trim()).filter(Boolean)));

  if (uniqueBikeIds.length === 0) {
    return;
  }

  const rentals = await tx.rental.findMany({
    where: {
      tenantId: params.tenantId,
      bikeUnitId: {
        in: uniqueBikeIds
      },
      status: {
        in: [...ACTIVE_RENTAL_STATUSES]
      },
      tariffSnapshots: {
        none: {}
      }
    },
    select: {
      id: true,
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
                  label: true,
                  durationDays: true,
                  amountKopecks: true
                }
              }
            }
          }
        }
      }
    }
  });

  for (const rental of rentals) {
    const group = rental.bikeUnit.rentalTariffGroup;
    if (!group?.rates?.length) {
      continue;
    }

    await replaceRentalTariffSnapshots(tx, {
      tenantId: params.tenantId,
      rentalId: rental.id,
      tariffGroupCode: group.code,
      rates: group.rates
    });
  }
}

function serializeGroup(group: {
  id: string;
  kind: RentalTariffGroupKind;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  depositTargetKopecks: number;
  autoPenaltyEnabled: boolean;
  autoPenaltyDailyKopecks: number;
  graceDays: number;
  _count: {
    rentalBikeUnits: number;
    buyoutBikeUnits: number;
  };
  rates: Array<{
    id: string;
    label: string;
    durationDays: number;
    amountKopecks: number;
    bonusDays: number;
    sortOrder: number;
  }>;
}, assignedBikesCountOverride?: number) {
  const assignedBikesCount = assignedBikesCountOverride ?? (group.kind === RentalTariffGroupKind.RENTAL
    ? group._count.rentalBikeUnits
    : group._count.buyoutBikeUnits);

  return {
    id: group.id,
    kind: group.kind,
    code: group.code,
    name: group.name,
    description: group.description,
    isActive: group.isActive,
    assignedBikesCount,
    rules: {
      depositTargetKopecks: group.depositTargetKopecks,
      autoPenaltyEnabled: group.autoPenaltyEnabled,
      autoPenaltyDailyKopecks: group.autoPenaltyDailyKopecks,
      graceDays: group.graceDays
    },
    rates: [...group.rates]
      .sort((left, right) => left.sortOrder - right.sortOrder || left.durationDays - right.durationDays)
      .map((rate) => ({
        id: rate.id,
        label: rate.label,
        durationDays: rate.durationDays,
        amountKopecks: rate.amountKopecks,
        bonusDays: rate.bonusDays
      }))
  };
}

function buildGroupSelect() {
  return {
    id: true,
    kind: true,
    code: true,
    name: true,
    description: true,
    isActive: true,
    depositTargetKopecks: true,
    autoPenaltyEnabled: true,
    autoPenaltyDailyKopecks: true,
    graceDays: true,
    _count: {
      select: {
        rentalBikeUnits: true,
        buyoutBikeUnits: true
      }
    },
    rates: {
      orderBy: [
        { sortOrder: "asc" as const },
        { durationDays: "asc" as const }
      ],
      select: {
        id: true,
        label: true,
        durationDays: true,
        amountKopecks: true,
        bonusDays: true,
        sortOrder: true
      }
    }
  };
}

export async function listTariffsWorkspace(params: { tenantSlug: string; branchId?: string | null }) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  await ensureStarterTariffGroups(tenant.id);

  const [groups, bikeRows] = await Promise.all([
    prisma.rentalTariffGroup.findMany({
      where: {
        tenantId: tenant.id
      },
      orderBy: [
        { kind: "asc" },
        { updatedAt: "desc" },
        { name: "asc" }
      ],
      select: buildGroupSelect()
    }),
    prisma.bikeUnit.findMany({
      where: {
        tenantId: tenant.id,
        ...(params.branchId ? { branchId: params.branchId } : {})
      },
      orderBy: [
        { title: "asc" }
      ],
      select: {
        id: true,
        title: true,
        internalCode: true,
        status: true,
        article: true,
        bikeModel: {
          select: {
            id: true,
            name: true
          }
        },
        rentalTariffGroupId: true,
        buyoutTariffGroupId: true,
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
        }
      }
    })
  ]);

  const bikes = bikeRows.filter((bike) => isAssignableBikeUnitName(bike.title, bike.bikeModel?.name));
  const assignedRentalBikesCount = bikes.filter((bike) => bike.rentalTariffGroupId !== null).length;
  const assignedBuyoutBikesCount = bikes.filter((bike) => bike.buyoutTariffGroupId !== null).length;
  const assignedCountsByGroupId = new Map<string, number>();

  for (const bike of bikes) {
    if (bike.rentalTariffGroupId) {
      assignedCountsByGroupId.set(bike.rentalTariffGroupId, (assignedCountsByGroupId.get(bike.rentalTariffGroupId) ?? 0) + 1);
    }

    if (bike.buyoutTariffGroupId) {
      assignedCountsByGroupId.set(bike.buyoutTariffGroupId, (assignedCountsByGroupId.get(bike.buyoutTariffGroupId) ?? 0) + 1);
    }
  }

  const rentalGroupsCount = groups.filter((group) => group.kind === RentalTariffGroupKind.RENTAL).length;
  const buyoutGroupsCount = groups.filter((group) => group.kind === RentalTariffGroupKind.BUYOUT).length;

  return {
    tenant,
    summary: {
      groupsCount: groups.length,
      rentalGroupsCount,
      buyoutGroupsCount,
      bikesCount: bikes.length,
      assignedRentalBikesCount,
      unassignedRentalBikesCount: Math.max(0, bikes.length - assignedRentalBikesCount),
      assignedBuyoutBikesCount,
      unassignedBuyoutBikesCount: Math.max(0, bikes.length - assignedBuyoutBikesCount)
    },
    rows: groups.map((group) => serializeGroup(group, assignedCountsByGroupId.get(group.id) ?? 0)),
    bikes
  };
}

export async function createTariffGroup(params: {
  tenantSlug: string;
  kind: RentalTariffGroupKind;
  name: string;
  description?: string | null;
  isActive?: boolean;
  rates: TariffRateInput[];
  depositTargetKopecks: number;
  autoPenaltyEnabled: boolean;
  autoPenaltyDailyKopecks: number;
  graceDays: number;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const rates = normalizeRates(params.rates, params.kind);
  const rules = normalizeRules(params);

  const created = await prisma.$transaction(async (tx) => {
    const code = await resolveUniqueCode(tx, tenant.id, params.name);
    return tx.rentalTariffGroup.create({
      data: {
        tenantId: tenant.id,
        kind: params.kind,
        code,
        name: sanitizeText(params.name, "Новая тарифная группа"),
        description: params.description?.trim() || null,
        isActive: params.isActive ?? true,
        ...rules,
        rates: {
          create: rates.map((rate, index) => ({
            tenantId: tenant.id,
            label: rate.label,
            durationDays: rate.durationDays,
            amountKopecks: rate.amountKopecks,
            bonusDays: rate.bonusDays,
            sortOrder: index
          }))
        }
      },
      select: buildGroupSelect()
    });
  });

  return {
    tenant,
    group: serializeGroup(created)
  };
}

export async function updateTariffGroup(params: {
  tenantSlug: string;
  groupId: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  rates: TariffRateInput[];
  depositTargetKopecks: number;
  autoPenaltyEnabled: boolean;
  autoPenaltyDailyKopecks: number;
  graceDays: number;
  syncActiveDeals: boolean;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.rentalTariffGroup.findFirst({
      where: {
        id: params.groupId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        kind: true,
        code: true,
        rates: {
          orderBy: {
            durationDays: "asc"
          },
          select: {
            label: true,
            durationDays: true,
            amountKopecks: true
          }
        }
      }
    });

    if (!existing) {
      throw new HttpError(404, `Tariff group '${params.groupId}' was not found`);
    }

    const rates = normalizeRates(params.rates, existing.kind);
    const rules = normalizeRules(params);

    if (existing.kind === RentalTariffGroupKind.RENTAL) {
      await freezeActiveRentalRatesForGroup(tx, {
        tenantId: tenant.id,
        groupId: existing.id,
        groupCode: existing.code,
        rates: existing.rates
      });
    }

    await tx.rentalTariffGroupRate.deleteMany({
      where: {
        rentalTariffGroupId: params.groupId
      }
    });

    const group = await tx.rentalTariffGroup.update({
      where: {
        id: params.groupId
      },
      data: {
        name: sanitizeText(params.name, "Тарифная группа"),
        description: params.description?.trim() || null,
        isActive: params.isActive ?? true,
        ...rules,
        rates: {
          create: rates.map((rate, index) => ({
            tenantId: tenant.id,
            label: rate.label,
            durationDays: rate.durationDays,
            amountKopecks: rate.amountKopecks,
            bonusDays: rate.bonusDays,
            sortOrder: index
          }))
        }
      },
      select: buildGroupSelect()
    });

    if (params.syncActiveDeals) {
      if (existing.kind === RentalTariffGroupKind.RENTAL) {
        await syncActiveRentalRulesForGroup(tx, tenant.id, params.groupId, rules);
      } else {
        await syncActiveBuyoutRulesForGroup(tx, tenant.id, params.groupId, rules);
      }
    }

    return group;
  });

  return {
    tenant,
    group: serializeGroup(updated)
  };
}

export async function replaceTariffGroupBikeAssignments(params: {
  tenantSlug: string;
  groupId: string;
  bikeIds: string[];
  syncActiveDeals: boolean;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const uniqueBikeIds = Array.from(new Set(params.bikeIds.map((item) => item.trim()).filter(Boolean)));

  const result = await prisma.$transaction(async (tx) => {
    const group = await tx.rentalTariffGroup.findFirst({
      where: {
        id: params.groupId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        kind: true,
        depositTargetKopecks: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        graceDays: true
      }
    });

    if (!group) {
      throw new HttpError(404, `Tariff group '${params.groupId}' was not found`);
    }

    if (uniqueBikeIds.length > 0) {
      const bikes = await tx.bikeUnit.findMany({
        where: {
          tenantId: tenant.id,
          id: {
            in: uniqueBikeIds
          }
        },
        select: {
          id: true,
          title: true,
          bikeModel: {
            select: {
              name: true
            }
          }
        }
      });

      if (bikes.length !== uniqueBikeIds.length) {
        throw new HttpError(422, "Один или несколько велосипедов не найдены в этом tenant.");
      }

      const invalidBike = bikes.find((bike) => !isAssignableBikeUnitName(bike.title, bike.bikeModel?.name));
      if (invalidBike) {
        throw new HttpError(422, `В тариф можно закреплять только реальные велосипеды. Проверь запись '${invalidBike.title}'.`);
      }
    }

    if (group.kind === RentalTariffGroupKind.RENTAL) {
      const currentlyAssignedBikeIds = await tx.bikeUnit.findMany({
        where: {
          tenantId: tenant.id,
          rentalTariffGroupId: params.groupId
        },
        select: {
          id: true
        }
      });

      await freezeActiveRentalRatesForBikeAssignments(tx, {
        tenantId: tenant.id,
        bikeIds: [
          ...uniqueBikeIds,
          ...currentlyAssignedBikeIds.map((bike) => bike.id)
        ]
      });

      await tx.bikeUnit.updateMany({
        where: {
          tenantId: tenant.id,
          rentalTariffGroupId: params.groupId,
          ...(uniqueBikeIds.length
            ? {
                id: {
                  notIn: uniqueBikeIds
                }
              }
            : {})
        },
        data: {
          rentalTariffGroupId: null
        }
      });

      if (uniqueBikeIds.length) {
        await tx.bikeUnit.updateMany({
          where: {
            tenantId: tenant.id,
            id: {
              in: uniqueBikeIds
            }
          },
          data: {
            rentalTariffGroupId: params.groupId
          }
        });
      }

      if (params.syncActiveDeals && uniqueBikeIds.length) {
        await tx.rental.updateMany({
          where: {
            tenantId: tenant.id,
            bikeUnitId: {
              in: uniqueBikeIds
            },
            status: {
              in: [...ACTIVE_RENTAL_STATUSES]
            }
          },
          data: {
            depositTargetKopecks: group.depositTargetKopecks,
            autoPenaltyEnabled: group.autoPenaltyEnabled,
            autoPenaltyDailyKopecks: group.autoPenaltyDailyKopecks,
            graceDays: group.graceDays
          }
        });
      }
    } else {
      await tx.bikeUnit.updateMany({
        where: {
          tenantId: tenant.id,
          buyoutTariffGroupId: params.groupId,
          ...(uniqueBikeIds.length
            ? {
                id: {
                  notIn: uniqueBikeIds
                }
              }
            : {})
        },
        data: {
          buyoutTariffGroupId: null
        }
      });

      if (uniqueBikeIds.length) {
        await tx.bikeUnit.updateMany({
          where: {
            tenantId: tenant.id,
            id: {
              in: uniqueBikeIds
            }
          },
          data: {
            buyoutTariffGroupId: params.groupId
          }
        });
      }

      if (params.syncActiveDeals && uniqueBikeIds.length) {
        await tx.buyout.updateMany({
          where: {
            tenantId: tenant.id,
            bikeUnitId: {
              in: uniqueBikeIds
            },
            status: {
              in: [...ACTIVE_BUYOUT_STATUSES]
            }
          },
          data: {
            depositTargetKopecks: group.depositTargetKopecks,
            autoPenaltyEnabled: group.autoPenaltyEnabled,
            autoPenaltyDailyKopecks: group.autoPenaltyDailyKopecks,
            graceDays: group.graceDays
          }
        });
      }
    }

    const assignedCount = await tx.bikeUnit.count({
      where: {
        tenantId: tenant.id,
        ...(group.kind === RentalTariffGroupKind.RENTAL
          ? { rentalTariffGroupId: params.groupId }
          : { buyoutTariffGroupId: params.groupId })
      }
    });

    return {
      assignedCount
    };
  });

  return {
    tenant,
    assignedCount: result.assignedCount
  };
}
