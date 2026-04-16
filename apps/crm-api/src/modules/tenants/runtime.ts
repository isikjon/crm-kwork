import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";

const DEFAULT_TENANT_SLUG = "prokolesa";
const DEFAULT_TENANT_NAME = "ПРОКОЛЕСА";

export interface TenantRef {
  id: string;
  slug: string;
  name: string;
}

export function normalizeTenantSlug(input: string) {
  return input.trim().toLowerCase();
}

export async function resolveTenantBySlug(tenantSlug: string): Promise<TenantRef> {
  const slug = normalizeTenantSlug(tenantSlug);

  if (slug === DEFAULT_TENANT_SLUG) {
    return prisma.tenant.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        name: DEFAULT_TENANT_NAME
      },
      select: {
        id: true,
        slug: true,
        name: true
      }
    });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true
    }
  });

  if (!tenant) {
    throw new HttpError(404, `Tenant '${tenantSlug}' was not found`);
  }

  return tenant;
}
