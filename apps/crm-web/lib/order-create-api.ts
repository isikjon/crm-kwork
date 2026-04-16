import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";
import type { BanksListData } from "./banks-api";
import type { ClientsListData } from "./clients-api";
import type { EquipmentCatalogData } from "./equipment-api";
import type { FleetListData } from "./fleet-api";
import type { TariffsWorkspaceData } from "./tariffs-api";

export interface OrderCreateWorkspaceData {
  tenantSlug: string;
  clients: ClientsListData["rows"];
  bikes: FleetListData["rows"];
  banks: BanksListData["rows"];
  tariffGroups: TariffsWorkspaceData["rows"];
  equipmentCatalog: EquipmentCatalogData["rows"];
}

export async function loadOrderCreateWorkspace(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const [clients, bikes, banks, tariffs, equipment] = await Promise.all([
      fetchCrmJsonServer<ClientsListData>(`/clients?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=12`),
      fetchCrmJsonServer<FleetListData>(`/bikes?tenantSlug=${encodeURIComponent(tenantSlug)}&status=AVAILABLE&limit=24`),
      fetchCrmJsonServer<BanksListData>(`/banks?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=20`),
      fetchCrmJsonServer<TariffsWorkspaceData>(`/tariffs?tenantSlug=${encodeURIComponent(tenantSlug)}`),
      fetchCrmJsonServer<EquipmentCatalogData>(`/equipment/catalog?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=100`)
    ]);

    return {
      apiBase,
      data: {
        tenantSlug,
        clients: clients.rows,
        bikes: bikes.rows,
        banks: banks.rows.filter((bank) => bank.isActive),
        tariffGroups: tariffs.rows.filter((group) => group.isActive),
        equipmentCatalog: equipment.rows.filter((item) => item.isActive)
      } satisfies OrderCreateWorkspaceData,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load order create workspace"
    };
  }
}
