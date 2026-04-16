import { Router } from "express";
import { z } from "zod";
import { actorHasPermission, assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../core/http/errors.js";
import { postUnifiedOrderPayment } from "../finance/service.js";
import { buildGpsSnapshot } from "../gps/service.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const ACTIVE_RENTAL_STATUSES = ["NEW", "ACTIVE", "OVERDUE", "HOLD", "RETURN_PREP"] as const;
const ACTIVE_BUYOUT_STATUSES = ["NEW", "ACTIVE", "OVERDUE", "HOLD"] as const;

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  kind: z.enum(["RENTAL", "BUYOUT"]).optional(),
  scope: z.enum(["ACTIVE", "ALL"]).default("ACTIVE"),
  attention: z.enum(["ALL", "DEBT", "OVERDUE", "TODAY"]).default("ALL"),
  statusGroup: z.enum(["ALL_ACTIVE", "RENTAL", "BUYOUT", "RENTAL_COMPLETED", "BUYOUT_COMPLETED", "PROBLEM", "REPAIR"]).default("ALL_ACTIVE"),
  focusKind: z.enum(["RENTAL", "BUYOUT"]).optional(),
  focusDealId: z.string().trim().min(2).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(36)
});

const expandParamsSchema = z.object({
  kind: z.enum(["RENTAL", "BUYOUT"]),
  dealId: z.string().trim().min(2).max(128)
});

const noteParamsSchema = expandParamsSchema.extend({
  noteId: z.string().trim().min(2).max(128)
});

const expandQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const notePayloadSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  text: z.string().trim().min(1).max(240),
  colorHex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional()
});

const unifiedPaymentSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  totalAmountKopecks: z.coerce.number().int().positive(),
  mainAmountKopecks: z.coerce.number().int().min(0),
  penaltyIds: z.array(z.string().trim().min(2).max(128)).max(20).default([]),
  paymentMethod: z.enum(["BANK", "CASH"]),
  bankId: z.string().trim().min(2).max(128).optional(),
  happenedAt: z.string().trim().optional(),
  comment: z.string().trim().max(2000).optional()
});

function mapNoteRecord(note: {
  id: string;
  text: string;
  colorHex: string | null;
  createdAt: Date;
}) {
  return {
    id: note.id,
    text: note.text,
    colorHex: note.colorHex,
    createdAt: note.createdAt
  };
}

const LEGACY_OPERATOR_NOISE_PATTERNS = [
  /^\[legacy\]\s*battery count:/i,
  /^battery count:/i,
  /^imported from legacy\b/i,
  /^legacy order id:/i,
  /^legacy total sum:/i,
  /^legacy dashboard date used as\b/i,
  /^legacy buyout cadence assumed\b/i,
  /^schedule rebuilt from legacy\b/i
];

function isLegacyOperatorNoise(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return LEGACY_OPERATOR_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sanitizeOperatorComment(comment: string | null | undefined) {
  if (!comment) {
    return null;
  }

  const lines = comment
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isLegacyOperatorNoise(line));

  if (lines.length === 0) {
    return null;
  }

  return lines.join("\n");
}

function sanitizeOperatorNoteRecord(note: ReturnType<typeof mapNoteRecord>) {
  const text = note.text.replace(/^\[legacy\]\s*/i, "").trim();
  if (!text || isLegacyOperatorNoise(text)) {
    return null;
  }

  return {
    ...note,
    text
  };
}

async function listTargetNotes(params: {
  tenantId: string;
  targetEntityType: "rental" | "buyout";
  targetEntityId: string;
  take?: number;
}) {
  const notes = await prisma.note.findMany({
    where: {
      tenantId: params.tenantId,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId
    },
    orderBy: {
      createdAt: "desc"
    },
    take: params.take ?? 12,
    select: {
      id: true,
      text: true,
      colorHex: true,
      createdAt: true
    }
  });

  return notes
    .map(mapNoteRecord)
    .map(sanitizeOperatorNoteRecord)
    .filter((note): note is NonNullable<typeof note> => Boolean(note));
}

function buildDayBounds(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { start, end };
}

function buildRentalBaseWhere(tenantId: string, query: z.infer<typeof querySchema>, branchId?: string | null) {
  const search = query.q?.trim();
  const andConditions: Array<Record<string, unknown>> = [{ tenantId }];
  if (branchId) {
    andConditions.push({ branchId });
  }
  const effectiveScope = query.statusGroup === "RENTAL_COMPLETED" || query.statusGroup === "REPAIR" || query.statusGroup === "PROBLEM"
    ? "ALL"
    : query.scope;

  if (query.statusGroup === "RENTAL_COMPLETED") {
    andConditions.push({
      status: {
        in: ["COMPLETED", "CANCELED"]
      }
    });
  } else if (effectiveScope === "ACTIVE") {
    andConditions.push({
      status: {
        in: ACTIVE_RENTAL_STATUSES
      }
    });
  }

  if (query.statusGroup === "REPAIR") {
    andConditions.push({
      bikeUnit: {
        is: {
          status: "REPAIR"
        }
      }
    });
  }

  if (search) {
    andConditions.push({
      OR: [
        { dealNumber: { contains: search, mode: "insensitive" as const } },
        { tariffLabel: { contains: search, mode: "insensitive" as const } },
        { client: { is: { fullName: { contains: search, mode: "insensitive" as const } } } },
        { bikeUnit: { is: { title: { contains: search, mode: "insensitive" as const } } } },
        { branch: { is: { name: { contains: search, mode: "insensitive" as const } } } }
      ]
    });
  }

  return { AND: andConditions };
}

