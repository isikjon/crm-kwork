import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../core/http/errors.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { prisma } from "../../db/prisma.js";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";
import {
  hasFullStarLineCredentials,
  loadStarLineCredentials,
  testStarLineConnection,
  type StarLineCredentials
} from "../starline/service.js";
import {
  buildTrackerAutoMatchAnalyses,
  presentTrackerRow,
  syncStarLineTrackers,
  syncStarLineTrackersFromDevices
} from "./service.js";
import { isAssignableBikeUnitName } from "../fleet/bike-unit-classifier.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";

const tenantQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64)
});

const workspaceQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  q: z.string().trim().max(120).optional(),
  quick: z.enum(["all", "problems", "unbound", "rebind"]).optional().default("all"),
  binding: z.enum(["all", "bound", "unbound", "suggested"]).optional().default("all"),
  match: z.enum(["all", "auto_matched", "unmatched", "ambiguous", "manual_binding", "rebind_candidate"]).optional().default("all"),
  network: z.enum(["all", "online", "offline"]).optional().default("all"),
  sync: z.enum(["all", "needs_sync"]).optional().default("all"),
  review: z.enum(["all", "review_needed", "rebind_candidate"]).optional().default("all")
});

const connectionSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  appId: z.string().trim().min(2).max(200),
  appSecret: z.string().trim().min(2).max(400),
  userLogin: z.string().trim().min(2).max(200),
  userPassword: z.string().trim().min(2).max(400)
});

const bindingParamsSchema = z.object({
  trackerId: z.string().trim().min(2).max(128)
});

const bindingSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  bikeUnitId: z.string().trim().min(2).max(128).nullable()
});

const ACTIVE_RENTAL_STATUSES = ["NEW", "ACTIVE", "OVERDUE", "HOLD", "RETURN_PREP"] as const;
const ACTIVE_BUYOUT_STATUSES = ["NEW", "ACTIVE", "OVERDUE", "HOLD"] as const;

function toCredentials(input: z.infer<typeof connectionSchema>): StarLineCredentials {
  return {
    appId: input.appId.trim(),
    appSecret: input.appSecret.trim(),
    userLogin: input.userLogin.trim(),
    userPassword: input.userPassword.trim()
  };
}

async function findLatestStarLineIntegration(tenantId: string) {
  return prisma.integration.findFirst({
    where: {
      tenantId,
      kind: "STARLINE"
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      id: true,
      status: true,
      label: true,
      login: true,
      password: true,
      externalAccountId: true,
      secretKey: true,
      baseUrl: true,
      lastCheckedAt: true,
      lastErrorText: true
    }
  });
}

async function createOrUpdateStarLineIntegration(params: {
  tenantId: string;
  credentials: StarLineCredentials;
  status?: "CONNECTED" | "DISCONNECTED" | "ERROR";
  lastErrorText?: string | null;
}) {
  const existing = await findLatestStarLineIntegration(params.tenantId);
  const data = {
    kind: "STARLINE" as const,
    status: params.status ?? "CONNECTED",
    label: "StarLine GPS",
    baseUrl: "https://developer.starline.ru",
    login: params.credentials.userLogin,
    password: params.credentials.userPassword,
    externalAccountId: params.credentials.appId,
    secretKey: params.credentials.appSecret,
    lastCheckedAt: new Date(),
    lastErrorText: params.lastErrorText ?? null
  };

  if (existing) {
    return prisma.integration.update({
      where: { id: existing.id },
      data
    });
  }

  return prisma.integration.create({
    data: {
      tenantId: params.tenantId,
      ...data
    }
  });
}

function presentBikeDealContext(input: {
  rentals: Array<{
    id: string;
    dealNumber: string;
    status: string;
    client: {
      fullName: string;
    };
  }>;
  buyouts: Array<{
    id: string;
    dealNumber: string;
    status: string;
    client: {
      fullName: string;
    };
  }>;
}) {
  const rental = input.rentals[0];
  if (rental) {
    return {
      kind: "RENTAL" as const,
      id: rental.id,
      dealNumber: rental.dealNumber,
      status: rental.status,
      clientName: rental.client.fullName
    };
  }

  const buyout = input.buyouts[0];
  if (buyout) {
    return {
      kind: "BUYOUT" as const,
      id: buyout.id,
      dealNumber: buyout.dealNumber,
      status: buyout.status,
      clientName: buyout.client.fullName
    };
  }

  return null;
}

