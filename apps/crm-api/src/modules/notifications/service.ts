import {
  type BankInstructionType,
  type NotificationScenarioType,
  type Prisma,
  type PrismaClient
} from "@prisma/client";
import { HttpError } from "../../core/http/errors.js";
import { prisma } from "../../db/prisma.js";
import { resolveTenantBySlug } from "../tenants/runtime.js";
import { resolveTelegramConnectionSnapshot } from "./telegram.js";

type TransactionClient = Prisma.TransactionClient;
type NotificationDbClient = TransactionClient | PrismaClient;

type ClientNotificationTarget = {
  id: string;
  fullName: string;
  telegramHandle: string | null;
  primaryPhone: string | null;
};

const LIVE_NOTIFICATION_SCENARIO_TYPES = ["DEAL_CREATED", "PAYMENT_RECEIVED"] as const;

type LiveNotificationScenarioType = (typeof LIVE_NOTIFICATION_SCENARIO_TYPES)[number];

const CORE_NOTIFICATION_SCENARIO_CONFIG: Record<LiveNotificationScenarioType, {
  name: string;
  legacyTemplateText: string;
  defaultTemplateText: string;
}> = {
  DEAL_CREATED: {
    name: "Telegram: инструкции после оформления",
    legacyTemplateText: "После оформления сделки отправляем клиенту QR или реквизиты из выбранного банка.",
    defaultTemplateText: [
      "Заказ {{deal.number}} оформлен.",
      "{{bank.instruction_body}}",
      "{{bank.phone}}",
      "{{bank.comment}}"
    ].join("\n")
  },
  PAYMENT_RECEIVED: {
    name: "Telegram: следующая дата после оплаты",
    legacyTemplateText: "После подтвержденной оплаты отправляем клиенту следующую дату платежа.",
    defaultTemplateText: [
      "Оплата по заказу {{deal.number}} подтверждена.",
      "{{deal.next_payment_date}}",
      "{{deal.next_payment_amount_rub}}"
    ].join("\n")
  }
};

type NotificationScenarioRow = {
  id: string;
  channel: "TELEGRAM";
  type: LiveNotificationScenarioType;
  name: string;
  isEnabled: boolean;
  templateText: string;
  createdAt: Date;
  updatedAt: Date;
};

type QueuedNotificationRow = {
  id: string;
  status: "QUEUED" | "SKIPPED";
};

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(Math.max(0, kopecks) / 100));
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function normalizeNotificationTemplateText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getBankInstructionTypeLabel(value: BankInstructionType) {
  return value === "QR" ? "QR" : "Реквизиты";
}

function isLiveNotificationScenarioType(value: NotificationScenarioType): value is LiveNotificationScenarioType {
  return LIVE_NOTIFICATION_SCENARIO_TYPES.includes(value as LiveNotificationScenarioType);
}

