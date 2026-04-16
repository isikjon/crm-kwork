import { getCrmApiBase } from "./crm-api-base";
import { fetchCrmJsonServer } from "./crm-api-server";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface DocumentsWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  templates: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    rows: Array<{
      id: string;
      kind: string;
      name: string;
      templateCode: string | null;
      sourceEntityType: string | null;
      filePath: string;
      numberPrefix: string | null;
      numberPadding: number;
      nextNumber: number;
      nextDocumentNumber: string;
      placeholdersGuide: string | null;
      isActive: boolean;
      manifest: {
        foundCodes: number;
        sourceKnownCodes: number;
        unknownCodes: number;
        contextMismatchCodes: number;
        warnings: string[];
      } | null;
      createdAt: string;
      updatedAt: string;
      _count: {
        generations: number;
      };
    }>;
  };
  placeholders: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    rows: Array<{
      sourceEntityType: string;
      placeholders: Array<{
        code: string;
        label: string;
        description: string;
        entity: string;
        sourcePath: string;
        exampleValue: string;
      }>;
    }>;
  };
  registry: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    rows: Array<DocumentRegistryRow>;
  };
}

export type DocumentTemplatesListData = DocumentsWorkspaceData["templates"];
export type DocumentRegistryListData = DocumentsWorkspaceData["registry"];

export interface DocumentRegistryRow {
  id: string;
  title: string;
  documentNumber: string | null;
  status: string;
  createdAt: string;
  createdBy: {
    id: string;
    fullName: string;
  } | null;
  client: {
    id: string;
    fullName: string;
  } | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  sourceLabel: string;
  template: {
    id: string;
    name: string;
    kind: string;
  } | null;
  order: {
    kind: "RENTAL" | "BUYOUT";
    id: string;
    dealNumber: string;
    href: string;
  } | null;
  downloadHref: string;
}

export async function loadDocumentsWorkspace(cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const [templates, placeholders, registry] = await Promise.all([
      fetchCrmJsonServer<DocumentsWorkspaceData["templates"]>(`/documents/templates?tenantSlug=${encodeURIComponent(tenantSlug)}`),
      fetchCrmJsonServer<DocumentsWorkspaceData["placeholders"]>(`/documents/placeholders?tenantSlug=${encodeURIComponent(tenantSlug)}`),
      fetchCrmJsonServer<DocumentsWorkspaceData["registry"]>(`/documents/registry?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=80`)
    ]);

    return {
      apiBase,
      data: {
        tenant: templates.tenant,
        templates,
        placeholders,
        registry
      },
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load documents workspace"
    };
  }
}

export async function loadDocumentTemplatesForSource(sourceEntityType: "RENTAL" | "BUYOUT", cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const data = await fetchCrmJsonServer<DocumentTemplatesListData>(
      `/documents/templates?tenantSlug=${encodeURIComponent(tenantSlug)}&sourceEntityType=${sourceEntityType}`
    );

    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load document templates"
    };
  }
}

export async function loadDocumentRegistry(params?: {
  sourceEntityType?: "CLIENT" | "RENTAL" | "BUYOUT";
  sourceEntityId?: string;
  limit?: number;
}, cookieHeader?: string) {
  const apiBase = getCrmApiBase();
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });

  try {
    const query = new URLSearchParams({
      tenantSlug,
      limit: String(params?.limit ?? 12)
    });

    if (params?.sourceEntityType) {
      query.set("sourceEntityType", params.sourceEntityType);
    }

    if (params?.sourceEntityId) {
      query.set("sourceEntityId", params.sourceEntityId);
    }

    const data = await fetchCrmJsonServer<DocumentRegistryListData>(`/documents/registry?${query.toString()}`);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load document registry"
    };
  }
}
