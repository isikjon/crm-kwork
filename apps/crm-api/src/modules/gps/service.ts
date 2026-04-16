import { prisma } from "../../db/prisma.js";
import {
  formatStarLineLastSeen,
  loadStarLineDevicesForTenant,
  type StarLineCredentials,
  type StarLineDeviceSummary
} from "../starline/service.js";
import { isAssignableBikeUnitName } from "../fleet/bike-unit-classifier.js";

type BikeBindingCandidate = {
  id: string;
  title: string;
  article: string | null;
  status: string;
  trackerId?: string | null;
  branch?: {
    id: string;
    name: string;
  } | null;
};

export type GpsBindingState =
  | "BOUND_OK"
  | "REVIEW_NEEDED"
  | "REBIND_CANDIDATE"
  | "UNBOUND"
  | "UNBOUND_SUGGESTED"
  | "UNBOUND_AMBIGUOUS";

export type GpsSignalState =
  | "ONLINE"
  | "OFFLINE"
  | "SYNC_NEEDED"
  | "SYNC_ERROR"
  | "UNKNOWN";

export type GpsTrackerBindingSource = "AUTO_MATCH" | "MANUAL";

export type GpsMatchState =
  | "AUTO_MATCHED"
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "REBIND_CANDIDATE"
  | "MANUAL_BINDING";

type TrackerMatchQuality = "EXACT" | "PARTIAL";

type TrackerBikeMatch = {
  bike: BikeBindingCandidate;
  quality: TrackerMatchQuality;
};

type TrackerBindingAnalysis = {
  bindingState: GpsBindingState;
  suggestedBike: BikeBindingCandidate | null;
  hasAmbiguousSuggestion: boolean;
  reviewReason: string | null;
  suggestionMatchQuality: TrackerMatchQuality | null;
};

type AutoMatchPlannerTracker = {
  id: string;
  deviceName: string;
  deviceAlias?: string | null;
  bikeUnitId?: string | null;
  bindingSource?: GpsTrackerBindingSource | null;
  status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
  lastSyncAt: Date | null;
  lastSyncError?: string | null;
};

export type GpsTrackerAutoMatchAnalysis = {
  trackerId: string;
  bindingState: GpsBindingState;
  matchState: GpsMatchState;
  signalState: GpsSignalState;
  suggestedBike: BikeBindingCandidate | null;
  reviewCandidateBike: BikeBindingCandidate | null;
  hasAmbiguousSuggestion: boolean;
  reviewReason: string | null;
  suggestionMatchQuality: TrackerMatchQuality | null;
  autoBindBikeId: string | null;
};

export type GpsAutoMatchSummary = {
  autoMatchedCount: number;
  unmatchedCount: number;
  ambiguousCount: number;
  rebindCandidateCount: number;
  manualBindingCount: number;
};

function timestampToDate(value: number | undefined) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatOfflineAge(from: Date | null, now = new Date()) {
  if (!from) {
    return null;
  }

  const diffMs = now.getTime() - from.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return null;
  }

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) {
    return diffMinutes <= 1 ? "только что" : `${diffMinutes} мин назад`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} ч назад`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 31) {
    return `${diffDays} дн назад`;
  }

  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} мес назад`;
}

export function formatSyncAge(from: Date | null, now = new Date()) {
  if (!from) {
    return null;
  }

  const diffMs = now.getTime() - from.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return null;
  }

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) {
    return diffMinutes <= 1 ? "только что" : `${diffMinutes} мин назад`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} ч назад`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} дн назад`;
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .trim();
}

function normalizeSearchText(value: string | null | undefined) {
  return normalizeText(value).replace(/[^a-zа-я0-9]+/gi, "");
}

function buildTrackerFieldVariants(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }

  const normalizedWhole = normalizeSearchText(raw);
  const normalizedTokens = raw
    .split(/[^a-zа-я0-9-]+/gi)
    .map((token) => normalizeSearchText(token))
    .filter(Boolean);

  return [...new Set([normalizedWhole, ...normalizedTokens].filter(Boolean))];
}

