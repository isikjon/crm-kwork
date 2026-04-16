import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { hydrateClientFromLegacyCounterparty } from "./legacy-counterparty-sync.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { actorHasPermission } from "../../core/auth/current-actor.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";
import {
  applyClientAccessWhere,
  branchLinkedBuyoutStatuses,
  branchLinkedRentalStatuses,
  buildBranchLinkedClientAccessWhere
} from "./branch-access.js";

const revenueTransactionTypes = [
  "RENTAL_PAYMENT_IN",
  "BUYOUT_PAYMENT_IN",
  "DOWN_PAYMENT_IN",
  "PARTIAL_PAYMENT_IN",
  "PENALTY_PAYMENT_IN"
] as const;

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(120)
});

const syncLegacySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  limit: z.coerce.number().int().min(1).max(500).default(120),
  force: z.coerce.boolean().default(false)
});

const clientParamsSchema = z.object({
  clientId: z.string().trim().min(2).max(128)
});

const clientRelativeParamsSchema = z.object({
  clientId: z.string().trim().min(2).max(128),
  relativeId: z.string().trim().min(2).max(128)
});

const workplaceParamsSchema = z.object({
  workplaceId: z.string().trim().min(2).max(128)
});

const workplaceQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const createWorkplaceSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  label: z.string().trim().min(2).max(120)
});

const clientTypeSchema = z.enum(["INDIVIDUAL", "LEGAL_ENTITY"]);

const createClientSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  fullName: z.string().trim().max(240).optional(),
  clientType: clientTypeSchema.default("INDIVIDUAL"),
  primaryPhone: z.string().trim().max(64).nullable().optional(),
  telegramHandle: z.string().trim().max(120).nullable().optional(),
  lastName: z.string().trim().max(120).nullable().optional(),
  firstName: z.string().trim().max(120).nullable().optional(),
  middleName: z.string().trim().max(120).nullable().optional(),
  comment: z.string().trim().max(4000).nullable().optional(),
  isProblemClient: z.coerce.boolean().default(false),
  isThief: z.coerce.boolean().default(false),
  flagComment: z.string().trim().max(1000).nullable().optional()
});

const updateClientProfileSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  fullName: z.string().trim().max(240).nullable().optional(),
  workplaceOptionId: z.string().trim().min(2).max(128).nullable().optional(),
  clearWorkplace: z.coerce.boolean().default(false),
  courierId: z.string().trim().max(120).nullable().optional(),
  clientType: clientTypeSchema.optional(),
  taxId: z.string().trim().max(32).nullable().optional(),
  kpp: z.string().trim().max(32).nullable().optional(),
  ogrn: z.string().trim().max(32).nullable().optional(),
  primaryPhone: z.string().trim().max(64).nullable().optional(),
  contactPersonName: z.string().trim().max(160).nullable().optional(),
  telegramHandle: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().max(160).nullable().optional(),
  fax: z.string().trim().max(64).nullable().optional(),
  maxHandle: z.string().trim().max(120).nullable().optional(),
  lastName: z.string().trim().max(120).nullable().optional(),
  firstName: z.string().trim().max(120).nullable().optional(),
  middleName: z.string().trim().max(120).nullable().optional(),
  gender: z.string().trim().max(32).nullable().optional(),
  comment: z.string().trim().max(4000).nullable().optional(),
  isProblemClient: z.coerce.boolean().optional(),
  isThief: z.coerce.boolean().optional(),
  flagComment: z.string().trim().max(1000).nullable().optional(),
  passportSeries: z.string().trim().max(32).nullable().optional(),
  passportNumber: z.string().trim().max(64).nullable().optional(),
  issuedBy: z.string().trim().max(400).nullable().optional(),
  issuedAt: z.string().trim().max(32).nullable().optional(),
  departmentCode: z.string().trim().max(32).nullable().optional(),
  birthDate: z.string().trim().max(32).nullable().optional(),
  registeredAddressFull: z.string().trim().max(1000).nullable().optional(),
  registeredAddressComment: z.string().trim().max(1000).nullable().optional(),
  registeredFiasCode: z.string().trim().max(120).nullable().optional(),
  actualAddressFull: z.string().trim().max(1000).nullable().optional(),
  actualAddressComment: z.string().trim().max(1000).nullable().optional(),
  actualFiasCode: z.string().trim().max(120).nullable().optional(),
  phoneContacts: z.array(
    z.object({
      value: z.string().trim().min(2).max(64),
      isPrimary: z.coerce.boolean().default(false)
    })
  ).max(4).optional()
});

const createRelativeSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  fullName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(2).max(64),
  comment: z.string().trim().max(1000).nullable().optional()
});

function normalizeOptionalText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function normalizeOptionalDate(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, "Некорректная дата.");
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

function composeFullName(params: {
  fullName?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
}) {
  const parts = [
    params.lastName?.trim(),
    params.firstName?.trim(),
    params.middleName?.trim()
  ].filter((value): value is string => Boolean(value));

  if (parts.length > 0) {
    return parts.join(" ");
  }

  return params.fullName?.trim() ?? "";
}

function resolveClientDisplayName(params: {
  clientType: "INDIVIDUAL" | "LEGAL_ENTITY";
  fullName?: string | null;
  fallbackFullName?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
}) {
  if (params.clientType === "LEGAL_ENTITY") {
    const direct = params.fullName?.trim();
    if (direct) {
      return direct;
    }

    return params.fallbackFullName?.trim() ?? "";
  }

  return composeFullName({
    fullName: params.fallbackFullName ?? params.fullName,
    lastName: params.lastName,
    firstName: params.firstName,
    middleName: params.middleName
  });
}

function buildClientsWhere(input: {
  tenantId: string;
  search?: string;
  accessWhere?: Prisma.ClientWhereInput | null;
}): Prisma.ClientWhereInput {
  const { tenantId, accessWhere, search } = input;
  const tokens = tokenizeSearch(search);
  const clauses: Prisma.ClientWhereInput[] = [
    {
      tenantId
    }
  ];

  if (accessWhere) {
    clauses.push(accessWhere);
  }

  if (tokens.length === 0) {
    return clauses.length === 1 ? clauses[0]! : { AND: clauses };
  }

  clauses.push(
    ...tokens.map((token): Prisma.ClientWhereInput => ({
      OR: [
        { fullName: { contains: token, mode: "insensitive" } },
        { lastName: { contains: token, mode: "insensitive" } },
        { firstName: { contains: token, mode: "insensitive" } },
        { middleName: { contains: token, mode: "insensitive" } },
        { primaryPhone: { contains: token, mode: "insensitive" } },
        { telegramHandle: { contains: token, mode: "insensitive" } },
        { legacyExternalId: { contains: token, mode: "insensitive" } },
        { courierId: { contains: token, mode: "insensitive" } },
        { taxId: { contains: token, mode: "insensitive" } },
        { kpp: { contains: token, mode: "insensitive" } },
        { ogrn: { contains: token, mode: "insensitive" } },
        { email: { contains: token, mode: "insensitive" } },
        { fax: { contains: token, mode: "insensitive" } },
        { contactPersonName: { contains: token, mode: "insensitive" } },
        { workplace: { contains: token, mode: "insensitive" } },
        { comment: { contains: token, mode: "insensitive" } },
        { flagComment: { contains: token, mode: "insensitive" } },
        {
          contacts: {
            some: {
              type: "PHONE",
              value: { contains: token, mode: "insensitive" }
            }
          }
        },
        {
          relatives: {
            some: {
              OR: [
                { fullName: { contains: token, mode: "insensitive" } },
                { phone: { contains: token, mode: "insensitive" } },
                { comment: { contains: token, mode: "insensitive" } }
              ]
            }
          }
        }
      ]
    }))
  );

  return clauses.length === 1 ? clauses[0]! : { AND: clauses };
}

function buildClientListSelect() {
  return {
    id: true,
    fullName: true,
    clientType: true,
    workplace: true,
    courierId: true,
    primaryPhone: true,
    telegramHandle: true,
    currentDebtKopecks: true,
    overdueDebtKopecks: true,
    activeDealsCount: true,
    updatedAt: true,
    isProblemClient: true,
    isThief: true,
    flagComment: true,
    _count: {
      select: {
        rentals: true,
        buyouts: true
      }
    }
  };
}

