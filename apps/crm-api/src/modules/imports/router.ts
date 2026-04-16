import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { getImplementationProgress } from "../progress.js";
import {
  commitLegacyImport,
  createLegacyDryRunImport,
  getImportDetail,
  listImports,
  replayLegacyImport,
  SUPPORTED_LEGACY_ENTITY_TYPES
} from "./service.js";

const listImportsQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const importParamsSchema = z.object({
  importId: z.string().trim().min(2).max(128)
});

const importDetailQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  rowLimitPerJob: z.coerce.number().int().min(1).max(200).default(40)
});

const replayImportSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  importName: z.string().trim().min(2).max(160).optional(),
  dryRun: z.coerce.boolean().default(false)
});

const legacyDryRunSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  tenantName: z.string().trim().min(2).max(120).default("ПРОКОЛЕСА"),
  importName: z.string().trim().min(2).max(160).optional(),
  duplicatePolicy: z.string().trim().max(120).optional(),
  entityTypes: z.array(z.enum(SUPPORTED_LEGACY_ENTITY_TYPES)).min(1).optional()
});

export function createImportsRouter() {
  const router = Router();

  router.get("/progress", asyncHandler(async (_req, res) => {
    res.status(200).json(getImplementationProgress());
  }));

  router.get("/", asyncHandler(async (req, res) => {
    const query = listImportsQuerySchema.parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "imports.view");
    res.status(200).json(await listImports(query));
  }));

  router.get("/:importId", asyncHandler(async (req, res) => {
    const params = importParamsSchema.parse(req.params);
    const query = importDetailQuerySchema.parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "imports.view");
    res.status(200).json(await getImportDetail({
      importId: params.importId,
      tenantSlug: query.tenantSlug,
      rowLimitPerJob: query.rowLimitPerJob
    }));
  }));

  router.post("/legacy/dry-run", asyncHandler(async (req, res) => {
    const payload = legacyDryRunSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "imports.run");
    const result = await createLegacyDryRunImport({
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/legacy/commit", asyncHandler(async (req, res) => {
    const payload = legacyDryRunSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "imports.run");
    const result = await commitLegacyImport({
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  router.post("/:importId/replay", asyncHandler(async (req, res) => {
    const params = importParamsSchema.parse(req.params);
    const payload = replayImportSchema.parse(req.body ?? {});
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "imports.run");
    const result = await replayLegacyImport({
      importId: params.importId,
      tenantSlug: payload.tenantSlug,
      importName: payload.importName,
      dryRun: payload.dryRun,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    });
    res.status(201).json(result);
  }));

  return router;
}
