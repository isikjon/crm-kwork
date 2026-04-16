import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { listBanks } from "../finance/service.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";

const querySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

const createBankSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(64).optional(),
  comment: z.string().trim().max(2000).optional(),
  instructionType: z.enum(["QR", "REQUISITES"]),
  assetTitle: z.string().trim().max(160).optional(),
  assetTextBody: z.string().trim().max(10_000).optional(),
  assetFileName: z.string().trim().max(200).optional(),
  assetFileBase64: z.string().trim().max(10_000_000).optional()
});

function sanitizeFileName(fileName: string) {
  const cleaned = fileName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "bank-asset";
}

async function persistBankAssetFile(params: {
  tenantSlug: string;
  bankId: string;
  fileName: string;
  fileBase64: string;
}) {
  const match = params.fileBase64.match(/^data:(.+?);base64,(.+)$/);
  const encoded = match?.[2] ?? params.fileBase64;
  const buffer = Buffer.from(encoded, "base64");

  const storageDir = path.join(env.FILE_STORAGE_ROOT, "banks", params.tenantSlug, params.bankId);
  await fs.mkdir(storageDir, { recursive: true });

  const safeFileName = sanitizeFileName(params.fileName);
  const filePath = path.join(storageDir, safeFileName);
  await fs.writeFile(filePath, buffer);

  return filePath;
}

export function createBanksRouter() {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { actor } = await requireTenantPermission(req, query.tenantSlug, "banks.view");
    const branchId = resolveActorBranchReadScope(actor, "banks.view");
    res.status(200).json(await listBanks({
      ...query,
      branchId
    }));
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const payload = createBankSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "banks.manage");

    const result = await prisma.$transaction(async (tx) => {
      const bank = await tx.bank.create({
        data: {
          tenantId: tenant.id,
          name: payload.name,
          phone: payload.phone?.trim() || null,
          comment: payload.comment?.trim() || null,
          instructionType: payload.instructionType
        },
        select: {
          id: true,
          name: true,
          instructionType: true
        }
      });

      const hasAssetPayload = Boolean(
        payload.assetTitle?.trim()
        || payload.assetTextBody?.trim()
        || payload.assetFileBase64?.trim()
      );

      if (hasAssetPayload) {
        const filePath = payload.assetFileBase64?.trim() && payload.assetFileName?.trim()
          ? await persistBankAssetFile({
              tenantSlug: tenant.slug,
              bankId: bank.id,
              fileName: payload.assetFileName.trim(),
              fileBase64: payload.assetFileBase64.trim()
            })
          : null;

        await tx.bankAsset.create({
          data: {
            tenantId: tenant.id,
            bankId: bank.id,
            type: payload.instructionType,
            title: payload.assetTitle?.trim() || (payload.instructionType === "QR" ? "QR" : "Реквизиты"),
            textBody: payload.assetTextBody?.trim() || null,
            filePath,
            isPrimary: true
          }
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "bank",
          entityId: bank.id,
          action: "created",
          newValueText: JSON.stringify({
            name: bank.name,
            instructionType: bank.instructionType
          }, null, 2)
        }
      });

      return bank;
    });

    res.status(201).json({
      tenant,
      bank: result
    });
  }));

  return router;
}