function buildBuyoutBaseWhere(tenantId: string, query: z.infer<typeof querySchema>, branchId?: string | null) {
  const search = query.q?.trim();
  const andConditions: Array<Record<string, unknown>> = [{ tenantId }];
  if (branchId) {
    andConditions.push({ branchId });
  }
  const effectiveScope = query.statusGroup === "BUYOUT_COMPLETED" || query.statusGroup === "REPAIR" || query.statusGroup === "PROBLEM"
    ? "ALL"
    : query.scope;

  if (query.statusGroup === "BUYOUT_COMPLETED") {
    andConditions.push({
      status: {
        in: ["CLOSED", "TERMINATED"]
      }
    });
  } else if (effectiveScope === "ACTIVE") {
    andConditions.push({
      status: {
        in: ACTIVE_BUYOUT_STATUSES
      }
    });
  }

  if (query.statusGroup === "REPAIR") {
    andConditions.push({
      bikeUnit: {
        is: {
          status: "REPAIR"
        }
      }
    });
  }

  if (search) {
    andConditions.push({
      OR: [
        { dealNumber: { contains: search, mode: "insensitive" as const } },
        { client: { is: { fullName: { contains: search, mode: "insensitive" as const } } } },
        { bikeUnit: { is: { title: { contains: search, mode: "insensitive" as const } } } },
        { branch: { is: { name: { contains: search, mode: "insensitive" as const } } } }
      ]
    });
  }

  return { AND: andConditions };
}

function buildRentalAttentionWhere(attention: z.infer<typeof querySchema>["attention"], dayBounds: ReturnType<typeof buildDayBounds>) {
  switch (attention) {
    case "DEBT":
      return {
        OR: [
          {
            debtKopecks: {
              gt: 0
            }
          },
          {
            penalties: {
              some: {
                status: "ACTIVE"
              }
            }
          }
        ]
      };
    case "OVERDUE":
      return {
        OR: [
          { status: "OVERDUE" },
          {
            overdueDays: {
              gt: 0
            }
          }
        ]
      };
    case "TODAY":
      return {
        nextPaymentAt: {
          gte: dayBounds.start,
          lt: dayBounds.end
        }
      };
    default:
      return null;
  }
}

function buildBuyoutAttentionWhere(attention: z.infer<typeof querySchema>["attention"], dayBounds: ReturnType<typeof buildDayBounds>) {
  switch (attention) {
    case "DEBT":
      return {
        OR: [
          {
            residualDebtKopecks: {
              gt: 0
            }
          },
          {
            penalties: {
              some: {
                status: "ACTIVE"
              }
            }
          }
        ]
      };
    case "OVERDUE":
      return {
        OR: [
          { status: "OVERDUE" },
          {
            overdueDays: {
              gt: 0
            }
          }
        ]
      };
    case "TODAY":
      return {
        nextPaymentAt: {
          gte: dayBounds.start,
          lt: dayBounds.end
        }
      };
    default:
      return null;
  }
}

function combineWhere(baseWhere: Record<string, unknown>, extraWhere: Record<string, unknown> | null) {
  if (!extraWhere) {
    return baseWhere;
  }

  return {
    AND: [baseWhere, extraWhere]
  };
}

function isSameCalendarDay(value: string | Date | null, dayBounds: ReturnType<typeof buildDayBounds>) {
  if (!value) {
    return false;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date >= dayBounds.start && date < dayBounds.end;
}

function getAttentionState(params: {
  nextPaymentAt: string | Date | null;
  debtKopecks: number;
  overdueDays: number;
  status: string;
  dayBounds: ReturnType<typeof buildDayBounds>;
}) {
  const isOverdue = params.status === "OVERDUE" || params.overdueDays > 0;
  const isDueToday = isSameCalendarDay(params.nextPaymentAt, params.dayBounds);
  const hasDebt = params.debtKopecks > 0;

  if (isOverdue) {
    return {
      code: "OVERDUE",
      label: "Просрочка",
      rank: 300
    };
  }

  if (isDueToday) {
    return {
      code: "TODAY",
      label: "К оплате сегодня",
      rank: 220
    };
  }

  if (hasDebt) {
    return {
      code: "DEBT",
      label: "Есть долг",
      rank: 140
    };
  }

  return {
    code: "OK",
    label: "В графике",
    rank: 40
  };
}

function toTimestamp(value: string | Date | null | undefined) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  return new Date(value).getTime();
}

function getBuyoutCadenceLabel(cadence: string) {
  switch (cadence) {
    case "WEEKLY":
      return "Выкуп · еженедельно";
    case "MONTHLY":
      return "Выкуп · ежемесячно";
    default:
      return "Выкуп";
  }
}

function getMainStatus(params: {
  kind: "RENTAL" | "BUYOUT";
  status: string;
  bikeStatus: string | null | undefined;
  isProblem: boolean;
}) {
  if (params.isProblem) {
    return {
      code: "PROBLEM",
      label: "Проблемы"
    };
  }

  if (params.bikeStatus === "REPAIR") {
    return {
      code: "REPAIR",
      label: "В ремонте"
    };
  }

  if (params.kind === "RENTAL" && (params.status === "COMPLETED" || params.status === "CANCELED")) {
    return {
      code: "RENTAL_COMPLETED",
      label: "Аренда завершена"
    };
  }

  if (params.kind === "BUYOUT" && (params.status === "CLOSED" || params.status === "TERMINATED")) {
    return {
      code: "BUYOUT_COMPLETED",
      label: "Выкуп завершен"
    };
  }

  return params.kind === "RENTAL"
    ? { code: "RENTAL", label: "Аренда" }
    : { code: "BUYOUT", label: "Выкуп" };
}

function matchesStatusGroup(statusGroup: z.infer<typeof querySchema>["statusGroup"], mainStatusCode: string) {
  if (statusGroup === "ALL_ACTIVE") {
    return mainStatusCode === "RENTAL" || mainStatusCode === "BUYOUT" || mainStatusCode === "PROBLEM" || mainStatusCode === "REPAIR";
  }

  return statusGroup === mainStatusCode;
}