function isBoundState(value: string) {
  return value === "BOUND_OK" || value === "REVIEW_NEEDED" || value === "REBIND_CANDIDATE";
}

function isTrackerProblem(input: {
  bindingState: string;
  signalState: string;
}) {
  return input.bindingState !== "BOUND_OK" || input.signalState === "SYNC_NEEDED" || input.signalState === "SYNC_ERROR" || input.signalState === "OFFLINE";
}

function getTrackerSortWeight(input: {
  bindingState: string;
  signalState: string;
}) {
  if (input.bindingState === "REBIND_CANDIDATE") {
    return 0;
  }

  if (input.bindingState === "REVIEW_NEEDED" || input.bindingState === "UNBOUND_AMBIGUOUS") {
    return 1;
  }

  if (input.bindingState === "UNBOUND" || input.bindingState === "UNBOUND_SUGGESTED") {
    return 2;
  }

  if (input.signalState === "SYNC_ERROR") {
    return 3;
  }

  if (input.signalState === "SYNC_NEEDED" || input.signalState === "OFFLINE") {
    return 4;
  }

  return 5;
}

function matchesWorkspaceSearch(
  search: string,
  tracker: {
    externalDeviceId: string;
    deviceName: string;
    deviceAlias: string | null;
    bike: {
      title: string;
      article: string | null;
    } | null;
    suggestedBike: {
      title: string;
      article: string | null;
    } | null;
    reviewCandidateBike: {
      title: string;
      article: string | null;
    } | null;
  }
) {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  if (!normalizedSearch) {
    return true;
  }

  const haystacks = [
    tracker.externalDeviceId,
    tracker.deviceName,
    tracker.deviceAlias,
    tracker.bike?.title,
    tracker.bike?.article,
    tracker.suggestedBike?.title,
    tracker.suggestedBike?.article,
    tracker.reviewCandidateBike?.title,
    tracker.reviewCandidateBike?.article
  ]
    .filter(Boolean)
    .map((value) => String(value).toLocaleLowerCase());

  return haystacks.some((value) => value.includes(normalizedSearch));
}

function applyTrackerFilters(
  tracker: {
    bindingState: string;
    matchState: string;
    signalState: string;
    suggestedBike: object | null;
  },
  filters: z.infer<typeof workspaceQuerySchema>
) {
  const isBound = isBoundState(tracker.bindingState);
  const isUnbound = !isBound;
  const hasSuggestion = Boolean(tracker.suggestedBike) || tracker.bindingState === "REBIND_CANDIDATE";
  const isProblem = isTrackerProblem(tracker);

  if (filters.quick === "problems" && !isProblem) {
    return false;
  }

  if (filters.quick === "unbound" && !isUnbound) {
    return false;
  }

  if (filters.quick === "rebind" && tracker.bindingState !== "REBIND_CANDIDATE") {
    return false;
  }

  if (filters.binding === "bound" && !isBound) {
    return false;
  }

  if (filters.binding === "unbound" && !isUnbound) {
    return false;
  }

  if (filters.binding === "suggested" && !hasSuggestion) {
    return false;
  }

  if (filters.match === "auto_matched" && tracker.matchState !== "AUTO_MATCHED") {
    return false;
  }

  if (filters.match === "unmatched" && tracker.matchState !== "UNMATCHED") {
    return false;
  }

  if (filters.match === "ambiguous" && tracker.matchState !== "AMBIGUOUS") {
    return false;
  }

  if (filters.match === "manual_binding" && tracker.matchState !== "MANUAL_BINDING") {
    return false;
  }

  if (filters.match === "rebind_candidate" && tracker.matchState !== "REBIND_CANDIDATE") {
    return false;
  }

  if (filters.network === "online" && tracker.signalState !== "ONLINE") {
    return false;
  }

  if (filters.network === "offline" && tracker.signalState !== "OFFLINE") {
    return false;
  }

  if (filters.sync === "needs_sync" && tracker.signalState !== "SYNC_NEEDED" && tracker.signalState !== "SYNC_ERROR") {
    return false;
  }

  if (filters.review === "review_needed" && tracker.bindingState !== "REVIEW_NEEDED" && tracker.bindingState !== "UNBOUND_AMBIGUOUS") {
    return false;
  }

  if (filters.review === "rebind_candidate" && tracker.bindingState !== "REBIND_CANDIDATE") {
    return false;
  }

  return true;
}

