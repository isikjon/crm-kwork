import { getCrmApiBase } from "./crm-api-base";
import { resolveTenantSlugFromCookieHeader } from "./tenant-resolver";

export interface UsersWorkspaceData {
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  permissions: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    rows: Array<{
      category: string;
      permissions: Array<{
        id: string;
        code: string;
        category: string;
        name: string;
        description: string | null;
      }>;
    }>;
  };
  roles: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    rows: Array<{
      id: string;
      name: string;
      description: string | null;
      isSystem: boolean;
      createdAt: string;
      updatedAt: string;
      usersCount: number;
      permissions: Array<{
        id: string;
        branchScoped: boolean;
        permission: {
          code: string;
          category: string;
          name: string;
        };
      }>;
    }>;
  };
  users: {
    tenant: {
      id: string;
      slug: string;
      name: string;
    };
    total: number;
    branchScoped: boolean;
    rows: Array<{
      id: string;
      fullName: string;
      email: string;
      status: string;
      isTenantOwner: boolean;
      isSupportUser: boolean;
      lastLoginAt: string | null;
      branch: {
        id: string;
        name: string;
        code: string;
      } | null;
      roles: Array<{
        id: string;
        name: string;
        isSystem: boolean;
      }>;
    }>;
  };
  branches: Array<{
    id: string;
    name: string;
    code: string;
  }>;
}

async function fetchUsersWorkspaceJson(cookieHeader?: string) {
  const tenantSlug = await resolveTenantSlugFromCookieHeader({ cookieHeader });
  const response = await fetch(`${getCrmApiBase()}/users/workspace?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
    cache: "no-store",
    ...(cookieHeader
      ? {
          headers: {
            cookie: cookieHeader
          }
        }
      : {})
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json() as Promise<UsersWorkspaceData>;
}

export async function loadUsersWorkspace(cookieHeader?: string) {
  const apiBase = getCrmApiBase();

  try {
    const data = await fetchUsersWorkspaceJson(cookieHeader);
    return {
      apiBase,
      data,
      error: null as string | null
    };
  } catch (error) {
    return {
      apiBase,
      data: null,
      error: error instanceof Error ? error.message : "Unable to load users workspace"
    };
  }
}
