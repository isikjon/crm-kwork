import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";

export interface TariffsWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  summary: {
    groupsCount: number;
    rentalGroupsCount: number;
    buyoutGroupsCount: number;
    bikesCount: number;
    assignedRentalBikesCount: number;
    unassignedRentalBikesCount: number;
    assignedBuyoutBikesCount: number;
    unassignedBuyoutBikesCount: number;
  };
  rows: Array<{
    id: string;
    kind: "RENTAL" | "BUYOUT";
    code: string;
    name: string;
    description: string | null;
    isActive: boolean;
    assignedBikesCount: number;
    rules: {
      depositTargetKopecks: number;
      autoPenaltyEnabled: boolean;
      autoPenaltyDailyKopecks: number;
      graceDays: number;
    };
    rates: Array<{
      id: string;
      label: string;
      durationDays: number;
      amountKopecks: number;
      bonusDays: number;
    }>;
  }>;
  bikes: Array<{
    id: string;
    title: string;
    internalCode: string;
    status: string;
    article: string | null;
    bikeModel: {
      id: string;
      name: string;
    } | null;
    rentalTariffGroupId: string | null;
    buyoutTariffGroupId: string | null;
    rentalTariffGroup: {
      id: string;
      name: string;
      code: string;
    } | null;
    buyoutTariffGroup: {
      id: string;
      name: string;
      code: string;
    } | null;
  }>;
}

export async function loadTariffsWorkspace() {
  const apiBase = getCrmApiBase();

  try {
    const data = await fetchCrmJsonServer<TariffsWorkspaceData>("/tariffs?tenantSlug=prokolesa");
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load tariffs workspace"
    };
  }
}
