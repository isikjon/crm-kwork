import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { assertActorBranchAccess } from "../../core/auth/current-actor.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";
import { resolveActorBranchReadScope } from "../../core/auth/read-branch-scope.js";
import {
  createFinanceArticle,
  exportFinancialTransactionsCsv,
  getFinanceWorkspace,
  listFinanceArticles,
  listFinancialTransactions,
  postManualFinanceTransaction,
  reverseFinancialTransaction,
  setFinancialTransactionReconciled,
  updateFinanceArticle
} from "./service.js";

const transactionTypeSchema = z.enum([
  "RENTAL_PAYMENT_IN",
  "BUYOUT_PAYMENT_IN",
  "DOWN_PAYMENT_IN",
  "PARTIAL_PAYMENT_IN",
  "DEPOSIT_IN",
  "DEPOSIT_REFUND_OUT",
  "PENALTY_ACCRUAL",
  "PENALTY_PAYMENT_IN",
  "HOLD",
  "WRITE_OFF",
  "REFUND_OUT",
  "MANUAL_ADJUSTMENT",
  "SERVICE_EXPENSE",
  "REPAIR_EXPENSE"
]);

const transactionContourSchema = z.enum([
  "RENTAL",
  "BUYOUT",
  "PENALTY",
  "DEPOSIT",
  "BUSINESS_EXPENSE"
]);

const optionalBooleanQuerySchema = z.preprocess((value) => {
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

const transactionsQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  q: z.string().trim().optional(),
  type: transactionTypeSchema.optional(),
  contour: transactionContourSchema.optional(),
  status: z.enum(["DRAFT", "POSTED", "CANCELED"]).optional(),
  direction: z.enum(["INCOME", "EXPENSE"]).optional(),
  articleId: z.string().trim().min(2).max(128).optional(),
  bankId: z.string().trim().min(2).max(128).optional(),
  clientId: z.string().trim().min(2).max(128).optional(),
  branchId: z.string().trim().min(2).max(128).optional(),
  dealKind: z.enum(["RENTAL", "BUYOUT"]).optional(),
  paymentMethod: z.enum(["BANK", "CASH"]).optional(),
  dealNumber: z.string().trim().min(1).max(120).optional(),
  amountFrom: z.string().trim().optional(),
  amountTo: z.string().trim().optional(),
  reconciled: optionalBooleanQuerySchema,
  period: z.enum(["TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "PREVIOUS_MONTH"]).optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(48)
});

const articlesQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  includeArchived: z.coerce.boolean().default(true)
});

const createArticleSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  direction: z.enum(["INCOME", "EXPENSE"]),
  name: z.string().trim().min(2).max(120)
});

const articleParamsSchema = z.object({
  articleId: z.string().trim().min(2).max(128)
});

const transactionParamsSchema = z.object({
  transactionId: z.string().trim().min(2).max(128)
});

const updateArticleSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  name: z.string().trim().min(2).max(120).optional(),
  isActive: z.coerce.boolean().optional()
});

const manualTransactionSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  direction: z.enum(["INCOME", "EXPENSE"]),
  articleId: z.string().trim().min(2).max(128),
  amountKopecks: z.coerce.number().int().positive(),
  paymentMethod: z.enum(["BANK", "CASH"]),
  bankId: z.string().trim().min(2).max(128).optional(),
  clientId: z.string().trim().min(2).max(128).optional(),
  branchId: z.string().trim().min(2).max(128),
  happenedAt: z.string().trim().optional(),
  comment: z.string().trim().max(2000).optional()
});

const reverseTransactionSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  reason: z.string().trim().min(2).max(2000),
  happenedAt: z.string().trim().optional()
});

const reconcileTransactionSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  reconciled: z.coerce.boolean(),
  note: z.string().trim().max(2000).optional()
});

export function createFinanceRouter() {
  const router = Router();

  router.get("/workspace", asyncHandler(async (req, res) => {
    const query = transactionsQuerySchema.parse(req.query);
    const { actor } = await requireTenantPermission(req, query.tenantSlug, "finance.view");
    const branchId = resolveActorBranchReadScope(actor, "finance.view", query.branchId);
    res.status(200).json(await getFinanceWorkspace({
      ...query,
      branchId: branchId ?? undefined
    }));
  }));

  router.get("/transactions", asyncHandler(async (req, res) => {
    const query = transactionsQuerySchema.parse(req.query);
    const { actor } = await requireTenantPermission(req, query.tenantSlug, "finance.view");
    const branchId = resolveActorBranchReadScope(actor, "finance.view", query.branchId);
    res.status(200).json(await listFinancialTransactions({
      ...query,
      branchId: branchId ?? undefined
    }));
  }));

  router.get("/export.csv", asyncHandler(async (req, res) => {
    const query = transactionsQuerySchema.parse(req.query);
    const { actor } = await requireTenantPermission(req, query.tenantSlug, ["finance.view", "finance.export"]);
    const branchId = resolveActorBranchReadScope(actor, "finance.export", query.branchId);
    const exported = await exportFinancialTransactionsCsv({
      ...query,
      branchId: branchId ?? undefined
    });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exported.fileName}"`);
    res.status(200).send(exported.content);
  }));

  router.get("/articles", asyncHandler(async (req, res) => {
    const query = articlesQuerySchema.parse(req.query);
    await requireTenantPermission(req, query.tenantSlug, "finance.view");
    res.status(200).json(await listFinanceArticles(query));
  }));

  router.post("/articles", asyncHandler(async (req, res) => {
    const payload = createArticleSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "finance.manage_articles");
    res.status(201).json(await createFinanceArticle({
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.patch("/articles/:articleId", asyncHandler(async (req, res) => {
    const params = articleParamsSchema.parse(req.params);
    const payload = updateArticleSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "finance.manage_articles");
    res.status(200).json(await updateFinanceArticle({
      articleId: params.articleId,
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/manual-transactions", asyncHandler(async (req, res) => {
    const payload = manualTransactionSchema.parse(req.body);
    const permissionCode = payload.direction === "INCOME"
      ? "finance.post_manual_income"
      : "finance.post_manual_expense";
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, permissionCode);
    assertActorBranchAccess(actor, permissionCode, payload.branchId);
    res.status(201).json(await postManualFinanceTransaction({
      ...payload,
      actorUserId: actor.userId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/transactions/:transactionId/reverse", asyncHandler(async (req, res) => {
    const params = transactionParamsSchema.parse(req.params);
    const payload = reverseTransactionSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, [] as string[]);
    res.status(201).json(await reverseFinancialTransaction({
      tenantSlug: payload.tenantSlug,
      transactionId: params.transactionId,
      actor,
      reason: payload.reason,
      happenedAt: payload.happenedAt,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  router.post("/transactions/:transactionId/reconcile", asyncHandler(async (req, res) => {
    const params = transactionParamsSchema.parse(req.params);
    const payload = reconcileTransactionSchema.parse(req.body);
    const { actor } = await requireTenantPermission(req, payload.tenantSlug, "finance.reconcile");
    res.status(200).json(await setFinancialTransactionReconciled({
      tenantSlug: payload.tenantSlug,
      transactionId: params.transactionId,
      actor,
      reconciled: payload.reconciled,
      note: payload.note,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null
    }));
  }));

  return router;
}