function getBikeMatchQualityForField(
  trackerField: string | null | undefined,
  bike: BikeBindingCandidate
): TrackerMatchQuality | null {
  const normalizedArticle = normalizeSearchText(bike.article);
  if (!normalizedArticle) {
    return null;
  }

  const normalizedFields = buildTrackerFieldVariants(trackerField);
  if (!normalizedFields.length) {
    return null;
  }

  if (normalizedFields.some((field) => field === normalizedArticle || field.endsWith(normalizedArticle))) {
    return "EXACT";
  }

  if (normalizedFields.some((field) => field.includes(normalizedArticle))) {
    return "PARTIAL";
  }

  return null;
}

function collectTrackerBikeMatches(
  tracker: { deviceName: string; deviceAlias?: string | null },
  bikes: BikeBindingCandidate[]
) {
  function collectForField(value: string | null | undefined) {
    const exact: TrackerBikeMatch[] = [];
    const partial: TrackerBikeMatch[] = [];

    for (const bike of bikes) {
      const quality = getBikeMatchQualityForField(value, bike);
      if (!quality) {
        continue;
      }

      const match = { bike, quality } as const;
      if (quality === "EXACT") {
        exact.push(match);
        continue;
      }

      partial.push(match);
    }

    return {
      exact,
      partial
    };
  }

  const aliasMatches = collectForField(tracker.deviceAlias);
  if (aliasMatches.exact.length > 0) {
    return aliasMatches;
  }

  const nameMatches = collectForField(tracker.deviceName);
  if (nameMatches.exact.length > 0) {
    return nameMatches;
  }

  if (aliasMatches.partial.length > 0) {
    return aliasMatches;
  }

  if (nameMatches.partial.length > 0) {
    return nameMatches;
  }

  const exact: TrackerBikeMatch[] = [];
  const partial: TrackerBikeMatch[] = [];

  return {
    exact,
    partial
  };
}

export function deriveTrackerSignalState(input: {
  status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
  lastSyncAt: Date | null;
  lastSyncError?: string | null;
}) {
  const syncState = getSyncState(input.lastSyncAt, input.lastSyncError ?? null);

  if (input.lastSyncError || syncState === "ERROR" || input.status === "ERROR") {
    return "SYNC_ERROR" as const;
  }

  if (syncState === "STALE" || syncState === "WARNING") {
    return "SYNC_NEEDED" as const;
  }

  if (input.status === "OFFLINE") {
    return "OFFLINE" as const;
  }

  if (input.status === "ONLINE") {
    return "ONLINE" as const;
  }

  return "UNKNOWN" as const;
}

