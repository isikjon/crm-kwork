import { TransactionDirection, TransactionType, type Prisma } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

export const SYSTEM_FINANCE_ARTICLES = [
  {
    systemKey: "income_rental",
    direction: TransactionDirection.INCOME,
    name: "Приход аренда",
    sortOrder: 10,
    transactionTypes: [TransactionType.RENTAL_PAYMENT_IN, TransactionType.PARTIAL_PAYMENT_IN]
  },
  {
    systemKey: "income_buyout",
    direction: TransactionDirection.INCOME,
    name: "Приход выкуп",
    sortOrder: 20,
    transactionTypes: [TransactionType.BUYOUT_PAYMENT_IN, TransactionType.DOWN_PAYMENT_IN]
  },
  {
    systemKey: "income_deposit",
    direction: TransactionDirection.INCOME,
    name: "Залог",
    sortOrder: 30,
    transactionTypes: [TransactionType.DEPOSIT_IN]
  },
  {
    systemKey: "income_penalty",
    direction: TransactionDirection.INCOME,
    name: "Штраф",
    sortOrder: 40,
    transactionTypes: [TransactionType.PENALTY_PAYMENT_IN]
  },
  {
    systemKey: "income_misc",
    direction: TransactionDirection.INCOME,
    name: "Прочий приход",
    sortOrder: 45,
    transactionTypes: []
  },
  {
    systemKey: "expense_deposit_refund",
    direction: TransactionDirection.EXPENSE,
    name: "Возврат залога",
    sortOrder: 50,
    transactionTypes: [TransactionType.DEPOSIT_REFUND_OUT, TransactionType.REFUND_OUT]
  },
  {
    systemKey: "expense_repair",
    direction: TransactionDirection.EXPENSE,
    name: "Ремонт",
    sortOrder: 60,
    transactionTypes: [TransactionType.REPAIR_EXPENSE, TransactionType.SERVICE_EXPENSE]
  },
  {
    systemKey: "expense_procurement",
    direction: TransactionDirection.EXPENSE,
    name: "Закупка",
    sortOrder: 70,
    transactionTypes: []
  },
  {
    systemKey: "expense_misc",
    direction: TransactionDirection.EXPENSE,
    name: "Прочий расход",
    sortOrder: 80,
    transactionTypes: [TransactionType.MANUAL_ADJUSTMENT, TransactionType.WRITE_OFF]
  },
  {
    systemKey: "expense_admin",
    direction: TransactionDirection.EXPENSE,
    name: "Административные",
    sortOrder: 90,
    transactionTypes: []
  },
  {
    systemKey: "expense_logistics",
    direction: TransactionDirection.EXPENSE,
    name: "Логистика",
    sortOrder: 100,
    transactionTypes: []
  }
] as const;

const ARTICLE_BY_TRANSACTION_TYPE = new Map<TransactionType, string>();

for (const article of SYSTEM_FINANCE_ARTICLES) {
  for (const transactionType of article.transactionTypes) {
    ARTICLE_BY_TRANSACTION_TYPE.set(transactionType, article.systemKey);
  }
}

export function resolveSystemArticleKeyByTransactionType(type: TransactionType) {
  return ARTICLE_BY_TRANSACTION_TYPE.get(type) ?? null;
}

export async function ensureFinanceArticles(tx: TransactionClient, tenantId: string) {
  for (const article of SYSTEM_FINANCE_ARTICLES) {
    await tx.financeArticle.upsert({
      where: {
        tenantId_systemKey: {
          tenantId,
          systemKey: article.systemKey
        }
      },
      create: {
        tenantId,
        direction: article.direction,
        name: article.name,
        systemKey: article.systemKey,
        isSystem: true,
        isActive: true,
        sortOrder: article.sortOrder
      },
      update: {
        direction: article.direction,
        isSystem: true,
        sortOrder: article.sortOrder
      }
    });
  }

  return tx.financeArticle.findMany({
    where: {
      tenantId
    },
    orderBy: [
      { direction: "asc" },
      { sortOrder: "asc" },
      { name: "asc" }
    ],
    select: {
      id: true,
      direction: true,
      name: true,
      systemKey: true,
      isSystem: true,
      isActive: true,
      archivedAt: true,
      sortOrder: true
    }
  });
}

export async function resolveSystemArticleAssignment(
  tx: TransactionClient,
  tenantId: string,
  type: TransactionType
) {
  const systemKey = resolveSystemArticleKeyByTransactionType(type);
  if (!systemKey) {
    return null;
  }

  await ensureFinanceArticles(tx, tenantId);

  const article = await tx.financeArticle.findUnique({
    where: {
      tenantId_systemKey: {
        tenantId,
        systemKey
      }
    },
    select: {
      id: true,
      name: true,
      direction: true
    }
  });

  return article;
}

export async function backfillSystemTransactionArticles(tx: TransactionClient, tenantId: string) {
  await ensureFinanceArticles(tx, tenantId);

  for (const article of SYSTEM_FINANCE_ARTICLES) {
    if (article.transactionTypes.length === 0) {
      continue;
    }

    const persistedArticle = await tx.financeArticle.findUnique({
      where: {
        tenantId_systemKey: {
          tenantId,
          systemKey: article.systemKey
        }
      },
      select: {
        id: true,
        name: true,
        direction: true
      }
    });

    if (!persistedArticle) {
      continue;
    }

    await tx.financialTransaction.updateMany({
      where: {
        tenantId,
        articleId: null,
        type: {
          in: [...article.transactionTypes]
        }
      },
      data: {
        articleId: persistedArticle.id,
        articleNameSnapshot: persistedArticle.name,
        articleDirectionSnapshot: persistedArticle.direction
      }
    });
  }
}