function mapScenarioRow(row: NotificationScenarioRow) {
  return {
    id: row.id,
    channel: row.channel,
    type: row.type,
    name: row.name,
    isEnabled: row.isEnabled,
    templateText: row.templateText,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toNotificationScenarioRow(
  row: {
    id: string;
    name: string;
    channel: string;
    type: NotificationScenarioType;
    isEnabled: boolean;
    templateText: string;
    createdAt: Date;
    updatedAt: Date;
  },
  type: LiveNotificationScenarioType
): NotificationScenarioRow {
  return {
    id: row.id,
    channel: "TELEGRAM",
    type,
    name: row.name,
    isEnabled: row.isEnabled,
    templateText: row.templateText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getCoreScenarioConfig(type: LiveNotificationScenarioType) {
  return CORE_NOTIFICATION_SCENARIO_CONFIG[type];
}

async function ensureTelegramScenario(
  db: NotificationDbClient,
  params: {
    tenantId: string;
    type: LiveNotificationScenarioType;
  }
): Promise<NotificationScenarioRow> {
  const config = getCoreScenarioConfig(params.type);
  const existing = await db.notificationScenario.findFirst({
    where: {
      tenantId: params.tenantId,
      channel: "TELEGRAM",
      type: params.type
    },
    orderBy: {
      createdAt: "asc"
    },
    select: {
      id: true,
      channel: true,
      type: true,
      name: true,
      isEnabled: true,
      templateText: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (!existing) {
    const created = await db.notificationScenario.create({
      data: {
        tenantId: params.tenantId,
        channel: "TELEGRAM",
        type: params.type,
        name: config.name,
        isEnabled: true,
        isImmediate: true,
        templateText: config.defaultTemplateText
      },
      select: {
        id: true,
        channel: true,
        type: true,
        name: true,
        isEnabled: true,
        templateText: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return toNotificationScenarioRow(created, params.type);
  }

  const needsTemplateUpgrade = normalizeNotificationTemplateText(existing.templateText) === ""
    || normalizeNotificationTemplateText(existing.templateText) === normalizeNotificationTemplateText(config.legacyTemplateText);
  const needsNameUpgrade = existing.name.trim() !== config.name;

  if (!needsTemplateUpgrade && !needsNameUpgrade) {
    return toNotificationScenarioRow(existing, params.type);
  }

  const updated = await db.notificationScenario.update({
    where: {
      id: existing.id
    },
    data: {
      ...(needsNameUpgrade ? { name: config.name } : {}),
      ...(needsTemplateUpgrade ? { templateText: config.defaultTemplateText } : {})
    },
    select: {
      id: true,
      channel: true,
      type: true,
      name: true,
      isEnabled: true,
      templateText: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return toNotificationScenarioRow(updated, params.type);
}

export async function ensureCoreNotificationScenarios(db: NotificationDbClient, tenantId: string) {
  const rows = [] as NotificationScenarioRow[];

  for (const type of LIVE_NOTIFICATION_SCENARIO_TYPES) {
    rows.push(await ensureTelegramScenario(db, {
      tenantId,
      type
    }));
  }

  return rows.sort(
    (left, right) => LIVE_NOTIFICATION_SCENARIO_TYPES.indexOf(left.type) - LIVE_NOTIFICATION_SCENARIO_TYPES.indexOf(right.type)
  );
}

async function loadBankInstruction(db: NotificationDbClient, params: {
  tenantId: string;
  bankId: string;
}) {
  return db.bank.findFirst({
    where: {
      id: params.bankId,
      tenantId: params.tenantId,
      isActive: true
    },
    select: {
      id: true,
      name: true,
      phone: true,
      comment: true,
      instructionType: true,
      assets: {
        orderBy: [
          { isPrimary: "desc" },
          { createdAt: "asc" }
        ],
        select: {
          id: true,
          type: true,
          title: true,
          textBody: true,
          filePath: true,
          isPrimary: true
        }
      }
    }
  });
}

function getRecipient(target: ClientNotificationTarget) {
  const telegram = target.telegramHandle?.trim();
  if (telegram) {
    return telegram;
  }

  return target.primaryPhone?.trim() || target.fullName;
}

function pickInstructionAsset(params: {
  instructionType: BankInstructionType;
  assets: Array<{
    type: BankInstructionType;
    title: string;
    textBody: string | null;
    filePath: string | null;
    isPrimary: boolean;
  }>;
}) {
  return params.assets.find((asset) => asset.type === params.instructionType && asset.isPrimary)
    ?? params.assets.find((asset) => asset.type === params.instructionType)
    ?? params.assets.find((asset) => asset.isPrimary)
    ?? params.assets[0]
    ?? null;
}

function buildDealCreatedMessage(params: {
  dealNumber: string;
  bankName: string;
  instructionType: BankInstructionType;
  phone: string | null;
  comment: string | null;
  asset: {
    title: string;
    textBody: string | null;
    filePath: string | null;
  } | null;
}) {
  const lines = [
    `Заказ ${params.dealNumber} оформлен.`,
    params.instructionType === "QR" ? "Отправляем QR для оплаты." : "Отправляем реквизиты для оплаты."
  ];

  if (params.asset?.textBody?.trim()) {
    lines.push(params.asset.textBody.trim());
  } else if (params.asset?.title?.trim()) {
    lines.push(params.asset.title.trim());
  } else if (params.instructionType === "QR") {
    lines.push(`QR банка ${params.bankName}.`);
  } else {
    lines.push(`Реквизиты банка ${params.bankName}.`);
  }

  if (params.phone?.trim()) {
    lines.push(params.phone.trim());
  }

  if (params.comment?.trim()) {
    lines.push(params.comment.trim());
  }

  return lines.join("\n");
}

function buildPaymentConfirmedMessage(params: {
  dealNumber: string;
  nextPaymentAt: Date | null;
  nextPaymentAmountKopecks: number;
}) {
  const nextPaymentDate = formatDate(params.nextPaymentAt);
  if (!nextPaymentDate) {
    return `Оплата по заказу ${params.dealNumber} подтверждена.\nСледующий платеж не требуется.`;
  }

  const lines = [
    `Оплата по заказу ${params.dealNumber} подтверждена.`,
    `Следующая оплата до ${nextPaymentDate}.`
  ];

  if (params.nextPaymentAmountKopecks > 0) {
    lines.push(`Сумма: ${formatMoney(params.nextPaymentAmountKopecks)} руб.`);
  }

  return lines.join("\n");
}

function renderTemplate(
  templateText: string,
  values: Record<string, string>,
  fallbackMessage: string
) {
  const rendered = normalizeNotificationTemplateText(
    templateText.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawToken: string) => values[rawToken.trim()] ?? "")
  );

  if (rendered) {
    return rendered;
  }

  return normalizeNotificationTemplateText(fallbackMessage);
}

function buildDealCreatedTemplateValues(params: {
  dealNumber: string;
  bankName: string;
  instructionType: BankInstructionType;
  phone: string | null;
  comment: string | null;
  instructionBody: string;
}) {
  return {
    "deal.number": params.dealNumber,
    "bank.name": params.bankName,
    "bank.instruction_type": getBankInstructionTypeLabel(params.instructionType),
    "bank.instruction_body": params.instructionBody,
    "bank.phone": params.phone?.trim() ?? "",
    "bank.comment": params.comment?.trim() ?? ""
  };
}

function buildPaymentReceivedTemplateValues(params: {
  dealNumber: string;
  nextPaymentAt: Date | null;
  nextPaymentAmountKopecks: number;
}) {
  const nextPaymentDate = formatDate(params.nextPaymentAt);

  return {
    "deal.number": params.dealNumber,
    "deal.next_payment_date": nextPaymentDate ? `Следующая оплата до ${nextPaymentDate}.` : "Следующий платеж не требуется.",
    "deal.next_payment_amount_rub": params.nextPaymentAmountKopecks > 0
      ? `Сумма: ${formatMoney(params.nextPaymentAmountKopecks)} руб.`
      : ""
  };
}

async function createTelegramNotification(tx: TransactionClient, params: {
  tenantId: string;
  client: ClientNotificationTarget;
  rentalId?: string | null;
  buyoutId?: string | null;
  scenarioId: string;
  status: "QUEUED" | "SKIPPED";
  messageText: string;
  errorMessage?: string | null;
  attachmentFilePath?: string | null;
}) {
  return tx.notification.create({
    data: {
      tenantId: params.tenantId,
      clientId: params.client.id,
      rentalId: params.rentalId ?? null,
      buyoutId: params.buyoutId ?? null,
      scenarioId: params.scenarioId,
      channel: "TELEGRAM",
      status: params.status,
      recipient: getRecipient(params.client),
      messageText: params.messageText,
      attachmentFilePath: params.attachmentFilePath ?? null,
      errorMessage: params.errorMessage ?? null
    },
    select: {
      id: true,
      status: true
    }
  });
}

function resolveNotificationSkipReason(params: {
  scenario: NotificationScenarioRow;
  client: ClientNotificationTarget;
}) {
  if (!params.scenario.isEnabled) {
    return "Сценарий отключен.";
  }

  if (!params.client.telegramHandle?.trim()) {
    return "У клиента не заполнен Telegram.";
  }

  return null;
}

export async function getNotificationsWorkspace(params: {
  tenantSlug: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  const scenarios = await ensureCoreNotificationScenarios(prisma, tenant.id);

  const journalWhere: Prisma.NotificationWhereInput = {
    tenantId: tenant.id,
    channel: "TELEGRAM",
    scenario: {
      is: {
        channel: "TELEGRAM",
        type: {
          in: [...LIVE_NOTIFICATION_SCENARIO_TYPES]
        }
      }
    }
  };

  const [{ connection }, journalTotal, journalRows] = await Promise.all([
    resolveTelegramConnectionSnapshot({
      tenantSlug: params.tenantSlug
    }),
    prisma.notification.count({
      where: journalWhere
    }),
    prisma.notification.findMany({
      where: journalWhere,
      orderBy: {
        createdAt: "desc"
      },
      take: 32,
      select: {
        id: true,
        createdAt: true,
        sentAt: true,
        status: true,
        recipient: true,
        messageText: true,
        errorMessage: true,
        scenario: {
          select: {
            id: true,
            type: true,
            name: true
          }
        },
        client: {
          select: {
            id: true,
            fullName: true
          }
        },
        rental: {
          select: {
            id: true,
            dealNumber: true
          }
        },
        buyout: {
          select: {
            id: true,
            dealNumber: true
          }
        }
      }
    })
  ]);

  return {
    tenant,
    connection,
    scenarios: {
      tenant,
      total: scenarios.length,
      rows: scenarios.map(mapScenarioRow)
    },
    journal: {
      tenant,
      total: journalTotal,
      rows: journalRows.map((row) => {
        const deal = row.rental
          ? {
              kind: "RENTAL" as const,
              id: row.rental.id,
              dealNumber: row.rental.dealNumber
            }
          : row.buyout
            ? {
                kind: "BUYOUT" as const,
                id: row.buyout.id,
                dealNumber: row.buyout.dealNumber
              }
            : null;

        return {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
          status: row.status,
          recipient: row.recipient,
          messageText: row.messageText,
          reason: row.errorMessage,
          scenario: row.scenario && isLiveNotificationScenarioType(row.scenario.type)
            ? {
                id: row.scenario.id,
                type: row.scenario.type,
                name: row.scenario.name
              }
            : null,
          client: row.client
            ? {
                id: row.client.id,
                fullName: row.client.fullName
              }
            : null,
          deal
        };
      })
    }
  };
}

export async function updateNotificationScenario(params: {
  tenantSlug: string;
  scenarioId: string;
  isEnabled?: boolean;
  templateText?: string;
}) {
  const tenant = await resolveTenantBySlug(params.tenantSlug);
  await ensureCoreNotificationScenarios(prisma, tenant.id);

  const existing = await prisma.notificationScenario.findFirst({
    where: {
      id: params.scenarioId,
      tenantId: tenant.id,
      channel: "TELEGRAM",
      type: {
        in: [...LIVE_NOTIFICATION_SCENARIO_TYPES]
      }
    },
    select: {
      id: true,
      channel: true,
      type: true,
      name: true,
      isEnabled: true,
      templateText: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (!existing || !isLiveNotificationScenarioType(existing.type)) {
    throw new HttpError(404, "Сценарий уведомлений не найден.");
  }

  const data: Prisma.NotificationScenarioUpdateInput = {};

  if (typeof params.isEnabled === "boolean") {
    data.isEnabled = params.isEnabled;
  }

  if (typeof params.templateText === "string") {
    const templateText = normalizeNotificationTemplateText(params.templateText);
    data.templateText = templateText || getCoreScenarioConfig(existing.type).defaultTemplateText;
  }

  if (Object.keys(data).length === 0) {
    return {
      tenant,
      scenario: mapScenarioRow(toNotificationScenarioRow(existing, existing.type))
    };
  }

  const updated = await prisma.notificationScenario.update({
    where: {
      id: existing.id
    },
    data,
    select: {
      id: true,
      channel: true,
      type: true,
      name: true,
      isEnabled: true,
      templateText: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return {
    tenant,
    scenario: mapScenarioRow(toNotificationScenarioRow(updated, existing.type))
  };
}

export async function queueDealCreatedTelegramInstruction(tx: TransactionClient, params: {
  tenantId: string;
  client: ClientNotificationTarget;
  rentalId?: string | null;
  buyoutId?: string | null;
  dealNumber: string;
  bankId?: string | null;
}) {
  const bankId = params.bankId?.trim();
  if (!bankId) {
    return null;
  }

  const bank = await loadBankInstruction(tx, {
    tenantId: params.tenantId,
    bankId
  });

  if (!bank) {
    return null;
  }

  const asset = pickInstructionAsset({
    instructionType: bank.instructionType,
    assets: bank.assets
  });

  const scenarios = await ensureCoreNotificationScenarios(tx, params.tenantId);
  const scenario = scenarios.find((item) => item.type === "DEAL_CREATED");

  if (!scenario) {
    return null;
  }

  const instructionBody = asset?.textBody?.trim()
    || asset?.title?.trim()
    || (bank.instructionType === "QR" ? `QR банка ${bank.name}.` : `Реквизиты банка ${bank.name}.`);

  const messageText = renderTemplate(
    scenario.templateText,
    buildDealCreatedTemplateValues({
      dealNumber: params.dealNumber,
      bankName: bank.name,
      instructionType: bank.instructionType,
      phone: bank.phone,
      comment: bank.comment,
      instructionBody
    }),
    buildDealCreatedMessage({
      dealNumber: params.dealNumber,
      bankName: bank.name,
      instructionType: bank.instructionType,
      phone: bank.phone,
      comment: bank.comment,
      asset
    })
  );

  const skipReason = resolveNotificationSkipReason({
    scenario,
    client: params.client
  });

  return createTelegramNotification(tx, {
    tenantId: params.tenantId,
    client: params.client,
    rentalId: params.rentalId ?? null,
    buyoutId: params.buyoutId ?? null,
    scenarioId: scenario.id,
    status: skipReason ? "SKIPPED" : "QUEUED",
    errorMessage: skipReason,
    attachmentFilePath: bank.instructionType === "QR" ? asset?.filePath ?? null : null,
    messageText
  });
}

export async function queueTelegramNextPaymentAfterConfirmation(tx: TransactionClient, params: {
  tenantId: string;
  client: ClientNotificationTarget;
  rentalId?: string | null;
  buyoutId?: string | null;
  dealNumber: string;
  nextPaymentAt: Date | null;
  nextPaymentAmountKopecks: number;
}) {
  const scenarios = await ensureCoreNotificationScenarios(tx, params.tenantId);
  const scenario = scenarios.find((item) => item.type === "PAYMENT_RECEIVED");

  if (!scenario) {
    return null;
  }

  const messageText = renderTemplate(
    scenario.templateText,
    buildPaymentReceivedTemplateValues({
      dealNumber: params.dealNumber,
      nextPaymentAt: params.nextPaymentAt,
      nextPaymentAmountKopecks: params.nextPaymentAmountKopecks
    }),
    buildPaymentConfirmedMessage({
      dealNumber: params.dealNumber,
      nextPaymentAt: params.nextPaymentAt,
      nextPaymentAmountKopecks: params.nextPaymentAmountKopecks
    })
  );

  const skipReason = resolveNotificationSkipReason({
    scenario,
    client: params.client
  });

  return createTelegramNotification(tx, {
    tenantId: params.tenantId,
    client: params.client,
    rentalId: params.rentalId ?? null,
    buyoutId: params.buyoutId ?? null,
    scenarioId: scenario.id,
    status: skipReason ? "SKIPPED" : "QUEUED",
    errorMessage: skipReason,
    attachmentFilePath: null,
    messageText
  });
}