export function analyzeTrackerBindingState(
  tracker: {
    deviceName: string;
    deviceAlias?: string | null;
    bikeUnitId?: string | null;
  },
  bikes: BikeBindingCandidate[]
): TrackerBindingAnalysis {
  const matches = collectTrackerBikeMatches(tracker, bikes);
  const exactMatches = matches.exact.map((match) => match.bike);
  const partialMatches = matches.partial.map((match) => match.bike);
  const currentBikeId = tracker.bikeUnitId ?? null;

  if (currentBikeId) {
    const currentExact = exactMatches.find((bike) => bike.id === currentBikeId) ?? null;
    const otherExact = exactMatches.filter((bike) => bike.id !== currentBikeId);

    if (currentExact && otherExact.length === 0) {
      return {
        bindingState: "BOUND_OK" as const,
        suggestedBike: null,
        hasAmbiguousSuggestion: false,
        reviewReason: null,
        suggestionMatchQuality: "EXACT" as const
      };
    }

    if (!currentExact && otherExact.length === 1) {
      return {
        bindingState: "REBIND_CANDIDATE" as const,
        suggestedBike: otherExact[0],
        hasAmbiguousSuggestion: false,
        reviewReason: "Новое имя трекера надежно указывает на другой велосипед. Текущая привязка сохранена до ручного подтверждения.",
        suggestionMatchQuality: "EXACT" as const
      };
    }

    const hasConflict = otherExact.length > 0;
    const reason = hasConflict
      ? "В названии трекера есть конфликтующие совпадения. Текущая привязка сохранена, нужна ручная проверка."
      : "Новое имя трекера больше не подтверждает текущую привязку. CRM сохраняет binding и помечает его для review.";

    return {
      bindingState: "REVIEW_NEEDED" as const,
      suggestedBike: null,
      hasAmbiguousSuggestion: hasConflict || partialMatches.length > 1,
      reviewReason: reason,
      suggestionMatchQuality: null
    };
  }

  if (exactMatches.length === 1) {
    return {
      bindingState: "UNBOUND_SUGGESTED" as const,
      suggestedBike: exactMatches[0],
      hasAmbiguousSuggestion: false,
      reviewReason: null,
      suggestionMatchQuality: "EXACT" as const
    };
  }

  if (exactMatches.length > 1) {
    return {
      bindingState: "UNBOUND_AMBIGUOUS" as const,
      suggestedBike: null,
      hasAmbiguousSuggestion: true,
      reviewReason: "По имени трекера найдено несколько совпадений по артикулам. Выберите велосипед вручную.",
      suggestionMatchQuality: null
    };
  }

  if (partialMatches.length === 1) {
    return {
      bindingState: "UNBOUND_SUGGESTED" as const,
      suggestedBike: partialMatches[0],
      hasAmbiguousSuggestion: false,
      reviewReason: "Подсказка найдена по неполному совпадению имени. Перед привязкой проверьте велосипед.",
      suggestionMatchQuality: "PARTIAL" as const
    };
  }

  if (partialMatches.length > 1) {
    return {
      bindingState: "UNBOUND_AMBIGUOUS" as const,
      suggestedBike: null,
      hasAmbiguousSuggestion: true,
      reviewReason: "Найдено несколько похожих вариантов. Нужна ручная привязка.",
      suggestionMatchQuality: null
    };
  }

  return {
    bindingState: "UNBOUND" as const,
    suggestedBike: null,
    hasAmbiguousSuggestion: false,
    reviewReason: null,
    suggestionMatchQuality: null
  };
}

export function deriveTrackerMatchState(input: {
  bikeUnitId?: string | null;
  bindingSource?: GpsTrackerBindingSource | null;
  bindingState: GpsBindingState;
}) {
  if (input.bindingState === "REBIND_CANDIDATE") {
    return "REBIND_CANDIDATE" as const;
  }

  if (input.bikeUnitId) {
    return input.bindingSource === "AUTO_MATCH"
      ? "AUTO_MATCHED" as const
      : "MANUAL_BINDING" as const;
  }

  if (input.bindingState === "UNBOUND_AMBIGUOUS") {
    return "AMBIGUOUS" as const;
  }

  return "UNMATCHED" as const;
}

