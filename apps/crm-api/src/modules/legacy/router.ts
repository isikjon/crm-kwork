import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { getLegacyOrdersList, getLegacyOverview } from "./legacy-source.js";

const listQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  state: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(12)
});

export function createLegacyRouter() {
  const router = Router();

  router.get("/overview", asyncHandler(async (req, res) => {
    const query = listQuerySchema.pick({ tenantSlug: true }).parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "imports.view");
    res.status(200).json(await getLegacyOverview());
  }));

  router.get("/orders", asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "imports.view");
    res.status(200).json(await getLegacyOrdersList({
      state: query.state,
      limit: query.limit
    }));
  }));

  return router;
}
