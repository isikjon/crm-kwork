import { getCrmApiBase } from "./crm-api-base";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface GpsWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  connection: {
    status: "CONNECTED" | "DISCONNECTED" | "ERROR";
    label: string | null;
    configured: boolean;
    legacyCompatibilityAvailable: boolean;
    login: string | null;
    appId: string | null;
    baseUrl: string;
    lastCheckedAt: string | null;
    lastErrorText: string | null;
  };
  summary: {
    trackersCount: number;
    totalTrackersCount: number;
    onlineCount: number;
    offlineCount: number;
    boundCount: number;
    attentionCount: number;
    autoMatchedCount: number;
    unmatchedCount: number;
    ambiguousCount: number;
    manualBindingCount: number;
    reviewNeededCount: number;
    rebindCandidateCount: number;
    unboundCount: number;
  };
  filters: {
    q: string;
    quick: "all" | "problems" | "unbound" | "rebind";
    binding: "all" | "bound" | "unbound" | "suggested";
    match: "all" | "auto_matched" | "unmatched" | "ambiguous" | "manual_binding" | "rebind_candidate";
    network: "all" | "online" | "offline";
    sync: "all" | "needs_sync";
    review: "all" | "review_needed" | "rebind_candidate";
  };
  bikes: Array<{
    id: string;
    title: string;
    article: string | null;
    status: string;
    branch: {
      id: string;
      name: string;
    } | null;
    trackerId: string | null;
  }>;
  trackers: Array<{
    id: string;
    provider: "STARLINE";
    externalDeviceId: string;
    deviceName: string;
    deviceAlias: string | null;
    status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "ERROR";
    activityRaw: string | null;
    lastSeenAt: string | null;
    lastOnlineAt: string | null;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    lastSeenLabel: string | null;
    offlineAgeLabel: string | null;
    syncAgeLabel: string | null;
    syncState: "FRESH" | "WARNING" | "STALE" | "ERROR" | "UNKNOWN";
    bike: {
      id: string;
      title: string;
      article: string | null;
      status: string;
      branch: {
        id: string;
        name: string;
      } | null;
      activeDeal: {
        kind: "RENTAL" | "BUYOUT";
        id: string;
        dealNumber: string;
        status: string;
        clientName: string;
      } | null;
    } | null;
    suggestedBike: {
      id: string;
      title: string;
      article: string | null;
      status: string;
      branch: {
        id: string;
        name: string;
      } | null;
      trackerId: string | null;
    } | null;
    reviewCandidateBike: {
      id: string;
      title: string;
      article: string | null;
      status: string;
      branch: {
        id: string;
        name: string;
      } | null;
      trackerId: string | null;
    } | null;
    hasAmbiguousSuggestion: boolean;
    bindingState: "BOUND_OK" | "REVIEW_NEEDED" | "REBIND_CANDIDATE" | "UNBOUND" | "UNBOUND_SUGGESTED" | "UNBOUND_AMBIGUOUS";
    matchState: "AUTO_MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "REBIND_CANDIDATE" | "MANUAL_BINDING";
    signalState: "ONLINE" | "OFFLINE" | "SYNC_NEEDED" | "SYNC_ERROR" | "UNKNOWN";
    reviewReason: string | null;
    suggestionMatchQuality: "EXACT" | "PARTIAL" | null;
  }>;
}

export type GpsWorkspaceFilters = Partial<{
  q: string | null;
  quick: "all" | "problems" | "unbound" | "rebind" | null;
  binding: "all" | "bound" | "unbound" | "suggested" | null;
  match: "all" | "auto_matched" | "unmatched" | "ambiguous" | "manual_binding" | "rebind_candidate" | null;
  network: "all" | "online" | "offline" | null;
  sync: "all" | "needs_sync" | null;
  review: "all" | "review_needed" | "rebind_candidate" | null;
}>;

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}

export async function loadGpsWorkspace(filters?: GpsWorkspaceFilters, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });
  const query = new URLSearchParams({
    tenantSlug
  });

  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!value || !String(value).trim()) {
      continue;
    }

    query.set(key, String(value).trim());
  }

  try {
    const response = await fetch(`${apiBase}/gps/workspace?${query.toString()}`, {
      cache: "no-store",
      ...(cookieHeader
        ? {
            headers: {
              cookie: cookieHeader
            }
          }
        : {})
    });

    const data = await parseJsonResponse<GpsWorkspaceData>(response);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load GPS workspace"
    };
  }
}