export function buildTrackerAutoMatchAnalyses(
  trackers: AutoMatchPlannerTracker[],
  bikes: BikeBindingCandidate[]
) {
  const base = trackers.map((tracker) => {
    const bindingAnalysis = analyzeTrackerBindingState(
      {
        deviceName: tracker.deviceName,
        deviceAlias: tracker.deviceAlias,
        bikeUnitId: tracker.bikeUnitId
      },
      bikes
    );

    return {
      tracker,
      bindingAnalysis,
      signalState: deriveTrackerSignalState({
        status: tracker.status,
        lastSyncAt: tracker.lastSyncAt,
        lastSyncError: tracker.lastSyncError ?? null
      })
    };
  });

  const exactSuggestionCounts = new Map<string, number>();
  for (const item of base) {
    if (item.tracker.bikeUnitId) {
      continue;
    }

    if (item.bindingAnalysis.bindingState !== "UNBOUND_SUGGESTED") {
      continue;
    }

    if (item.bindingAnalysis.suggestionMatchQuality !== "EXACT" || !item.bindingAnalysis.suggestedBike) {
      continue;
    }

    const bikeId = item.bindingAnalysis.suggestedBike.id;
    exactSuggestionCounts.set(bikeId, (exactSuggestionCounts.get(bikeId) ?? 0) + 1);
  }

  return base.map((item) => {
    const tracker = item.tracker;
    let bindingState = item.bindingAnalysis.bindingState;
    const suggestedBike = item.bindingAnalysis.suggestedBike;
    let hasAmbiguousSuggestion = item.bindingAnalysis.hasAmbiguousSuggestion;
    let reviewReason = item.bindingAnalysis.reviewReason;
    const suggestionMatchQuality = item.bindingAnalysis.suggestionMatchQuality;

    if (
      !tracker.bikeUnitId
      && bindingState === "UNBOUND_SUGGESTED"
      && suggestionMatchQuality === "EXACT"
      && suggestedBike
      && suggestedBike.trackerId
    ) {
      bindingState = "UNBOUND_AMBIGUOUS";
      hasAmbiguousSuggestion = true;
      reviewReason = "Нашли точное совпадение по артикулу, но этот велосипед уже привязан к другому GPS. Нужна ручная проверка.";
    }

    if (
      !tracker.bikeUnitId
      && bindingState === "UNBOUND_SUGGESTED"
      && suggestionMatchQuality === "EXACT"
      && suggestedBike
      && (exactSuggestionCounts.get(suggestedBike.id) ?? 0) > 1
    ) {
      bindingState = "UNBOUND_AMBIGUOUS";
      hasAmbiguousSuggestion = true;
      reviewReason = "Несколько трекеров одновременно указывают на один и тот же велосипед. CRM не делает автопривязку без ручной проверки.";
    }

    const autoBindBikeId = (
      !tracker.bikeUnitId
      && bindingState === "UNBOUND_SUGGESTED"
      && suggestionMatchQuality === "EXACT"
      && suggestedBike
      && !suggestedBike.trackerId
      && (exactSuggestionCounts.get(suggestedBike.id) ?? 0) === 1
    )
      ? suggestedBike.id
      : null;

    return {
      trackerId: tracker.id,
      bindingState,
      matchState: deriveTrackerMatchState({
        bikeUnitId: tracker.bikeUnitId,
        bindingSource: tracker.bindingSource ?? "MANUAL",
        bindingState
      }),
      signalState: item.signalState,
      suggestedBike,
      reviewCandidateBike: bindingState === "REBIND_CANDIDATE" ? suggestedBike : null,
      hasAmbiguousSuggestion,
      reviewReason,
      suggestionMatchQuality,
      autoBindBikeId
    } satisfies GpsTrackerAutoMatchAnalysis;
  });
}

export function summarizeTrackerAutoMatchStates(items: Array<{
  matchState: GpsMatchState;
}>) {
  return {
    autoMatchedCount: items.filter((item) => item.matchState === "AUTO_MATCHED").length,
    unmatchedCount: items.filter((item) => item.matchState === "UNMATCHED").length,
    ambiguousCount: items.filter((item) => item.matchState === "AMBIGUOUS").length,
    rebindCandidateCount: items.filter((item) => item.matchState === "REBIND_CANDIDATE").length,
    manualBindingCount: items.filter((item) => item.matchState === "MANUAL_BINDING").length
  } satisfies GpsAutoMatchSummary;
}

export function getSyncState(lastSyncAt: Date | null, lastSyncError: string | null) {
  if (lastSyncError) {
    return "ERROR" as const;
  }

  if (!lastSyncAt) {
    return "UNKNOWN" as const;
  }

  const ageMs = Date.now() - lastSyncAt.getTime();
  if (ageMs > 24 * 60 * 60_000) {
    return "STALE" as const;
  }

  if (ageMs > 6 * 60 * 60_000) {
    return "WARNING" as const;
  }

  return "FRESH" as const;
}

export function suggestBikeForTracker(
  tracker: { deviceName: string; deviceAlias?: string | null },
  bikes: BikeBindingCandidate[]
) {
  const analysis = analyzeTrackerBindingState(tracker, bikes);
  return {
    bike: analysis.bindingState === "UNBOUND_SUGGESTED" ? analysis.suggestedBike : null,
    ambiguous: analysis.bindingState === "UNBOUND_AMBIGUOUS"
  };
}