async function listOrderAvailableBanks(params: {
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

async function findOrderBranchAndClient(params: {
  kind: "RENTAL" | "BUYOUT";
  tenantId: string;
  dealId: string;
}) {
  if (params.kind === "RENTAL") {
    const rental = await prisma.rental.findFirst({
      where: {
        id: params.dealId,
        tenantId: params.tenantId
      },
      select: {
        id: true,
        branchId: true,
        clientId: true
      }
    });

    if (!rental) {
      return null;
    }

    return {
      kind: "RENTAL" as const,
      targetEntityType: "rental",
      targetEntityId: rental.id,
      branchId: rental.branchId,
      clientId: rental.clientId
    };
  }

  const buyout = await prisma.buyout.findFirst({
    where: {
      id: params.dealId,
      tenantId: params.tenantId
    },
    select: {
      id: true,
      branchId: true,
      clientId: true
    }
  });

  if (!buyout) {
    return null;
  }

  return {
    kind: "BUYOUT" as const,
    targetEntityType: "buyout",
    targetEntityId: buyout.id,
    branchId: buyout.branchId,
    clientId: buyout.clientId
  };
}

const rentalOrderSelect = {
  id: true,
  dealNumber: true,
  status: true,
  isProblem: true,
  tariffLabel: true,
  startsAt: true,
  nextPaymentAt: true,
  plannedPaymentKopecks: true,
  debtKopecks: true,
  overdueDays: true,
  updatedAt: true,
  client: {
    select: {
      id: true,
      fullName: true,
      primaryPhone: true
    }
  },
  bikeUnit: {
    select: {
      title: true,
      status: true,
      article: true,
      bikeModel: {
        select: {
          article: true
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
      }
    }
  },
  branch: {
    select: {
      name: true
    }
  },
  bank: {
    select: {
      id: true,
      name: true
    }
  },
  penalties: {
    where: {
      status: "ACTIVE" as const
    },
    select: {
      amountKopecks: true
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
      createdAt: "desc" as const
    },
    select: {
      cadence: true,
      intervalValue: true,
      cycleAmountKopecks: true,
      nextDueAt: true,
      items: {
        take: 3,
        orderBy: {
          sequenceNumber: "asc" as const
        },
        select: {
          id: true,
          sequenceNumber: true,
          dueAt: true,
          amountKopecks: true,
          paidKopecks: true,
          status: true
        }
      }
    }
  }
} as const;

const buyoutOrderSelect = {
  id: true,
  dealNumber: true,
  status: true,
  isProblem: true,
  paymentCadence: true,
  startsAt: true,
  nextPaymentAt: true,
  totalPriceKopecks: true,
  residualDebtKopecks: true,
  overdueDays: true,
  updatedAt: true,
  client: {
    select: {
      id: true,
      fullName: true,
      primaryPhone: true
    }
  },
  bikeUnit: {
    select: {
      title: true,
      status: true,
      article: true,
      bikeModel: {
        select: {
          article: true
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
      }
    }
  },
  branch: {
    select: {
      name: true
    }
  },
  bank: {
    select: {
      id: true,
      name: true
    }
  },
  penalties: {
    where: {
      status: "ACTIVE" as const
    },
    select: {
      amountKopecks: true
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
      createdAt: "desc" as const
    },
    select: {
      cadence: true,
      intervalValue: true,
      cycleAmountKopecks: true,
      nextDueAt: true,
      items: {
        take: 3,
        orderBy: {
          sequenceNumber: "asc" as const
        },
        select: {
          id: true,
          sequenceNumber: true,
          dueAt: true,
          amountKopecks: true,
          paidKopecks: true,
          status: true
        }
      }
    }
  }
} as const;

function mapRentalOrderRow(rental: {
  id: string;
  dealNumber: string;
  status: string;
  isProblem: boolean;
  tariffLabel: string;
  startsAt: Date;
  nextPaymentAt: Date | null;
  plannedPaymentKopecks: number;
  debtKopecks: number;
  overdueDays: number;
  updatedAt: Date;
  client: {
    id: string;
    fullName: string;
    primaryPhone: string | null;
  };
  bikeUnit: {
    title: string;
    status: string;
    article: string | null;
    bikeModel: {
      article: string | null;
    } | null;
    gpsTracker: {
      id: string;
      externalDeviceId: string;
      deviceName: string;
      deviceAlias: string | null;
      status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
      lastSeenAt: Date | null;
      lastOnlineAt: Date | null;
      lastSyncAt: Date | null;
      lastSyncError: string | null;
    } | null;
  };
  branch: {
    name: string;
  } | null;
  bank: {
    id: string;
    name: string;
  } | null;
  penalties: Array<{
    amountKopecks: number;
  }>;
  _count: {
    penalties: number;
    deposits: number;
    notifications: number;
  };
  paymentSchedules: Array<{
    cadence: string;
    intervalValue: number;
    cycleAmountKopecks: number;
    nextDueAt: Date | null;
    items: Array<{
      id: string;
      sequenceNumber: number;
      dueAt: Date;
      amountKopecks: number;
      paidKopecks: number;
      status: string;
    }>;
  }>;
}, dayBounds: ReturnType<typeof buildDayBounds>) {
  const penaltyBalanceKopecks = rental.penalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
  const attention = getAttentionState({
    nextPaymentAt: rental.nextPaymentAt,
    debtKopecks: rental.debtKopecks + penaltyBalanceKopecks,
    overdueDays: rental.overdueDays,
    status: rental.status,
    dayBounds
  });

  return {
    id: rental.id,
    kind: "RENTAL" as const,
    kindLabel: "Аренда",
    detailHref: `/rentals/${rental.id}`,
    dealNumber: rental.dealNumber,
    status: rental.status,
    paymentPlanLabel: rental.tariffLabel,
    startsAt: rental.startsAt,
    nextPaymentAt: rental.nextPaymentAt,
    paymentAmountKopecks: rental.plannedPaymentKopecks,
    debtKopecks: rental.debtKopecks,
    penaltyBalanceKopecks,
    totalDueKopecks: rental.debtKopecks + penaltyBalanceKopecks,
    overdueDays: rental.overdueDays,
    client: {
      ...rental.client,
      detailHref: `/clients/${rental.client.id}`
    },
    bikeUnit: rental.bikeUnit,
    branch: rental.branch,
    bank: rental.bank,
    gps: buildGpsSnapshot(rental.bikeUnit.gpsTracker),
    _count: rental._count,
    paymentSchedule: rental.paymentSchedules[0] ?? null,
    attention,
    mainStatus: getMainStatus({
      kind: "RENTAL",
      status: rental.status,
      bikeStatus: rental.bikeUnit.status,
      isProblem: rental.isProblem
    }),
    _sortRank: attention.rank,
    _sortDate: toTimestamp(rental.nextPaymentAt ?? rental.startsAt),
    _sortUpdatedAt: toTimestamp(rental.updatedAt)
  };
}

function mapBuyoutOrderRow(buyout: {
  id: string;
  dealNumber: string;
  status: string;
  isProblem: boolean;
  paymentCadence: string;
  startsAt: Date;
  nextPaymentAt: Date | null;
  totalPriceKopecks: number;
  residualDebtKopecks: number;
  overdueDays: number;
  updatedAt: Date;
  client: {
    id: string;
    fullName: string;
    primaryPhone: string | null;
  };
  bikeUnit: {
    title: string;
    status: string;
    article: string | null;
    bikeModel: {
      article: string | null;
    } | null;
    gpsTracker: {
      id: string;
      externalDeviceId: string;
      deviceName: string;
      deviceAlias: string | null;
      status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
      lastSeenAt: Date | null;
      lastOnlineAt: Date | null;
      lastSyncAt: Date | null;
      lastSyncError: string | null;
    } | null;
  };
  branch: {
    name: string;
  } | null;
  bank: {
    id: string;
    name: string;
  } | null;
  penalties: Array<{
    amountKopecks: number;
  }>;
  _count: {
    penalties: number;
    deposits: number;
    notifications: number;
  };
  paymentSchedules: Array<{
    cadence: string;
    intervalValue: number;
    cycleAmountKopecks: number;
    nextDueAt: Date | null;
    items: Array<{
      id: string;
      sequenceNumber: number;
      dueAt: Date;
      amountKopecks: number;
      paidKopecks: number;
      status: string;
    }>;
  }>;
}, dayBounds: ReturnType<typeof buildDayBounds>) {
  const penaltyBalanceKopecks = buyout.penalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
  const attention = getAttentionState({
    nextPaymentAt: buyout.nextPaymentAt,
    debtKopecks: buyout.residualDebtKopecks + penaltyBalanceKopecks,
    overdueDays: buyout.overdueDays,
    status: buyout.status,
    dayBounds
  });

  return {
    id: buyout.id,
    kind: "BUYOUT" as const,
    kindLabel: "Выкуп",
    detailHref: `/buyouts/${buyout.id}`,
    dealNumber: buyout.dealNumber,
    status: buyout.status,
    paymentPlanLabel: getBuyoutCadenceLabel(buyout.paymentCadence),
    startsAt: buyout.startsAt,
    nextPaymentAt: buyout.nextPaymentAt,
    paymentAmountKopecks: buyout.paymentSchedules[0]?.cycleAmountKopecks ?? buyout.totalPriceKopecks,
    debtKopecks: buyout.residualDebtKopecks,
    penaltyBalanceKopecks,
    totalDueKopecks: buyout.residualDebtKopecks + penaltyBalanceKopecks,
    overdueDays: buyout.overdueDays,
    client: {
      ...buyout.client,
      detailHref: `/clients/${buyout.client.id}`
    },
    bikeUnit: buyout.bikeUnit,
    branch: buyout.branch,
    bank: buyout.bank,
    gps: buildGpsSnapshot(buyout.bikeUnit.gpsTracker),
    _count: buyout._count,
    paymentSchedule: buyout.paymentSchedules[0] ?? null,
    attention,
    mainStatus: getMainStatus({
      kind: "BUYOUT",
      status: buyout.status,
      bikeStatus: buyout.bikeUnit.status,
      isProblem: buyout.isProblem
    }),
    _sortRank: attention.rank,
    _sortDate: toTimestamp(buyout.nextPaymentAt ?? buyout.startsAt),
    _sortUpdatedAt: toTimestamp(buyout.updatedAt)
  };
}

export function createOrdersRouter() {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "orders.view");
    const readBranchId = resolveActorBranchReadScope(actor, "orders.view");

    const dayBounds = buildDayBounds();
    const rentalBaseWhere = buildRentalBaseWhere(tenant.id, query, readBranchId);
    const buyoutBaseWhere = buildBuyoutBaseWhere(tenant.id, query, readBranchId);
    const rentalWhere = combineWhere(rentalBaseWhere, buildRentalAttentionWhere(query.attention, dayBounds));
    const buyoutWhere = combineWhere(buyoutBaseWhere, buildBuyoutAttentionWhere(query.attention, dayBounds));
    const takePerType = query.kind ? query.limit : Math.min(query.limit * 2, 100);

    const shouldLoadRentals = query.kind !== "BUYOUT" && query.statusGroup !== "BUYOUT" && query.statusGroup !== "BUYOUT_COMPLETED";
    const shouldLoadBuyouts = query.kind !== "RENTAL" && query.statusGroup !== "RENTAL" && query.statusGroup !== "RENTAL_COMPLETED";
    const shouldLoadFocusedRental = query.focusKind === "RENTAL" && Boolean(query.focusDealId);
    const shouldLoadFocusedBuyout = query.focusKind === "BUYOUT" && Boolean(query.focusDealId);

    const [
      rentals,
      buyouts,
      focusedRental,
      focusedBuyout,
      activeRentalCount,
      activeBuyoutCount,
      rentalCompletedCount,
      buyoutCompletedCount,
      rentalProblemCount,
      buyoutProblemCount,
      idleBikeCount,
      repairBikeCount,
      rentalOverdueCount,
      buyoutOverdueCount,
      rentalDueTodayCount,
      buyoutDueTodayCount,
      rentalDebtorsCount,
      buyoutDebtorsCount,
      rentalDebtAggregate,
      buyoutDebtAggregate,
      rentalPenaltyAggregate,
      buyoutPenaltyAggregate
    ] = await Promise.all([
      shouldLoadRentals
        ? prisma.rental.findMany({
            where: rentalWhere,
            orderBy: [
              { nextPaymentAt: "asc" },
              { updatedAt: "desc" }
            ],
            take: takePerType,
            select: rentalOrderSelect
          })
        : Promise.resolve([]),
      shouldLoadBuyouts
        ? prisma.buyout.findMany({
            where: buyoutWhere,
            orderBy: [
              { nextPaymentAt: "asc" },
              { updatedAt: "desc" }
            ],
            take: takePerType,
            select: buyoutOrderSelect
          })
        : Promise.resolve([]),
      shouldLoadFocusedRental
        ? prisma.rental.findFirst({
            where: {
              id: query.focusDealId,
              tenantId: tenant.id,
              ...(readBranchId ? { branchId: readBranchId } : {})
            },
            select: rentalOrderSelect
          })
        : Promise.resolve(null),
      shouldLoadFocusedBuyout
        ? prisma.buyout.findFirst({
            where: {
              id: query.focusDealId,
              tenantId: tenant.id,
              ...(readBranchId ? { branchId: readBranchId } : {})
            },
            select: buyoutOrderSelect
          })
        : Promise.resolve(null),
      prisma.rental.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: [...ACTIVE_RENTAL_STATUSES]
          }
        }
      }),
      prisma.buyout.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: [...ACTIVE_BUYOUT_STATUSES]
          }
        }
      }),
      prisma.rental.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: ["COMPLETED", "CANCELED"]
          }
        }
      }),
      prisma.buyout.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: {
            in: ["CLOSED", "TERMINATED"]
          }
        }
      }),
      prisma.rental.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          isProblem: true
        }
      }),
      prisma.buyout.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          isProblem: true
        }
      }),
      prisma.bikeUnit.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: "AVAILABLE"
        }
      }),
      prisma.bikeUnit.count({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {}),
          status: "REPAIR"
        }
      }),
      shouldLoadRentals ? prisma.rental.count({ where: combineWhere(rentalBaseWhere, buildRentalAttentionWhere("OVERDUE", dayBounds)) }) : Promise.resolve(0),
      shouldLoadBuyouts ? prisma.buyout.count({ where: combineWhere(buyoutBaseWhere, buildBuyoutAttentionWhere("OVERDUE", dayBounds)) }) : Promise.resolve(0),
      shouldLoadRentals ? prisma.rental.count({ where: combineWhere(rentalBaseWhere, buildRentalAttentionWhere("TODAY", dayBounds)) }) : Promise.resolve(0),
      shouldLoadBuyouts ? prisma.buyout.count({ where: combineWhere(buyoutBaseWhere, buildBuyoutAttentionWhere("TODAY", dayBounds)) }) : Promise.resolve(0),
      shouldLoadRentals ? prisma.rental.count({ where: combineWhere(rentalBaseWhere, buildRentalAttentionWhere("DEBT", dayBounds)) }) : Promise.resolve(0),
      shouldLoadBuyouts ? prisma.buyout.count({ where: combineWhere(buyoutBaseWhere, buildBuyoutAttentionWhere("DEBT", dayBounds)) }) : Promise.resolve(0),
      shouldLoadRentals
        ? prisma.rental.aggregate({
            where: rentalBaseWhere,
            _sum: {
              debtKopecks: true
            }
          })
        : Promise.resolve({ _sum: { debtKopecks: 0 } }),
      shouldLoadBuyouts
        ? prisma.buyout.aggregate({
            where: buyoutBaseWhere,
            _sum: {
              residualDebtKopecks: true
            }
          })
        : Promise.resolve({ _sum: { residualDebtKopecks: 0 } }),
      shouldLoadRentals
        ? prisma.penalty.aggregate({
            where: {
              tenantId: tenant.id,
              status: "ACTIVE",
              rental: {
                is: rentalBaseWhere as never
              }
            },
            _sum: {
              amountKopecks: true
            }
          })
        : Promise.resolve({ _sum: { amountKopecks: 0 } }),
      shouldLoadBuyouts
        ? prisma.penalty.aggregate({
            where: {
              tenantId: tenant.id,
              status: "ACTIVE",
              buyout: {
                is: buyoutBaseWhere as never
              }
            },
            _sum: {
              amountKopecks: true
            }
          })
        : Promise.resolve({ _sum: { amountKopecks: 0 } })
    ]);

    const rows = [
      ...rentals.map((rental) => mapRentalOrderRow(rental, dayBounds)),
      ...buyouts.map((buyout) => mapBuyoutOrderRow(buyout, dayBounds))
    ];

    const filteredRows = rows.filter((row) => matchesStatusGroup(query.statusGroup, row.mainStatus.code));

    const focusRow = focusedRental
      ? mapRentalOrderRow(focusedRental, dayBounds)
      : focusedBuyout
        ? mapBuyoutOrderRow(focusedBuyout, dayBounds)
        : null;
    const sortedRows = filteredRows
      .sort((left, right) => {
        if (right._sortRank !== left._sortRank) {
          return right._sortRank - left._sortRank;
        }

        if (left._sortDate !== right._sortDate) {
          return left._sortDate - right._sortDate;
        }

        return right._sortUpdatedAt - left._sortUpdatedAt;
      });

    const limitedRows = sortedRows.slice(0, query.limit);
    const mergedRows = focusRow
      ? [focusRow, ...limitedRows.filter((row) => !(row.kind === focusRow.kind && row.id === focusRow.id))]
      : limitedRows;

    const outputRows = mergedRows
      .slice(0, query.limit)
      .map(({ _sortRank: _leftRank, _sortDate: _leftDate, _sortUpdatedAt: _leftUpdatedAt, ...row }) => row);

    const rentalRowIds = outputRows.filter((row) => row.kind === "RENTAL").map((row) => row.id);
    const buyoutRowIds = outputRows.filter((row) => row.kind === "BUYOUT").map((row) => row.id);
    const noteWhereClauses = [
      rentalRowIds.length > 0 ? { targetEntityType: "rental" as const, targetEntityId: { in: rentalRowIds } } : null,
      buyoutRowIds.length > 0 ? { targetEntityType: "buyout" as const, targetEntityId: { in: buyoutRowIds } } : null
    ].filter(Boolean);

    const rowNotes = noteWhereClauses.length > 0
      ? await prisma.note.findMany({
          where: {
            tenantId: tenant.id,
            OR: noteWhereClauses
          },
          orderBy: {
            createdAt: "desc"
          },
          select: {
            id: true,
            text: true,
            colorHex: true,
            createdAt: true,
            targetEntityType: true,
            targetEntityId: true
          }
        })
      : [];

    const notesByRowKey = new Map<string, Array<ReturnType<typeof mapNoteRecord>>>();
    for (const note of rowNotes) {
      const rowKey = `${note.targetEntityType === "rental" ? "RENTAL" : "BUYOUT"}:${note.targetEntityId}`;
      const current = notesByRowKey.get(rowKey) ?? [];
      if (current.length >= 6) {
        continue;
      }

      const sanitizedNote = sanitizeOperatorNoteRecord(mapNoteRecord(note));
      if (!sanitizedNote) {
        continue;
      }

      current.push(sanitizedNote);
      notesByRowKey.set(rowKey, current);
    }

    const rowsWithNotes = outputRows.map((row) => ({
      ...row,
      notes: notesByRowKey.get(`${row.kind}:${row.id}`) ?? []
    }));

    res.status(200).json({
      tenant,
      filters: {
        query: query.q?.trim() ?? null,
        kind: query.kind ?? null,
        scope: query.scope,
        attention: query.attention,
        statusGroup: query.statusGroup,
        limit: query.limit
      },
      summary: {
        totalCount: activeRentalCount + activeBuyoutCount,
        filteredCount: filteredRows.length,
        rentalCount: activeRentalCount,
        buyoutCount: activeBuyoutCount,
        inWorkCount: activeRentalCount + activeBuyoutCount,
        problemCount: rentalProblemCount + buyoutProblemCount,
        idleBikeCount,
        repairBikeCount,
        rentalCompletedCount,
        buyoutCompletedCount,
        overdueCount: rentalOverdueCount + buyoutOverdueCount,
        dueTodayCount: rentalDueTodayCount + buyoutDueTodayCount,
        debtorsCount: rentalDebtorsCount + buyoutDebtorsCount,
        totalDebtKopecks:
          (rentalDebtAggregate._sum.debtKopecks ?? 0)
          + (buyoutDebtAggregate._sum.residualDebtKopecks ?? 0)
          + (rentalPenaltyAggregate._sum.amountKopecks ?? 0)
          + (buyoutPenaltyAggregate._sum.amountKopecks ?? 0)
      },
      rows: rowsWithNotes
    });
  }));

  router.get("/:kind/:dealId/expand", asyncHandler(async (req, res) => {
    const params = expandParamsSchema.parse(req.params);
    const query = expandQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "orders.view");
    const readBranchId = resolveActorBranchReadScope(actor, "orders.view");

    if (params.kind === "RENTAL") {
      const rental = await prisma.rental.findFirst({
        where: {
          id: params.dealId,
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        select: {
          id: true,
          dealNumber: true,
          status: true,
          isProblem: true,
          comment: true,
          startsAt: true,
          nextPaymentAt: true,
          plannedPaymentKopecks: true,
          debtKopecks: true,
          overdueDays: true,
          autoPenaltyEnabled: true,
          autoPenaltyDailyKopecks: true,
          depositTargetKopecks: true,
          depositCollectedKopecks: true,
          depositReturnedKopecks: true,
          bikeUnit: {
            select: {
              title: true,
              internalCode: true,
              article: true,
              serialNumber: true,
              status: true,
              bikeModel: {
                select: {
                  article: true
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
              }
            }
          },
          bank: {
            select: {
              id: true,
              name: true,
              phone: true,
              comment: true,
              instructionType: true
            }
          },
          penalties: {
            where: {
              status: "ACTIVE"
            },
            orderBy: {
              accrualDate: "desc"
            },
            take: 5,
            select: {
              id: true,
              amountKopecks: true,
              reason: true,
              comment: true,
              accrualDate: true,
              mode: true
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
              nextDueAt: true,
              cycleAmountKopecks: true
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
      });

      if (!rental) {
        res.status(404).json({
          error: {
            message: `Order '${params.dealId}' was not found`
          }
        });
        return;
      }

      const [payments, notes, availableBanks, depositTransactions, penaltyHistory] = await Promise.all([
        prisma.financialTransaction.findMany({
          where: {
            tenantId: tenant.id,
            rentalId: rental.id,
            status: "POSTED",
            direction: "INCOME",
            type: {
              in: ["RENTAL_PAYMENT_IN", "PARTIAL_PAYMENT_IN", "PENALTY_PAYMENT_IN", "DOWN_PAYMENT_IN"]
            }
          },
          orderBy: {
            happenedAt: "desc"
          },
          take: 8,
          select: {
            id: true,
            type: true,
            paymentMethod: true,
            amountKopecks: true,
            happenedAt: true,
            comment: true,
            bank: {
              select: {
                name: true
              }
            }
          }
        }),
        listTargetNotes({
          tenantId: tenant.id,
          targetEntityType: "rental",
          targetEntityId: rental.id
        }),
        listOrderAvailableBanks({
          tenantId: tenant.id,
          branchId: readBranchId
        }),
        prisma.financialTransaction.findMany({
          where: {
            tenantId: tenant.id,
            rentalId: rental.id,
            status: "POSTED",
            type: {
              in: ["DEPOSIT_IN", "DEPOSIT_REFUND_OUT"]
            }
          },
          orderBy: {
            happenedAt: "desc"
          },
          take: 6,
          select: {
            id: true,
            type: true,
            paymentMethod: true,
            amountKopecks: true,
            happenedAt: true,
            comment: true,
            bank: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }),
        prisma.penalty.findMany({
          where: {
            tenantId: tenant.id,
            rentalId: rental.id
          },
          orderBy: {
            accrualDate: "desc"
          },
          take: 8,
          select: {
            id: true,
            amountKopecks: true,
            reason: true,
            comment: true,
            accrualDate: true,
            mode: true,
            status: true
          }
        })
      ]);

      const penaltyBalanceKopecks = rental.penalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
      const attention = getAttentionState({
        nextPaymentAt: rental.nextPaymentAt,
        debtKopecks: rental.debtKopecks + penaltyBalanceKopecks,
        overdueDays: rental.overdueDays,
        status: rental.status,
        dayBounds: buildDayBounds()
      });
      res.status(200).json({
        tenant,
        deal: {
          id: rental.id,
          kind: "RENTAL",
          kindLabel: "Аренда",
          detailHref: `/rentals/${rental.id}`,
          dealNumber: rental.dealNumber,
          status: rental.status,
          mainStatus: getMainStatus({
            kind: "RENTAL",
            status: rental.status,
            bikeStatus: rental.bikeUnit.status,
            isProblem: rental.isProblem
          }),
          attention,
          comment: sanitizeOperatorComment(rental.comment),
          startsAt: rental.startsAt,
          nextPaymentAt: rental.nextPaymentAt,
          paymentAmountKopecks: rental.plannedPaymentKopecks,
          debtKopecks: rental.debtKopecks,
          penaltyBalanceKopecks,
          totalDueKopecks: rental.debtKopecks + penaltyBalanceKopecks,
          overdueDays: rental.overdueDays,
          autoPenaltyEnabled: rental.autoPenaltyEnabled,
          autoPenaltyDailyKopecks: rental.autoPenaltyDailyKopecks,
          bikeUnit: rental.bikeUnit,
          bank: rental.bank,
          availableBanks,
          deposit: {
            targetKopecks: rental.depositTargetKopecks,
            collectedKopecks: rental.depositCollectedKopecks,
            returnedKopecks: rental.depositReturnedKopecks,
            refundableKopecks: Math.max(0, rental.depositCollectedKopecks - rental.depositReturnedKopecks),
            transactions: depositTransactions
          },
          paymentSchedule: rental.paymentSchedules[0] ?? null,
          equipment: rental.equipmentItems,
          payments,
          notes,
          penalties: rental.penalties,
          penaltyHistory,
          gps: buildGpsSnapshot(rental.bikeUnit.gpsTracker)
        }
      });
      return;
    }

      const buyout = await prisma.buyout.findFirst({
        where: {
          id: params.dealId,
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        select: {
        id: true,
        dealNumber: true,
        status: true,
        isProblem: true,
        comment: true,
        startsAt: true,
        nextPaymentAt: true,
        totalPriceKopecks: true,
        residualDebtKopecks: true,
        overdueDays: true,
        autoPenaltyEnabled: true,
        autoPenaltyDailyKopecks: true,
        paymentCadence: true,
          bikeUnit: {
            select: {
              title: true,
              internalCode: true,
              article: true,
              serialNumber: true,
              status: true,
              bikeModel: {
                select: {
                  article: true
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
              }
            }
          },
        bank: {
          select: {
            id: true,
            name: true,
            phone: true,
            comment: true,
            instructionType: true
          }
        },
        penalties: {
          where: {
            status: "ACTIVE"
          },
          orderBy: {
            accrualDate: "desc"
          },
          take: 5,
          select: {
            id: true,
            amountKopecks: true,
            reason: true,
            comment: true,
            accrualDate: true,
            mode: true
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
            nextDueAt: true,
            cycleAmountKopecks: true
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
    });

    if (!buyout) {
      res.status(404).json({
        error: {
          message: `Order '${params.dealId}' was not found`
        }
      });
      return;
    }

    const [payments, notes, availableBanks, penaltyHistory] = await Promise.all([
      prisma.financialTransaction.findMany({
        where: {
          tenantId: tenant.id,
          buyoutId: buyout.id,
          status: "POSTED",
          direction: "INCOME",
          type: {
            in: ["BUYOUT_PAYMENT_IN", "PARTIAL_PAYMENT_IN", "PENALTY_PAYMENT_IN", "DOWN_PAYMENT_IN"]
          }
        },
        orderBy: {
          happenedAt: "desc"
        },
        take: 8,
        select: {
          id: true,
          type: true,
          paymentMethod: true,
          amountKopecks: true,
          happenedAt: true,
          comment: true,
          bank: {
            select: {
              name: true
            }
          }
        }
      }),
      listTargetNotes({
        tenantId: tenant.id,
        targetEntityType: "buyout",
        targetEntityId: buyout.id
      }),
      listOrderAvailableBanks({
        tenantId: tenant.id,
        branchId: readBranchId
      }),
      prisma.penalty.findMany({
        where: {
          tenantId: tenant.id,
          buyoutId: buyout.id
        },
        orderBy: {
          accrualDate: "desc"
        },
        take: 8,
        select: {
          id: true,
          amountKopecks: true,
          reason: true,
          comment: true,
          accrualDate: true,
          mode: true,
          status: true
        }
      })
    ]);

    const penaltyBalanceKopecks = buyout.penalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
    const attention = getAttentionState({
      nextPaymentAt: buyout.nextPaymentAt,
      debtKopecks: buyout.residualDebtKopecks + penaltyBalanceKopecks,
      overdueDays: buyout.overdueDays,
      status: buyout.status,
      dayBounds: buildDayBounds()
    });
    res.status(200).json({
      tenant,
      deal: {
        id: buyout.id,
        kind: "BUYOUT",
        kindLabel: "Выкуп",
        detailHref: `/buyouts/${buyout.id}`,
        dealNumber: buyout.dealNumber,
        status: buyout.status,
        mainStatus: getMainStatus({
          kind: "BUYOUT",
          status: buyout.status,
          bikeStatus: buyout.bikeUnit.status,
          isProblem: buyout.isProblem
        }),
        attention,
        comment: sanitizeOperatorComment(buyout.comment),
        startsAt: buyout.startsAt,
        nextPaymentAt: buyout.nextPaymentAt,
        paymentAmountKopecks: buyout.paymentSchedules[0]?.cycleAmountKopecks ?? buyout.totalPriceKopecks,
        debtKopecks: buyout.residualDebtKopecks,
        penaltyBalanceKopecks,
        totalDueKopecks: buyout.residualDebtKopecks + penaltyBalanceKopecks,
        overdueDays: buyout.overdueDays,
        autoPenaltyEnabled: buyout.autoPenaltyEnabled,
        autoPenaltyDailyKopecks: buyout.autoPenaltyDailyKopecks,
        paymentPlanLabel: getBuyoutCadenceLabel(buyout.paymentCadence),
        bikeUnit: buyout.bikeUnit,
        bank: buyout.bank,
        availableBanks,
        deposit: null,
        paymentSchedule: buyout.paymentSchedules[0] ?? null,
        equipment: buyout.equipmentItems,
        payments,
        notes,
        penalties: buyout.penalties,
        penaltyHistory,
        gps: buildGpsSnapshot(buyout.bikeUnit.gpsTracker)
      }
    });
  }));

  router.post("/:kind/:dealId/unified-payment", asyncHandler(async (req, res) => {
    const params = expandParamsSchema.parse(req.params);
    const payload = unifiedPaymentSchema.parse(req.body);
    const paymentPermission = params.kind === "RENTAL" ? "rentals.post_payment" : "buyouts.post_payment";
    const penaltyPermission = params.kind === "RENTAL" ? "rentals.pay_penalty" : "buyouts.pay_penalty";
    const primaryPermission = payload.mainAmountKopecks > 0 ? paymentPermission : penaltyPermission;
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, primaryPermission);

    if (payload.penaltyIds.length > 0 && !actorHasPermission(actor, penaltyPermission)) {
      throw new HttpError(403, "Недостаточно прав для оплаты штрафов в составе единого платежа.");
    }

    const target = await findOrderBranchAndClient({
      kind: params.kind,
      tenantId: tenant.id,
      dealId: params.dealId
    });

    if (!target) {
      res.status(404).json({
        error: {
          message: `Order '${params.dealId}' was not found`
        }
      });
      return;
    }

    const requiredPermissions = [
      ...(payload.mainAmountKopecks > 0 ? [paymentPermission] : []),
      ...(payload.penaltyIds.length > 0 ? [penaltyPermission] : [])
    ];
    assertActorBranchAccess(actor, requiredPermissions, target.branchId);

    const result = await postUnifiedOrderPayment({
      tenantSlug: payload.tenantSlug,
      kind: params.kind,
      dealId: params.dealId,
      actorUserId: actor.userId,
      totalAmountKopecks: payload.totalAmountKopecks,
      mainAmountKopecks: payload.mainAmountKopecks,
      penaltyIds: payload.penaltyIds,
      paymentMethod: payload.paymentMethod,
      bankId: payload.paymentMethod === "BANK" ? payload.bankId : undefined,
      happenedAt: payload.happenedAt,
      comment: payload.comment,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });

    res.status(201).json(result);
  }));

  router.post("/:kind/:dealId/notes", asyncHandler(async (req, res) => {
    const params = expandParamsSchema.parse(req.params);
    const payload = notePayloadSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "orders.edit");

    const target = await findOrderBranchAndClient({
      kind: params.kind,
      tenantId: tenant.id,
      dealId: params.dealId
    });

    if (!target) {
      res.status(404).json({
        error: {
          message: `Order '${params.dealId}' was not found`
        }
      });
      return;
    }

    assertActorBranchAccess(actor, "orders.edit", target.branchId);

    const note = await prisma.note.create({
      data: {
        tenantId: tenant.id,
        createdById: actor.userId,
        clientId: target.clientId ?? null,
        targetEntityType: target.targetEntityType,
        targetEntityId: target.targetEntityId,
        text: payload.text.trim(),
        colorHex: payload.colorHex?.trim().toLowerCase() ?? null
      },
      select: {
        id: true,
        text: true,
        colorHex: true,
        createdAt: true
      }
    });

    const notes = await listTargetNotes({
      tenantId: tenant.id,
      targetEntityType: target.targetEntityType,
      targetEntityId: target.targetEntityId
    });

    res.status(201).json({
      tenant,
      note,
      notes
    });
  }));

  router.delete("/:kind/:dealId/notes/:noteId", asyncHandler(async (req, res) => {
    const params = noteParamsSchema.parse(req.params);
    const query = expandQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "orders.edit");

    const target = await findOrderBranchAndClient({
      kind: params.kind,
      tenantId: tenant.id,
      dealId: params.dealId
    });

    if (!target) {
      res.status(404).json({
        error: {
          message: `Order '${params.dealId}' was not found`
        }
      });
      return;
    }

    assertActorBranchAccess(actor, "orders.edit", target.branchId);

    const note = await prisma.note.findFirst({
      where: {
        id: params.noteId,
        tenantId: tenant.id,
        targetEntityType: target.targetEntityType,
        targetEntityId: target.targetEntityId
      },
      select: {
        id: true
      }
    });

    if (!note) {
      res.status(404).json({
        error: {
          message: `Note '${params.noteId}' was not found`
        }
      });
      return;
    }

    await prisma.note.delete({
      where: {
        id: note.id
      }
    });

    const notes = await listTargetNotes({
      tenantId: tenant.id,
      targetEntityType: target.targetEntityType,
      targetEntityId: target.targetEntityId
    });

    res.status(200).json({
      tenant,
      deletedNoteId: note.id,
      notes
    });
  }));

  return router;
}