function buildClientDetailSelect(options?: {
  includeIdentity?: boolean;
}) {
  const includeIdentity = options?.includeIdentity ?? true;

  return {
    id: true,
    fullName: true,
    clientType: true,
    taxId: true,
    kpp: true,
    ogrn: true,
    workplace: true,
    email: true,
    fax: true,
    maxHandle: true,
    courierId: true,
    primaryPhone: true,
    contactPersonName: true,
    telegramHandle: true,
    lastName: true,
    firstName: true,
    middleName: true,
    gender: true,
    comment: true,
    isProblemClient: true,
    isThief: true,
    flagComment: true,
    currentDebtKopecks: true,
    overdueDebtKopecks: true,
    activeDealsCount: true,
    paymentCount: true,
    overdueCount: true,
    legacyExternalId: true,
    updatedAt: true,
    ...(includeIdentity
      ? {
          identityData: {
            select: {
              passportSeries: true,
              passportNumber: true,
              issuedBy: true,
              issuedAt: true,
              departmentCode: true,
              birthDate: true,
              registeredAddressFull: true,
              registeredAddressComment: true,
              registeredFiasCode: true,
              actualAddressFull: true,
              actualAddressComment: true,
              actualFiasCode: true
            }
          }
        }
      : {}),
    relatives: {
      orderBy: [
        { createdAt: "asc" as const }
      ],
      select: {
        id: true,
        fullName: true,
        phone: true,
        comment: true
      }
    },
    contacts: {
      where: {
        type: "PHONE" as const
      },
      orderBy: [
        { createdAt: "asc" as const }
      ],
      select: {
        id: true,
        value: true,
        isPrimary: true
      }
    },
    _count: {
      select: {
        rentals: true,
        buyouts: true,
        notes: true,
        documents: true
      }
    }
  };
}