export async function upsertStarLineTrackersFromDevices(params: {
  tenantId: string;
  integrationId: string | null;
  devices: StarLineDeviceSummary[];
}) {
  const syncedAt = new Date();
  const existing = await prisma.gpsTracker.findMany({
    where: {
      tenantId: params.tenantId,
      provider: "STARLINE"
    },
    select: {
      id: true,
      externalDeviceId: true,
      lastOnlineAt: true
    }
  });

  const existingByExternalId = new Map<string, { lastOnlineAt: Date | null }>(
    existing.map((row: any) => [row.externalDeviceId, { lastOnlineAt: row.lastOnlineAt ?? null }])
  );
  const receivedIds = new Set<string>();

  await prisma.$transaction(async (tx: any) => {
    for (const device of params.devices) {
      receivedIds.add(device.deviceId);

      const existingRow = existingByExternalId.get(device.deviceId);
      const lastSeenAt = timestampToDate(device.lastSeenTs);
      const lastOnlineAt = device.online
        ? (lastSeenAt ?? syncedAt)
        : (existingRow?.lastOnlineAt ?? lastSeenAt);

      await tx.gpsTracker.upsert({
        where: {
          tenantId_provider_externalDeviceId: {
            tenantId: params.tenantId,
            provider: "STARLINE",
            externalDeviceId: device.deviceId
          }
        },
        create: {
          tenantId: params.tenantId,
          integrationId: params.integrationId,
          provider: "STARLINE",
          externalDeviceId: device.deviceId,
          deviceName: device.name || device.alias || device.deviceId,
          deviceAlias: device.alias ?? null,
          status: device.online ? "ONLINE" : "OFFLINE",
          activityRaw: device.activityRaw || null,
          lastSeenAt,
          lastOnlineAt,
          lastSyncAt: syncedAt,
          lastSyncError: null
        },
        update: {
          integrationId: params.integrationId,
          deviceName: device.name || device.alias || device.deviceId,
          deviceAlias: device.alias ?? null,
          status: device.online ? "ONLINE" : "OFFLINE",
          activityRaw: device.activityRaw || null,
          lastSeenAt,
          lastOnlineAt,
          lastSyncAt: syncedAt,
          lastSyncError: null
        }
      });
    }

    const missingIds = existing
      .filter((row: any) => !receivedIds.has(row.externalDeviceId))
      .map((row: any) => row.id);

    if (missingIds.length > 0) {
      await tx.gpsTracker.updateMany({
        where: {
          id: {
            in: missingIds
          }
        },
        data: {
          integrationId: params.integrationId,
          status: "UNKNOWN",
          lastSyncAt: syncedAt,
          lastSyncError: "Устройство не найдено в последней синхронизации StarLine"
        }
      });
    }
  });

  return {
    syncedAt,
    deviceCount: params.devices.length
  };
}

export async function syncStarLineTrackers(params: {
  tenantId: string;
  integrationId: string | null;
  credentials: StarLineCredentials;
}) {
  const devices = await loadStarLineDevicesForTenant(params.tenantId, params.credentials);
  return syncStarLineTrackersFromDevices({
    tenantId: params.tenantId,
    integrationId: params.integrationId,
    devices
  });
}