export function createGpsRouter() {
  const router = Router();

  router.get("/workspace", asyncHandler(async (req, res) => {
    const query = workspaceQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "gps.view");
    const readBranchId = resolveActorBranchReadScope(actor, "gps.view");

    const [integration, trackersRaw, bikesRaw, fallbackCredentials] = await Promise.all([
      findLatestStarLineIntegration(tenant.id),
      prisma.gpsTracker.findMany({
        where: {
          tenantId: tenant.id,
          ...(readBranchId
            ? {
                OR: [
                  { bikeUnitId: null },
                  {
                    bikeUnit: {
                      branchId: readBranchId
                    }
                  }
                ]
              }
            : {})
        },
        orderBy: [
          { bikeUnitId: "asc" },
          { deviceName: "asc" }
        ],
        select: {
          id: true,
          provider: true,
          externalDeviceId: true,
          deviceName: true,
          deviceAlias: true,
          bindingSource: true,
          status: true,
          activityRaw: true,
          lastSeenAt: true,
          lastOnlineAt: true,
          lastSyncAt: true,
          lastSyncError: true,
          bikeUnitId: true,
          bikeUnit: {
            select: {
              id: true,
              title: true,
              article: true,
              status: true,
              branch: {
                select: {
                  id: true,
                  name: true
                }
              },
              rentals: {
                where: {
                  status: {
                    in: [...ACTIVE_RENTAL_STATUSES]
                  }
                },
                orderBy: [
                  { startsAt: "desc" },
                  { createdAt: "desc" }
                ],
                take: 1,
                select: {
                  id: true,
                  dealNumber: true,
                  status: true,
                  client: {
                    select: {
                      fullName: true
                    }
                  }
                }
              },
              buyouts: {
                where: {
                  status: {
                    in: [...ACTIVE_BUYOUT_STATUSES]
                  }
                },
                orderBy: [
                  { startsAt: "desc" },
                  { createdAt: "desc" }
                ],
                take: 1,
                select: {
                  id: true,
                  dealNumber: true,
                  status: true,
                  client: {
                    select: {
                      fullName: true
                    }
                  }
                }
              }
            }
          }
        }
      }),
      prisma.bikeUnit.findMany({
        where: {
          tenantId: tenant.id,
          ...(readBranchId ? { branchId: readBranchId } : {})
        },
        orderBy: [
          { status: "asc" },
          { title: "asc" }
        ],
        select: {
          id: true,
          title: true,
          article: true,
          status: true,
          branch: {
            select: {
              id: true,
              name: true
            }
          },
          bikeModel: {
            select: {
              name: true
            }
          },
          gpsTracker: {
            select: {
              id: true
            }
          }
        }
      }),
      loadStarLineCredentials(tenant.id)
    ]);

    const storedCredentials = integration
      ? {
          appId: String(integration.externalAccountId ?? "").trim(),
          appSecret: String(integration.secretKey ?? "").trim(),
          userLogin: String(integration.login ?? "").trim(),
          userPassword: String(integration.password ?? "").trim()
        }
      : null;

    const bikes = bikesRaw
      .filter((bike: any) => isAssignableBikeUnitName(bike.title, bike.bikeModel?.name))
      .map((bike: any) => ({
        id: bike.id,
        title: bike.title,
        article: bike.article,
        status: bike.status,
        branch: bike.branch,
        trackerId: bike.gpsTracker?.id ?? null
      }));

    const analysesByTrackerId = new Map(
      buildTrackerAutoMatchAnalyses(
        trackersRaw.map((tracker: any) => ({
          id: tracker.id,
          deviceName: tracker.deviceName,
          deviceAlias: tracker.deviceAlias,
          bikeUnitId: tracker.bikeUnitId,
          bindingSource: tracker.bindingSource,
          status: tracker.status,
          lastSyncAt: tracker.lastSyncAt,
          lastSyncError: tracker.lastSyncError
        })),
        bikes
      ).map((item) => [item.trackerId, item] as const)
    );

    const allTrackers = trackersRaw.map((tracker: any) => {
      const presentedTracker = presentTrackerRow(tracker);
      const analysis = analysesByTrackerId.get(tracker.id);

      return {
        ...presentedTracker,
        bike: tracker.bikeUnit
          ? {
              id: tracker.bikeUnit.id,
              title: tracker.bikeUnit.title,
              article: tracker.bikeUnit.article,
              status: tracker.bikeUnit.status,
              branch: tracker.bikeUnit.branch,
              activeDeal: presentBikeDealContext(tracker.bikeUnit)
            }
          : null,
        suggestedBike: analysis?.suggestedBike ?? null,
        reviewCandidateBike: analysis?.reviewCandidateBike ?? null,
        hasAmbiguousSuggestion: analysis?.hasAmbiguousSuggestion ?? false,
        bindingState: analysis?.bindingState ?? "UNBOUND",
        matchState: analysis?.matchState ?? "UNMATCHED",
        signalState: analysis?.signalState ?? "UNKNOWN",
        reviewReason: analysis?.reviewReason ?? null,
        suggestionMatchQuality: analysis?.suggestionMatchQuality ?? null
      };
    });

    const trackers = allTrackers
      .filter((tracker: any) => matchesWorkspaceSearch(query.q ?? "", tracker))
      .filter((tracker: any) => applyTrackerFilters(tracker, query))
      .sort((left: any, right: any) => {
        const weightDiff = getTrackerSortWeight(left) - getTrackerSortWeight(right);
        if (weightDiff !== 0) {
          return weightDiff;
        }

        const leftName = String(left.deviceAlias ?? left.deviceName).toLocaleLowerCase();
        const rightName = String(right.deviceAlias ?? right.deviceName).toLocaleLowerCase();
        return leftName.localeCompare(rightName, "ru");
      });

    res.status(200).json({
      tenant,
      connection: {
        status: integration?.status ?? "DISCONNECTED",
        label: integration?.label ?? null,
        configured: hasFullStarLineCredentials(storedCredentials),
        legacyCompatibilityAvailable: !hasFullStarLineCredentials(storedCredentials) && hasFullStarLineCredentials(fallbackCredentials),
        login: integration?.login ?? null,
        appId: integration?.externalAccountId ?? null,
        baseUrl: integration?.baseUrl ?? "https://developer.starline.ru",
        lastCheckedAt: integration?.lastCheckedAt?.toISOString() ?? null,
        lastErrorText: integration?.lastErrorText ?? null
      },
      summary: {
        trackersCount: trackers.length,
        totalTrackersCount: allTrackers.length,
        onlineCount: trackers.filter((item: any) => item.status === "ONLINE").length,
        offlineCount: trackers.filter((item: any) => item.status === "OFFLINE").length,
        boundCount: trackers.filter((item: any) => isBoundState(item.bindingState)).length,
        attentionCount: trackers.filter((item: any) => isTrackerProblem(item)).length,
        autoMatchedCount: trackers.filter((item: any) => item.matchState === "AUTO_MATCHED").length,
        unmatchedCount: trackers.filter((item: any) => item.matchState === "UNMATCHED").length,
        ambiguousCount: trackers.filter((item: any) => item.matchState === "AMBIGUOUS").length,
        manualBindingCount: trackers.filter((item: any) => item.matchState === "MANUAL_BINDING").length,
        reviewNeededCount: trackers.filter((item: any) => item.bindingState === "REVIEW_NEEDED" || item.bindingState === "UNBOUND_AMBIGUOUS").length,
        rebindCandidateCount: trackers.filter((item: any) => item.matchState === "REBIND_CANDIDATE").length,
        unboundCount: trackers.filter((item: any) => !isBoundState(item.bindingState)).length
      },
      filters: {
        q: query.q ?? "",
        quick: query.quick,
        binding: query.binding,
        match: query.match,
        network: query.network,
        sync: query.sync,
        review: query.review
      },
      bikes,
      trackers
    });
  }));

  router.post("/starline/test", asyncHandler(async (req, res) => {
    const payload = connectionSchema.parse(req.body);
    await requireTenantPermission(req, payload.tenantSlug, "gps.manage_settings");
    const result = await testStarLineConnection(toCredentials(payload));

    res.status(200).json({
      ok: true,
      deviceCount: result.deviceCount,
      sampleDevices: result.devices.slice(0, 5).map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        alias: device.alias ?? null
      }))
    });
  }));

  router.post("/starline/connect", asyncHandler(async (req, res) => {
    const payload = connectionSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "gps.manage_settings");
    const credentials = toCredentials(payload);
    const result = await testStarLineConnection(credentials);

    const integration = await createOrUpdateStarLineIntegration({
      tenantId: tenant.id,
      credentials,
      status: "CONNECTED",
      lastErrorText: null
    });

    const syncResult = await syncStarLineTrackersFromDevices({
      tenantId: tenant.id,
      integrationId: integration.id,
      devices: result.devices
    });

    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: "CONNECTED",
        lastCheckedAt: syncResult.syncedAt,
        lastErrorText: null
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "gps_integration",
        entityId: integration.id,
        action: "starline_connected",
        newValueText: JSON.stringify({
          deviceCount: syncResult.deviceCount,
          syncedAt: syncResult.syncedAt
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      connected: true,
      deviceCount: syncResult.deviceCount,
      syncedAt: syncResult.syncedAt.toISOString()
    });
  }));

  router.post("/starline/sync", asyncHandler(async (req, res) => {
    const payload = tenantQuerySchema.parse(req.body ?? req.query);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "gps.manage_settings");
    const integration = await findLatestStarLineIntegration(tenant.id);
    const credentials = await loadStarLineCredentials(tenant.id, { includeLegacyFallback: false });

    if (!integration || !hasFullStarLineCredentials(credentials)) {
      throw new HttpError(422, "Сначала заполните и сохраните настройки StarLine в новой CRM");
    }

    try {
      const syncResult = await syncStarLineTrackers({
        tenantId: tenant.id,
        integrationId: integration.id,
        credentials
      });

      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          status: "CONNECTED",
          lastCheckedAt: syncResult.syncedAt,
          lastErrorText: null
        }
      });

      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "gps_integration",
          entityId: integration.id,
          action: "starline_synced",
          newValueText: JSON.stringify({
            deviceCount: syncResult.deviceCount,
            syncedAt: syncResult.syncedAt
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });

      res.status(200).json({
        tenant,
        synced: true,
        deviceCount: syncResult.deviceCount,
        syncedAt: syncResult.syncedAt.toISOString(),
        summary: {
          autoMatchedCount: syncResult.autoMatchedCount,
          unmatchedCount: syncResult.unmatchedCount,
          ambiguousCount: syncResult.ambiguousCount,
          rebindCandidateCount: syncResult.rebindCandidateCount,
          manualBindingCount: syncResult.manualBindingCount
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось обновить устройства StarLine";

      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          lastCheckedAt: new Date(),
          lastErrorText: message
        }
      });

      throw error;
    }
  }));

  router.patch("/trackers/:trackerId/binding", asyncHandler(async (req, res) => {
    const params = bindingParamsSchema.parse(req.params);
    const payload = bindingSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "gps.manage_binding");

    const tracker = await prisma.gpsTracker.findFirst({
      where: {
        id: params.trackerId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        deviceName: true,
        bikeUnitId: true,
        bikeUnit: {
          select: {
            branchId: true
          }
        }
      }
    });

    if (!tracker) {
      res.status(404).json({
        error: {
          message: `GPS tracker '${params.trackerId}' was not found`
        }
      });
      return;
    }

    if (tracker.bikeUnit?.branchId) {
      assertActorBranchAccess(actor, "gps.manage_binding", tracker.bikeUnit.branchId);
    }

    let bike = null as null | { id: string; title: string; article: string | null; branchId: string | null };

    if (payload.bikeUnitId) {
      bike = await prisma.bikeUnit.findFirst({
        where: {
          id: payload.bikeUnitId,
          tenantId: tenant.id
        },
        select: {
          id: true,
          title: true,
          article: true,
          branchId: true
        }
      });

      if (!bike) {
        throw new HttpError(404, `Bike '${payload.bikeUnitId}' was not found`);
      }

      assertActorBranchAccess(actor, "gps.manage_binding", bike.branchId ?? null);
    }

    await prisma.$transaction(async (tx: any) => {
      if (payload.bikeUnitId) {
        await tx.gpsTracker.updateMany({
          where: {
            tenantId: tenant.id,
            bikeUnitId: payload.bikeUnitId,
            NOT: {
              id: tracker.id
            }
          },
          data: {
            bikeUnitId: null
          }
        });
      }

      await tx.gpsTracker.update({
        where: {
          id: tracker.id
        },
        data: {
          bikeUnitId: payload.bikeUnitId,
          bindingSource: "MANUAL"
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "gps_tracker",
          entityId: tracker.id,
          action: payload.bikeUnitId ? "bound_to_bike" : "unbound_from_bike",
          oldValueText: JSON.stringify({
            bikeUnitId: tracker.bikeUnitId
          }, null, 2),
          newValueText: JSON.stringify({
            bikeUnitId: payload.bikeUnitId
          }, null, 2)
        }
      });
    });

    res.status(200).json({
      tenant,
      trackerId: tracker.id,
      bike
    });
  }));

  return router;
}
