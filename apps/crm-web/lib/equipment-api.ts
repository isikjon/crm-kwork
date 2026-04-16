import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";

export type EquipmentCatalogType = "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";

export interface EquipmentCatalogData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  total: number;
  rows: Array<{
    id: string;
    type: EquipmentCatalogType;
    label: string;
    note: string | null;
    sortOrder: number;
    isActive: boolean;
    createdAt: string;
    _count?: {
      dealItems: number;
    };
  }>;
}

export async function loadEquipmentCatalog() {
  const apiBase = getCrmApiBase();

  try {
    const data = await fetchCrmJsonServer<EquipmentCatalogData>("/equipment/catalog?tenantSlug=prokolesa&limit=100");
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load equipment catalog"
    };
  }
}