export async function syncStarLineTrackersFromDevices(params: {
  tenantId: string;
  integrationId: string | null;
  devices: StarLineDeviceSummary[];
}) {
  const upsertResult = await upsertStarLineTrackersFromDevices({
    tenantId: params.tenantId,
    integrationId: params.integrationId,
    devices: params.devices
  });

  const [bikesRaw, trackersRaw] = await Promise.all([
    prisma.bikeUnit.findMany({
      where: {
        tenantId: params.tenantId
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
    prisma.gpsTracker.findMany({
      where: {
        tenantId: params.tenantId,
        provider: "STARLINE"
      },
      select: {
        id: true,
        deviceName: true,
        deviceAlias: true,
        bikeUnitId: true,
        bindingSource: true,
        status: true,
        lastSyncAt: true,
        lastSyncError: true
      }
    })
  ]);

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

  const plan = buildTrackerAutoMatchAnalyses(
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
  );

  const autoBindActions = plan.filter((item) => item.autoBindBikeId);

  if (autoBindActions.length > 0) {
    await prisma.$transaction(async (tx: any) => {
      for (const item of autoBindActions) {
        await tx.gpsTracker.update({
          where: {
            id: item.trackerId
          },
          data: {
            bikeUnitId: item.autoBindBikeId,
            bindingSource: "AUTO_MATCH"
          }
        });

        await tx.auditLog.create({
          data: {
            tenantId: params.tenantId,
            entityType: "gps_tracker",
            entityId: item.trackerId,
            action: "auto_bound_to_bike",
            newValueText: JSON.stringify({
              bikeUnitId: item.autoBindBikeId,
              bindingSource: "AUTO_MATCH"
            }, null, 2)
          }
        });
      }
    });
  }

  const finalTrackersRaw = await prisma.gpsTracker.findMany({
    where: {
      tenantId: params.tenantId,
      provider: "STARLINE"
    },
    select: {
      id: true,
      deviceName: true,
      deviceAlias: true,
      bikeUnitId: true,
      bindingSource: true,
      status: true,
      lastSyncAt: true,
      lastSyncError: true
    }
  });

  const finalPlan = buildTrackerAutoMatchAnalyses(
    finalTrackersRaw.map((tracker: any) => ({
      id: tracker.id,
      deviceName: tracker.deviceName,
      deviceAlias: tracker.deviceAlias,
      bikeUnitId: tracker.bikeUnitId,
      bindingSource: tracker.bindingSource,
      status: tracker.status,
      lastSyncAt: tracker.lastSyncAt,
      lastSyncError: tracker.lastSyncError
    })),
    bikes.map((bike: any) => ({
      ...bike,
      trackerId: finalTrackersRaw.find((tracker: any) => tracker.bikeUnitId === bike.id)?.id ?? null
    }))
  );

  return {
    ...upsertResult,
    ...summarizeTrackerAutoMatchStates(finalPlan)
  };
}

export function presentTrackerRow<T extends {
  id?: string;
  externalDeviceId?: string;
  deviceName?: string;
  deviceAlias?: string | null;
  status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
  lastSeenAt: Date | null;
  lastOnlineAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncError?: string | null;
}>(row: T) {
  const lastSeenTs = row.lastSeenAt ? Math.floor(row.lastSeenAt.getTime() / 1000) : undefined;
  const offlineFrom = row.status === "ONLINE" ? null : (row.lastSeenAt ?? row.lastOnlineAt);
  const syncState = getSyncState(row.lastSyncAt, row.lastSyncError ?? null);

  return {
    ...row,
    lastSeenLabel: formatStarLineLastSeen(lastSeenTs) || null,
    offlineAgeLabel: formatOfflineAge(offlineFrom),
    syncAgeLabel: formatSyncAge(row.lastSyncAt),
    syncState
  };
}

export function buildGpsSnapshot(tracker: {
  id: string;
  externalDeviceId: string;
  deviceName: string;
  deviceAlias: string | null;
  status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
  lastSeenAt: Date | null;
  lastOnlineAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
} | null) {
  if (!tracker) {
    return null;
  }

  const presented = presentTrackerRow(tracker);

  return {
    id: presented.id,
    externalDeviceId: presented.externalDeviceId,
    deviceName: presented.deviceName,
    deviceAlias: presented.deviceAlias,
    status: presented.status,
    lastSeenAt: presented.lastSeenAt?.toISOString() ?? null,
    lastOnlineAt: presented.lastOnlineAt?.toISOString() ?? null,
    lastSyncAt: presented.lastSyncAt?.toISOString() ?? null,
    lastSeenLabel: presented.lastSeenLabel,
    offlineAgeLabel: presented.offlineAgeLabel,
    syncAgeLabel: presented.syncAgeLabel,
    syncState: presented.syncState,
    lastSyncError: presented.lastSyncError ?? null
  };
}