async function loadRevenueMap(tenantId: string, clientIds: string[], branchId?: string | null) {
  if (clientIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await prisma.financialTransaction.groupBy({
    by: ["clientId"],
    where: {
      tenantId,
      ...(branchId ? { branchId } : {}),
      clientId: {
        in: clientIds
      },
      status: "POSTED",
      type: {
        in: [...revenueTransactionTypes]
      }
    },
    _sum: {
      amountKopecks: true
    }
  });

  return new Map(
    rows
      .filter((row) => typeof row.clientId === "string")
      .map((row) => [row.clientId as string, row._sum.amountKopecks ?? 0])
  );
}

async function loadBranchScopedClientStats(tenantId: string, branchId: string, clientIds: string[]) {
  if (clientIds.length === 0) {
    return new Map<string, {
      rentalsCount: number;
      buyoutsCount: number;
      activeDealsCount: number;
      currentDebtKopecks: number;
      overdueDebtKopecks: number;
    }>();
  }

  const [rentalActiveRows, rentalOverdueRows, buyoutActiveRows, buyoutOverdueRows] = await Promise.all([
    prisma.rental.groupBy({
      by: ["clientId"],
      where: {
        tenantId,
        branchId,
        clientId: {
          in: clientIds
        },
        status: {
          in: [...branchLinkedRentalStatuses]
        }
      },
      _count: {
        _all: true
      },
      _sum: {
        debtKopecks: true
      }
    }),
    prisma.rental.groupBy({
      by: ["clientId"],
      where: {
        tenantId,
        branchId,
        clientId: {
          in: clientIds
        },
        status: "OVERDUE"
      },
      _sum: {
        debtKopecks: true
      }
    }),
    prisma.buyout.groupBy({
      by: ["clientId"],
      where: {
        tenantId,
        branchId,
        clientId: {
          in: clientIds
        },
        status: {
          in: [...branchLinkedBuyoutStatuses]
        }
      },
      _count: {
        _all: true
      },
      _sum: {
        residualDebtKopecks: true
      }
    }),
    prisma.buyout.groupBy({
      by: ["clientId"],
      where: {
        tenantId,
        branchId,
        clientId: {
          in: clientIds
        },
        status: "OVERDUE"
      },
      _sum: {
        residualDebtKopecks: true
      }
    })
  ]);

  const stats = new Map<string, {
    rentalsCount: number;
    buyoutsCount: number;
    activeDealsCount: number;
    currentDebtKopecks: number;
    overdueDebtKopecks: number;
  }>();

  function ensure(clientId: string) {
    const existing = stats.get(clientId);
    if (existing) {
      return existing;
    }

    const created = {
      rentalsCount: 0,
      buyoutsCount: 0,
      activeDealsCount: 0,
      currentDebtKopecks: 0,
      overdueDebtKopecks: 0
    };
    stats.set(clientId, created);
    return created;
  }

  for (const row of rentalActiveRows) {
    const entry = ensure(row.clientId);
    entry.rentalsCount = row._count._all;
    entry.activeDealsCount += row._count._all;
    entry.currentDebtKopecks += row._sum.debtKopecks ?? 0;
  }

  for (const row of rentalOverdueRows) {
    const entry = ensure(row.clientId);
    entry.overdueDebtKopecks += row._sum.debtKopecks ?? 0;
  }

  for (const row of buyoutActiveRows) {
    const entry = ensure(row.clientId);
    entry.buyoutsCount = row._count._all;
    entry.activeDealsCount += row._count._all;
    entry.currentDebtKopecks += row._sum.residualDebtKopecks ?? 0;
  }

  for (const row of buyoutOverdueRows) {
    const entry = ensure(row.clientId);
    entry.overdueDebtKopecks += row._sum.residualDebtKopecks ?? 0;
  }

  return stats;
}

function diffDays(startAt: Date, endAt: Date) {
  const value = Math.ceil((endAt.getTime() - startAt.getTime()) / 86_400_000);
  return Math.max(0, value);
}

function deriveRentalDaysTotal(rentals: Array<{
  startsAt: Date;
  updatedAt: Date;
  status: string;
}>) {
  const now = new Date();

  return rentals.reduce((sum, rental) => {
    const endAt = branchLinkedRentalStatuses.includes(rental.status as (typeof branchLinkedRentalStatuses)[number])
      ? now
      : rental.updatedAt;

    return sum + diffDays(rental.startsAt, endAt);
  }, 0);
}

function formatClientFlagState(client: {
  isProblemClient: boolean;
  isThief: boolean;
}) {
  if (client.isThief) {
    return "Вор";
  }

  if (client.isProblemClient) {
    return "Проблемный";
  }

  return "Обычный";
}

function hasIdentityProfileChanges(payload: z.infer<typeof updateClientProfileSchema>) {
  return [
    payload.passportSeries,
    payload.passportNumber,
    payload.issuedBy,
    payload.issuedAt,
    payload.departmentCode,
    payload.birthDate,
    payload.registeredAddressFull,
    payload.registeredAddressComment,
    payload.registeredFiasCode,
    payload.actualAddressFull,
    payload.actualAddressComment,
    payload.actualFiasCode
  ].some((value) => value !== undefined);
}

export function createClientsRouter() {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "clients.view");
    const readBranchId = resolveActorBranchReadScope(actor, "clients.view");
    const accessWhere = buildBranchLinkedClientAccessWhere(tenant.id, readBranchId);
    const search = query.q?.trim();
    const where = buildClientsWhere({
      tenantId: tenant.id,
      search,
      accessWhere
    });

    const [rows, total] = await Promise.all([
      prisma.client.findMany({
        where,
        orderBy: [
          { fullName: "asc" },
          { updatedAt: "desc" }
        ],
        take: query.limit,
        select: buildClientListSelect()
      }),
      prisma.client.count({ where })
    ]);

    const [revenueMap, branchScopedStats] = await Promise.all([
      loadRevenueMap(tenant.id, rows.map((row) => row.id), readBranchId),
      readBranchId ? loadBranchScopedClientStats(tenant.id, readBranchId, rows.map((row) => row.id)) : null
    ]);

    res.status(200).json({
      tenant,
      total,
      query: search ?? null,
      rows: rows.map((row) => {
        const scopedStats = branchScopedStats?.get(row.id);

        return {
          ...row,
          currentDebtKopecks: scopedStats?.currentDebtKopecks ?? row.currentDebtKopecks,
          overdueDebtKopecks: scopedStats?.overdueDebtKopecks ?? row.overdueDebtKopecks,
          activeDealsCount: scopedStats?.activeDealsCount ?? row.activeDealsCount,
          moneyBroughtKopecks: revenueMap.get(row.id) ?? 0,
          clientState: formatClientFlagState(row),
          _count: scopedStats
            ? {
                rentals: scopedStats.rentalsCount,
                buyouts: scopedStats.buyoutsCount
              }
            : row._count
        };
      })
    });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const payload = createClientSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "clients.edit");

    const fullName = composeFullName({
      fullName: payload.fullName,
      lastName: payload.lastName,
      firstName: payload.firstName,
      middleName: payload.middleName
    });

    if (!fullName) {
      throw new HttpError(422, "Укажите ФИО клиента.");
    }

    const client = await prisma.client.create({
      data: {
        tenantId: tenant.id,
        fullName,
        clientType: payload.clientType,
        primaryPhone: normalizeOptionalText(payload.primaryPhone) ?? null,
        telegramHandle: normalizeOptionalText(payload.telegramHandle) ?? null,
        lastName: normalizeOptionalText(payload.lastName) ?? null,
        firstName: normalizeOptionalText(payload.firstName) ?? null,
        middleName: normalizeOptionalText(payload.middleName) ?? null,
        comment: normalizeOptionalText(payload.comment) ?? null,
        isProblemClient: payload.isProblemClient,
        isThief: payload.isThief,
        flagComment: normalizeOptionalText(payload.flagComment) ?? null
      },
      select: buildClientDetailSelect()
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client",
        entityId: client.id,
        action: "created",
        newValueText: JSON.stringify({
          fullName: client.fullName,
          clientType: client.clientType
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(201).json({
      tenant,
      client,
      detailHref: `/clients/${client.id}`
    });
  }));

  router.get("/workplaces", asyncHandler(async (req, res) => {
    const query = workplaceQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "clients.view");

    const [options, usageRows] = await Promise.all([
      prisma.clientWorkplaceOption.findMany({
        where: {
          tenantId: tenant.id
        },
        orderBy: [
          { label: "asc" }
        ],
        select: {
          id: true,
          label: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      prisma.client.groupBy({
        by: ["workplace"],
        where: {
          tenantId: tenant.id,
          workplace: {
            not: null
          }
        },
        _count: {
          _all: true
        }
      })
    ]);

    const usageByLabel = new Map(
      usageRows
        .filter((row) => typeof row.workplace === "string" && row.workplace.trim().length > 0)
        .map((row) => [row.workplace ?? "", row._count._all])
    );

    res.status(200).json({
      tenant,
      total: options.length,
      rows: options.map((option) => ({
        ...option,
        usageCount: usageByLabel.get(option.label) ?? 0
      }))
    });
  }));

  router.post("/workplaces", asyncHandler(async (req, res) => {
    const payload = createWorkplaceSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "clients.edit");
    const label = payload.label.trim().replace(/\s+/g, " ");

    const existing = await prisma.clientWorkplaceOption.findFirst({
      where: {
        tenantId: tenant.id,
        label: {
          equals: label,
          mode: "insensitive"
        }
      },
      select: {
        id: true,
        label: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (existing) {
      res.status(200).json({
        tenant,
        created: false,
        workplace: {
          ...existing,
          usageCount: await prisma.client.count({
            where: {
              tenantId: tenant.id,
              workplace: existing.label
            }
          })
        }
      });
      return;
    }

    const workplace = await prisma.clientWorkplaceOption.create({
      data: {
        tenantId: tenant.id,
        label
      },
      select: {
        id: true,
        label: true,
        createdAt: true,
        updatedAt: true
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client_workplace",
        entityId: workplace.id,
        action: "created",
        newValueText: JSON.stringify({
          label: workplace.label
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(201).json({
      tenant,
      created: true,
      workplace: {
        ...workplace,
        usageCount: 0
      }
    });
  }));

  router.post("/sync-legacy-profiles", asyncHandler(async (req, res) => {
    const payload = syncLegacySchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "imports.run");

    const clients = await prisma.client.findMany({
      where: {
        tenantId: tenant.id,
        legacyReference: {
          not: null
        }
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: payload.limit,
      select: {
        id: true,
        fullName: true,
        legacyReference: true
      }
    });

    const rows = [];
    for (const client of clients) {
      const result = await hydrateClientFromLegacyCounterparty({
        tenantId: tenant.id,
        clientId: client.id,
        legacyReference: client.legacyReference,
        force: payload.force
      }).catch((error) => ({
        updated: false,
        reason: error instanceof Error ? error.message : "unknown_error"
      }));

      rows.push({
        clientId: client.id,
        fullName: client.fullName,
        ...result
      });
    }

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client_sync",
        entityId: tenant.id,
        action: "legacy_profiles_synced",
        newValueText: JSON.stringify({
          total: clients.length,
          updated: rows.filter((row) => row.updated).length,
          force: payload.force
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      total: clients.length,
      updated: rows.filter((row) => row.updated).length,
      rows
    });
  }));

  router.get("/:clientId", asyncHandler(async (req, res) => {
    const params = clientParamsSchema.parse(req.params);
    const query = workplaceQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "clients.view");
    const readBranchId = resolveActorBranchReadScope(actor, "clients.view");
    const canViewIdentity = actorHasPermission(actor, "clients.identity.view");
    const accessWhere = buildBranchLinkedClientAccessWhere(tenant.id, readBranchId);

    const client = await prisma.client.findFirst({
      where: applyClientAccessWhere({
        id: params.clientId,
        tenantId: tenant.id
      }, accessWhere),
      select: buildClientDetailSelect({
        includeIdentity: canViewIdentity
      })
    });

    if (!client) {
      throw new HttpError(404, "Клиент не найден.");
    }

    const [revenue, rentalRows, activeRentals, activeBuyouts, recentPayments, branchScopedStats] = await Promise.all([
      prisma.financialTransaction.aggregate({
        where: {
          tenantId: tenant.id,
          clientId: client.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: "POSTED",
          type: {
            in: [...revenueTransactionTypes]
          }
        },
        _sum: {
          amountKopecks: true
        }
      }),
      prisma.rental.findMany({
        where: {
          tenantId: tenant.id,
          clientId: client.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        select: {
          status: true,
          startsAt: true,
          updatedAt: true
        }
      }),
      prisma.rental.findMany({
        where: {
          tenantId: tenant.id,
          clientId: client.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: [...branchLinkedRentalStatuses]
          }
        },
        orderBy: [
          { nextPaymentAt: "asc" },
          { updatedAt: "desc" }
        ],
        take: 3,
        select: {
          id: true,
          dealNumber: true,
          status: true,
          nextPaymentAt: true,
          debtKopecks: true,
          bikeUnit: {
            select: {
              title: true,
              internalCode: true,
              article: true
            }
          }
        }
      }),
      prisma.buyout.findMany({
        where: {
          tenantId: tenant.id,
          clientId: client.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: [...branchLinkedBuyoutStatuses]
          }
        },
        orderBy: [
          { nextPaymentAt: "asc" },
          { updatedAt: "desc" }
        ],
        take: 3,
        select: {
          id: true,
          dealNumber: true,
          status: true,
          nextPaymentAt: true,
          residualDebtKopecks: true,
          bikeUnit: {
            select: {
              title: true,
              internalCode: true,
              article: true
            }
          }
        }
      }),
      prisma.financialTransaction.findMany({
        where: {
          tenantId: tenant.id,
          clientId: client.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: "POSTED",
          type: {
            in: [...revenueTransactionTypes]
          }
        },
        orderBy: [
          { postedAt: "desc" },
          { happenedAt: "desc" }
        ],
        take: 5,
        select: {
          id: true,
          type: true,
          paymentMethod: true,
          amountKopecks: true,
          postedAt: true,
          happenedAt: true,
          comment: true
        }
      }),
      readBranchId ? loadBranchScopedClientStats(tenant.id, readBranchId, [client.id]) : null
    ]);

    const scopedStats = branchScopedStats?.get(client.id);

    res.status(200).json({
      tenant,
      client: {
        ...client,
        identityData: canViewIdentity ? client.identityData ?? null : null,
        moneyBroughtKopecks: revenue._sum.amountKopecks ?? 0,
        rentalDaysTotal: deriveRentalDaysTotal(rentalRows),
        currentDebtKopecks: scopedStats?.currentDebtKopecks ?? client.currentDebtKopecks,
        overdueDebtKopecks: scopedStats?.overdueDebtKopecks ?? client.overdueDebtKopecks,
        activeDealsCount: scopedStats?.activeDealsCount ?? client.activeDealsCount,
        clientState: formatClientFlagState(client)
      },
      identityAccess: {
        canView: canViewIdentity,
        redacted: !canViewIdentity
      },
      activeDeals: [
        ...activeRentals.map((row) => ({
          id: row.id,
          kind: "RENTAL" as const,
          dealNumber: row.dealNumber,
          status: row.status,
          nextPaymentAt: row.nextPaymentAt,
          debtKopecks: row.debtKopecks,
          bikeLabel: row.bikeUnit.title,
          bikeArticle: row.bikeUnit.article ?? row.bikeUnit.internalCode
        })),
        ...activeBuyouts.map((row) => ({
          id: row.id,
          kind: "BUYOUT" as const,
          dealNumber: row.dealNumber,
          status: row.status,
          nextPaymentAt: row.nextPaymentAt,
          debtKopecks: row.residualDebtKopecks,
          bikeLabel: row.bikeUnit.title,
          bikeArticle: row.bikeUnit.article ?? row.bikeUnit.internalCode
        }))
      ].sort((left, right) => {
        const leftTime = left.nextPaymentAt ? new Date(left.nextPaymentAt).getTime() : Number.MAX_SAFE_INTEGER;
        const rightTime = right.nextPaymentAt ? new Date(right.nextPaymentAt).getTime() : Number.MAX_SAFE_INTEGER;
        return leftTime - rightTime;
      }),
      recentPayments
    });
  }));

  router.patch("/:clientId/profile", asyncHandler(async (req, res) => {
    const params = clientParamsSchema.parse(req.params);
    const payload = updateClientProfileSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "clients.edit");

    if (hasIdentityProfileChanges(payload) && !actorHasPermission(actor, "clients.identity.edit")) {
      throw new HttpError(403, "Недостаточно прав для изменения паспортных и адресных данных клиента.");
    }

    const client = await prisma.client.findFirst({
      where: {
        id: params.clientId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        fullName: true,
        lastName: true,
        firstName: true,
        middleName: true,
        clientType: true,
        workplace: true,
        courierId: true,
        isProblemClient: true,
        isThief: true,
        flagComment: true
      }
    });

    if (!client) {
      throw new HttpError(404, "Клиент не найден.");
    }

    let nextWorkplace: string | null = client.workplace ?? null;
    if (payload.clearWorkplace) {
      nextWorkplace = null;
    } else if (payload.workplaceOptionId) {
      const workplace = await prisma.clientWorkplaceOption.findFirst({
        where: {
          id: payload.workplaceOptionId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          label: true
        }
      });

      if (!workplace) {
        throw new HttpError(404, "Значение места работы не найдено.");
      }

      nextWorkplace = workplace.label;
    }

    const nextClientType = payload.clientType ?? client.clientType;
    const nextLastName = normalizeOptionalText(payload.lastName);
    const nextFirstName = normalizeOptionalText(payload.firstName);
    const nextMiddleName = normalizeOptionalText(payload.middleName);
    const nextIssuedAt = normalizeOptionalDate(payload.issuedAt);
    const nextBirthDate = normalizeOptionalDate(payload.birthDate);
    const nextFullName = resolveClientDisplayName({
      clientType: nextClientType,
      fullName: normalizeOptionalText(payload.fullName),
      fallbackFullName: client.fullName,
      lastName: nextLastName === undefined ? client.lastName : nextLastName,
      firstName: nextFirstName === undefined ? client.firstName : nextFirstName,
      middleName: nextMiddleName === undefined ? client.middleName : nextMiddleName
    }) || client.fullName;

    const normalizedPhoneContacts = (payload.phoneContacts ?? [])
      .map((row) => ({
        value: row.value.trim(),
        isPrimary: Boolean(row.isPrimary)
      }))
      .filter((row) => row.value.length > 0)
      .filter((row, index, rows) => rows.findIndex((candidate) => candidate.value === row.value) === index)
      .slice(0, 4);
    const resolvedPrimaryPhone = normalizedPhoneContacts.length > 0
      ? (normalizedPhoneContacts.find((row) => row.isPrimary)?.value ?? normalizedPhoneContacts[0]?.value ?? null)
      : normalizeOptionalText(payload.primaryPhone);
    const secondaryPhoneContacts = normalizedPhoneContacts.filter((row) => row.value !== resolvedPrimaryPhone);

    const nextFlagComment = payload.flagComment === undefined
      ? client.flagComment
      : normalizeOptionalText(payload.flagComment);

    const updatedClient = await prisma.client.update({
      where: {
        id: client.id
      },
      data: {
        fullName: nextFullName,
        workplace: nextWorkplace,
        courierId: payload.courierId === undefined ? client.courierId ?? null : normalizeOptionalText(payload.courierId) ?? null,
        clientType: nextClientType,
        taxId: normalizeOptionalText(payload.taxId),
        kpp: normalizeOptionalText(payload.kpp),
        ogrn: normalizeOptionalText(payload.ogrn),
        primaryPhone: resolvedPrimaryPhone,
        contactPersonName: normalizeOptionalText(payload.contactPersonName),
        telegramHandle: normalizeOptionalText(payload.telegramHandle),
        email: normalizeOptionalText(payload.email),
        fax: normalizeOptionalText(payload.fax),
        maxHandle: normalizeOptionalText(payload.maxHandle),
        lastName: nextLastName,
        firstName: nextFirstName,
        middleName: nextMiddleName,
        gender: normalizeOptionalText(payload.gender),
        comment: normalizeOptionalText(payload.comment),
        isProblemClient: payload.isProblemClient ?? client.isProblemClient,
        isThief: payload.isThief ?? client.isThief,
        flagComment: nextFlagComment,
        contacts: payload.phoneContacts
          ? {
              deleteMany: {
                type: "PHONE"
              },
              create: secondaryPhoneContacts.map((row) => ({
                tenantId: tenant.id,
                type: "PHONE" as const,
                value: row.value,
                isPrimary: false
              }))
            }
          : undefined,
        identityData: {
          upsert: {
            create: {
              tenantId: tenant.id,
              passportSeries: normalizeOptionalText(payload.passportSeries) ?? null,
              passportNumber: normalizeOptionalText(payload.passportNumber) ?? null,
              issuedBy: normalizeOptionalText(payload.issuedBy) ?? null,
              issuedAt: nextIssuedAt ?? null,
              departmentCode: normalizeOptionalText(payload.departmentCode) ?? null,
              birthDate: nextBirthDate ?? null,
              registeredAddressFull: normalizeOptionalText(payload.registeredAddressFull) ?? null,
              registeredAddressComment: normalizeOptionalText(payload.registeredAddressComment) ?? null,
              registeredFiasCode: normalizeOptionalText(payload.registeredFiasCode) ?? null,
              actualAddressFull: normalizeOptionalText(payload.actualAddressFull) ?? null,
              actualAddressComment: normalizeOptionalText(payload.actualAddressComment) ?? null,
              actualFiasCode: normalizeOptionalText(payload.actualFiasCode) ?? null
            },
            update: {
              passportSeries: normalizeOptionalText(payload.passportSeries),
              passportNumber: normalizeOptionalText(payload.passportNumber),
              issuedBy: normalizeOptionalText(payload.issuedBy),
              issuedAt: nextIssuedAt,
              departmentCode: normalizeOptionalText(payload.departmentCode),
              birthDate: nextBirthDate,
              registeredAddressFull: normalizeOptionalText(payload.registeredAddressFull),
              registeredAddressComment: normalizeOptionalText(payload.registeredAddressComment),
              registeredFiasCode: normalizeOptionalText(payload.registeredFiasCode),
              actualAddressFull: normalizeOptionalText(payload.actualAddressFull),
              actualAddressComment: normalizeOptionalText(payload.actualAddressComment),
              actualFiasCode: normalizeOptionalText(payload.actualFiasCode)
            }
          }
        }
      },
      select: buildClientDetailSelect()
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client",
        entityId: updatedClient.id,
        action: "profile_updated",
        newValueText: JSON.stringify({
          fullName: updatedClient.fullName,
          clientType: updatedClient.clientType,
          isProblemClient: updatedClient.isProblemClient,
          isThief: updatedClient.isThief
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      client: updatedClient
    });
  }));

  router.delete("/workplaces/:workplaceId", asyncHandler(async (req, res) => {
    const params = workplaceParamsSchema.parse(req.params);
    const query = workplaceQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "clients.edit");

    const workplace = await prisma.clientWorkplaceOption.findFirst({
      where: {
        id: params.workplaceId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        label: true
      }
    });

    if (!workplace) {
      throw new HttpError(404, "Значение места работы не найдено.");
    }

    const usageCount = await prisma.client.count({
      where: {
        tenantId: tenant.id,
        workplace: workplace.label
      }
    });

    await prisma.clientWorkplaceOption.delete({
      where: {
        id: workplace.id
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client_workplace",
        entityId: workplace.id,
        action: "deleted",
        newValueText: JSON.stringify({
          label: workplace.label,
          usageCount
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      deleted: true,
      workplace: {
        ...workplace,
        usageCount
      }
    });
  }));

  router.post("/:clientId/relatives", asyncHandler(async (req, res) => {
    const params = clientParamsSchema.parse(req.params);
    const payload = createRelativeSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "clients.edit");

    const client = await prisma.client.findFirst({
      where: {
        id: params.clientId,
        tenantId: tenant.id
      },
      select: {
        id: true
      }
    });

    if (!client) {
      throw new HttpError(404, "Клиент не найден.");
    }

    const relative = await prisma.clientRelative.create({
      data: {
        tenantId: tenant.id,
        clientId: client.id,
        fullName: payload.fullName.trim(),
        phone: payload.phone.trim(),
        comment: normalizeOptionalText(payload.comment) ?? null
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        comment: true,
        createdAt: true
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client_relative",
        entityId: relative.id,
        action: "created",
        newValueText: JSON.stringify({
          clientId: client.id,
          fullName: relative.fullName
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(201).json({
      tenant,
      relative
    });
  }));

  router.delete("/:clientId/relatives/:relativeId", asyncHandler(async (req, res) => {
    const params = clientRelativeParamsSchema.parse(req.params);
    const query = workplaceQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "clients.edit");

    const relative = await prisma.clientRelative.findFirst({
      where: {
        id: params.relativeId,
        clientId: params.clientId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        fullName: true
      }
    });

    if (!relative) {
      throw new HttpError(404, "Родственник не найден.");
    }

    await prisma.clientRelative.delete({
      where: {
        id: relative.id
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "client_relative",
        entityId: relative.id,
        action: "deleted",
        newValueText: JSON.stringify({
          clientId: params.clientId,
          fullName: relative.fullName
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      deleted: true,
      relative
    });
  }));

  return router;
}
