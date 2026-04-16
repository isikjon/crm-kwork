import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { prisma } from "../../db/prisma.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

const createSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  type: z.enum(["BATTERY", "CHARGER", "HELMET", "CHAIN_LOCK", "OTHER"]).default("OTHER"),
  label: z.string().trim().min(2).max(160),
  note: z.string().trim().max(2000).optional()
});

const paramsSchema = z.object({
  itemId: z.string().trim().min(2).max(128)
});

const deleteQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

type EquipmentCatalogType = "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";

const DEFAULT_CATALOG: Array<{ type: EquipmentCatalogType; label: string; sortOrder: number }> = [
  { type: "BATTERY", label: "АКБ", sortOrder: 10 },
  { type: "CHARGER", label: "Зарядка", sortOrder: 20 },
  { type: "HELMET", label: "Шлем", sortOrder: 30 },
  { type: "CHAIN_LOCK", label: "Цепной замок", sortOrder: 40 }
];

async function ensureDefaultCatalog(tenantId: string) {
  const existingCount = await prisma.equipmentCatalogItem.count({
    where: { tenantId }
  });

  if (existingCount > 0) {
    return;
  }

  await prisma.equipmentCatalogItem.createMany({
    data: DEFAULT_CATALOG.map((item) => ({
      tenantId,
      type: item.type,
      label: item.label,
      sortOrder: item.sortOrder,
      isActive: true
    }))
  });
}

export function createEquipmentRouter() {
  const router = Router();

  router.get("/catalog", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "equipment.view");
    await ensureDefaultCatalog(tenant.id);

    const search = query.q?.trim();
    const rows = await prisma.equipmentCatalogItem.findMany({
      where: {
        tenantId: tenant.id,
        ...(search
          ? {
              OR: [
                { label: { contains: search, mode: "insensitive" } },
                { note: { contains: search, mode: "insensitive" } }
              ]
            }
          : {})
      },
      orderBy: [
        { isActive: "desc" },
        { sortOrder: "asc" },
        { label: "asc" }
      ],
      take: query.limit,
      select: {
        id: true,
        type: true,
        label: true,
        note: true,
        sortOrder: true,
        isActive: true,
        createdAt: true,
        _count: {
          select: {
            dealItems: true
          }
        }
      }
    });

    res.status(200).json({
      tenant,
      total: rows.length,
      rows
    });
  }));

  router.post("/catalog", asyncHandler(async (req, res) => {
    const payload = createSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "equipment.manage");

    const maxSort = await prisma.equipmentCatalogItem.aggregate({
      where: { tenantId: tenant.id },
      _max: { sortOrder: true }
    });

    const item = await prisma.equipmentCatalogItem.create({
      data: {
        tenantId: tenant.id,
        type: payload.type,
        label: payload.label.trim(),
        note: payload.note?.trim() || null,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 10
      },
      select: {
        id: true,
        type: true,
        label: true,
        note: true,
        sortOrder: true,
        isActive: true,
        createdAt: true
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "equipment_catalog_item",
        entityId: item.id,
        action: "created",
        newValueText: JSON.stringify({
          type: item.type,
          label: item.label
        }, null, 2)
      }
    });

    res.status(201).json({
      tenant,
      item
    });
  }));

  router.delete("/catalog/:itemId", asyncHandler(async (req, res) => {
    const params = paramsSchema.parse(req.params);
    const query = deleteQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "equipment.manage");

    const item = await prisma.equipmentCatalogItem.findFirst({
      where: {
        id: params.itemId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        label: true,
        type: true,
        _count: {
          select: {
            dealItems: true
          }
        }
      }
    });

    if (!item) {
      res.status(404).json({
        error: {
          message: `Equipment item '${params.itemId}' was not found`
        }
      });
      return;
    }

    if ((item._count.dealItems ?? 0) > 0) {
      await prisma.$transaction([
        prisma.equipmentCatalogItem.update({
          where: { id: item.id },
          data: {
            isActive: false
          }
        }),
        prisma.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: actor.userId,
            entityType: "equipment_catalog_item",
            entityId: item.id,
            action: "archived",
            oldValueText: JSON.stringify({
              type: item.type,
              label: item.label
            }, null, 2)
          }
        })
      ]);
    } else {
      await prisma.$transaction([
        prisma.equipmentCatalogItem.delete({
          where: { id: item.id }
        }),
        prisma.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: actor.userId,
            entityType: "equipment_catalog_item",
            entityId: item.id,
            action: "deleted",
            oldValueText: JSON.stringify({
              type: item.type,
              label: item.label
            }, null, 2)
          }
        })
      ]);
    }

    res.status(200).json({
      tenant,
      deletedId: item.id,
      archived: (item._count.dealItems ?? 0) > 0
    });
  }));

  return router;
}
