import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import {
  getNotificationsWorkspace,
  updateNotificationScenario
} from "./service.js";
import {
  confirmTelegramQrConnectionPassword,
  getTelegramQrConnectionStatus,
  resetTelegramConnection,
  startTelegramQrConnection
} from "./telegram.js";

const optionalBooleanBodySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value;
}, z.boolean().optional());

const workspaceQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64)
});

const scenarioParamsSchema = z.object({
  scenarioId: z.string().trim().min(2).max(128)
});

const updateScenarioSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  isEnabled: optionalBooleanBodySchema,
  templateText: z.string().trim().max(4000).optional()
}).superRefine((value, ctx) => {
  if (value.isEnabled === undefined && value.templateText === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Передайте `isEnabled` или `templateText`."
    });
  }
});

const qrStartSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  apiId: z.string().trim().max(120).optional(),
  apiHash: z.string().trim().max(300).optional()
});

const qrStatusQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  flowId: z.string().trim().min(2).max(200)
});

const qrPasswordSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64),
  flowId: z.string().trim().min(2).max(200),
  password: z.string().min(1).max(400)
});

const resetTelegramSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64)
});

export function createNotificationsRouter() {
  const router = Router();

  router.get("/workspace", asyncHandler(async (req, res) => {
    const query = workspaceQuerySchema.parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "notifications.view");
    res.status(200).json(await getNotificationsWorkspace({
      tenantSlug: query.tenantSlug
    }));
  }));

  router.patch("/scenarios/:scenarioId", asyncHandler(async (req, res) => {
    const params = scenarioParamsSchema.parse(req.params);
    const payload = updateScenarioSchema.parse(req.body);
    await requireTenantPermission(req, payload.tenantSlug, "notifications.edit");
    res.status(200).json(await updateNotificationScenario({
      tenantSlug: payload.tenantSlug,
      scenarioId: params.scenarioId,
      isEnabled: payload.isEnabled,
      templateText: payload.templateText
    }));
  }));

  router.post("/telegram/qr/start", asyncHandler(async (req, res) => {
    const payload = qrStartSchema.parse(req.body);
    await requireTenantPermission(req, payload.tenantSlug, "notifications.edit");
    res.status(200).json(await startTelegramQrConnection({
      tenantSlug: payload.tenantSlug,
      apiId: payload.apiId,
      apiHash: payload.apiHash
    }));
  }));

  router.get("/telegram/qr/status", asyncHandler(async (req, res) => {
    const query = qrStatusQuerySchema.parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "notifications.edit");
    res.status(200).json(await getTelegramQrConnectionStatus({
      tenantSlug: query.tenantSlug,
      flowId: query.flowId
    }));
  }));

  router.post("/telegram/qr/password", asyncHandler(async (req, res) => {
    const payload = qrPasswordSchema.parse(req.body);
    await requireTenantPermission(req, payload.tenantSlug, "notifications.edit");
    res.status(200).json(await confirmTelegramQrConnectionPassword({
      tenantSlug: payload.tenantSlug,
      flowId: payload.flowId,
      password: payload.password
    }));
  }));

  router.post("/telegram/reset", asyncHandler(async (req, res) => {
    const payload = resetTelegramSchema.parse(req.body);
    await requireTenantPermission(req, payload.tenantSlug, "notifications.edit");
    res.status(200).json(await resetTelegramConnection({
      tenantSlug: payload.tenantSlug
    }));
  }));

  return router;
}
