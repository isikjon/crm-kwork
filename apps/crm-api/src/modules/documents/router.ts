import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { HttpError } from "../../core/http/errors.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { hydrateClientFromLegacyCounterparty } from "../clients/legacy-counterparty-sync.js";
import {
  analyzeTemplateManifest,
  isPlainTextTemplatePath,
  persistUploadedTemplateFile,
  readPlainTextTemplateContent,
  renderDocumentFromTemplate,
  renderPlainTextTemplatePreview,
  sanitizeFileName,
  writePlainTextTemplateContent
} from "./template-renderer.js";
import { requireTenantPermission } from "../../core/auth/require-tenant-permission.js";

const tenantQuerySchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa")
});

const sourceEntitySchema = z.enum(["CLIENT", "RENTAL", "BUYOUT"]);

const templatesQuerySchema = tenantQuerySchema.extend({
  sourceEntityType: sourceEntitySchema.optional()
});

const placeholdersQuerySchema = tenantQuerySchema.extend({
  sourceEntityType: sourceEntitySchema.optional()
});

const previewQuerySchema = tenantQuerySchema.extend({
  sourceEntityType: sourceEntitySchema,
  sourceEntityId: z.string().trim().min(2).max(128)
});

const documentRegistryQuerySchema = tenantQuerySchema.extend({
  sourceEntityType: sourceEntitySchema.optional(),
  sourceEntityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
}).superRefine((payload, ctx) => {
  if (payload.sourceEntityId && !payload.sourceEntityType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Для sourceEntityId нужно передать sourceEntityType"
    });
  }
});

const templateKindSchema = z.enum([
  "CONTRACT",
  "ISSUE_ACT",
  "RETURN_ACT",
  "BUYOUT_CONTRACT",
  "ADDENDUM",
  "CUSTOM"
]);

const createTemplateSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  kind: templateKindSchema,
  name: z.string().trim().min(2).max(160),
  templateCode: z.string().trim().max(64).optional(),
  sourceEntityType: sourceEntitySchema,
  filePath: z.string().trim().min(2).max(500).optional(),
  fileName: z.string().trim().max(200).optional(),
  fileBase64: z.string().trim().max(20_000_000).optional(),
  numberPrefix: z.string().trim().max(32).optional(),
  numberPadding: z.coerce.number().int().min(2).max(12).default(6),
  nextNumber: z.coerce.number().int().min(1).max(999_999).optional(),
  placeholdersGuide: z.string().trim().max(10_000).optional()
}).superRefine((payload, ctx) => {
  const hasPath = Boolean(payload.filePath?.trim());
  const hasUpload = Boolean(payload.fileName?.trim() && payload.fileBase64?.trim());

  if (!hasPath && !hasUpload) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Нужен filePath или загруженный файл шаблона"
    });
  }
});

const templateParamsSchema = z.object({
  templateId: z.string().trim().min(2).max(128)
});

const updateTemplateSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  name: z.string().trim().min(2).max(160).optional(),
  templateCode: z.string().trim().max(64).nullable().optional(),
  numberPrefix: z.string().trim().max(32).nullable().optional(),
  nextNumber: z.coerce.number().int().min(1).max(999_999).optional(),
  fileName: z.string().trim().max(200).optional(),
  fileBase64: z.string().trim().max(20_000_000).optional(),
  isActive: z.boolean().optional()
}).refine((payload) => (
  payload.name !== undefined
  || payload.templateCode !== undefined
  || payload.numberPrefix !== undefined
  || payload.nextNumber !== undefined
  || (payload.fileName !== undefined && payload.fileBase64 !== undefined)
  || payload.isActive !== undefined
), {
  message: "Нужен хотя бы один параметр для обновления шаблона"
});

const updateTemplateContentSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  content: z.string().max(500_000)
});

const generateDraftSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  sourceEntityId: z.string().trim().min(2).max(128),
  title: z.string().trim().max(160).optional(),
  commit: z.coerce.boolean().default(true)
});

const templatePreviewSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(64).default("prokolesa"),
  sourceEntityId: z.string().trim().min(2).max(128)
});

const documentDownloadQuerySchema = tenantQuerySchema.extend({
  disposition: z.enum(["attachment", "inline"]).default("attachment")
});

const templateFileDownloadQuerySchema = tenantQuerySchema.extend({
  disposition: z.enum(["attachment", "inline"]).default("inline")
});

const documentParamsSchema = z.object({
  documentId: z.string().trim().min(2).max(128)
});

type PlaceholderEntity = "document" | "company" | "branch" | "client" | "deal" | "payment" | "penalty" | "deposit" | "bike" | "bank" | "equipment";

interface PlaceholderDefinition {
  code: string;
  label: string;
  description: string;
  entity: PlaceholderEntity;
  sourcePath: string;
  exampleValue: string;
}

function placeholder(definition: PlaceholderDefinition) {
  return definition;
}

const DOCUMENT_PLACEHOLDERS = [
  placeholder({
    code: "{{document.number}}",
    label: "Номер документа",
    description: "Автоматический номер документа по шаблону.",
    entity: "document",
    sourcePath: "document.number",
    exampleValue: "DOG-000123"
  }),
  placeholder({
    code: "{{document.date}}",
    label: "Дата документа",
    description: "Дата генерации документа.",
    entity: "document",
    sourcePath: "document.date",
    exampleValue: "20.03.2026"
  })
];

const COMPANY_PLACEHOLDERS = [
  placeholder({
    code: "{{company.name}}",
    label: "Компания",
    description: "Название tenant-компании.",
    entity: "company",
    sourcePath: "tenant.name",
    exampleValue: "ПРОКОЛЕСА"
  })
];

const BRANCH_PLACEHOLDERS = [
  placeholder({
    code: "{{branch.name}}",
    label: "Филиал",
    description: "Точка сделки или клиента.",
    entity: "branch",
    sourcePath: "deal.branch.name",
    exampleValue: "Савеловская"
  })
];

const CLIENT_PLACEHOLDERS = [
  placeholder({ code: "{{client.full_name}}", label: "ФИО клиента", description: "Полное имя клиента.", entity: "client", sourcePath: "deal.client.fullName", exampleValue: "Иванов Иван Иванович" }),
  placeholder({ code: "{{client.last_name}}", label: "Фамилия", description: "Фамилия клиента.", entity: "client", sourcePath: "deal.client.lastName", exampleValue: "Иванов" }),
  placeholder({ code: "{{client.first_name}}", label: "Имя", description: "Имя клиента.", entity: "client", sourcePath: "deal.client.firstName", exampleValue: "Иван" }),
  placeholder({ code: "{{client.middle_name}}", label: "Отчество", description: "Отчество клиента.", entity: "client", sourcePath: "deal.client.middleName", exampleValue: "Иванович" }),
  placeholder({ code: "{{client.type}}", label: "Тип клиента", description: "Физическое лицо или юридическое лицо.", entity: "client", sourcePath: "deal.client.clientType", exampleValue: "Физическое лицо" }),
  placeholder({ code: "{{client.inn}}", label: "ИНН", description: "ИНН клиента.", entity: "client", sourcePath: "deal.client.taxId", exampleValue: "7701234567" }),
  placeholder({ code: "{{client.phone}}", label: "Телефон", description: "Основной телефон клиента.", entity: "client", sourcePath: "deal.client.primaryPhone", exampleValue: "+7 999 123-45-67" }),
  placeholder({ code: "{{client.telegram}}", label: "Telegram", description: "Telegram клиента.", entity: "client", sourcePath: "deal.client.telegramHandle", exampleValue: "@ivanov" }),
  placeholder({ code: "{{client.email}}", label: "Email", description: "Email клиента.", entity: "client", sourcePath: "deal.client.email", exampleValue: "ivanov@example.com" }),
  placeholder({ code: "{{client.fax}}", label: "Факс", description: "Факс клиента.", entity: "client", sourcePath: "deal.client.fax", exampleValue: "+7 495 000-00-00" }),
  placeholder({ code: "{{client.max}}", label: "Макс", description: "Идентификатор Max клиента.", entity: "client", sourcePath: "deal.client.maxHandle", exampleValue: "max-ivanov" }),
  placeholder({ code: "{{client.comment}}", label: "Комментарий", description: "Комментарий клиента.", entity: "client", sourcePath: "deal.client.comment", exampleValue: "Постоянный клиент" }),
  placeholder({ code: "{{client.address}}", label: "Адрес", description: "Основной адрес клиента.", entity: "client", sourcePath: "deal.client.address", exampleValue: "Москва, ул. Пушкина, д. 1" }),
  placeholder({ code: "{{client.legal_title}}", label: "Полное имя для договора", description: "Поле legalTitle из карточки клиента.", entity: "client", sourcePath: "deal.client.legalTitle", exampleValue: "Иванов Иван Иванович" }),
  placeholder({ code: "{{client.gender}}", label: "Пол", description: "Пол клиента.", entity: "client", sourcePath: "deal.client.gender", exampleValue: "male" }),
  placeholder({ code: "{{client.birth_date}}", label: "Дата рождения", description: "Дата рождения клиента.", entity: "client", sourcePath: "deal.client.identityData.birthDate", exampleValue: "24.07.2003" }),
  placeholder({ code: "{{client.workplace}}", label: "Место работы", description: "Место работы клиента.", entity: "client", sourcePath: "deal.client.workplace", exampleValue: "Курьер" }),
  placeholder({ code: "{{client.courier_id}}", label: "ID курьера", description: "ID курьера клиента.", entity: "client", sourcePath: "deal.client.courierId", exampleValue: "C-1024" }),
  placeholder({ code: "{{client.passport_series}}", label: "Паспорт серия", description: "Серия паспорта.", entity: "client", sourcePath: "deal.client.identityData.passportSeries", exampleValue: "45 10" }),
  placeholder({ code: "{{client.passport_number}}", label: "Паспорт номер", description: "Номер паспорта.", entity: "client", sourcePath: "deal.client.identityData.passportNumber", exampleValue: "123456" }),
  placeholder({ code: "{{client.passport_issued_by}}", label: "Кем выдан", description: "Кем выдан паспорт.", entity: "client", sourcePath: "deal.client.identityData.issuedBy", exampleValue: "ГУ МВД России по Москве" }),
  placeholder({ code: "{{client.passport_issued_at}}", label: "Дата выдачи", description: "Дата выдачи паспорта.", entity: "client", sourcePath: "deal.client.identityData.issuedAt", exampleValue: "15.03.2026" }),
  placeholder({ code: "{{client.passport_department_code}}", label: "Код подразделения", description: "Код подразделения паспорта.", entity: "client", sourcePath: "deal.client.identityData.departmentCode", exampleValue: "770-001" }),
  placeholder({ code: "{{client.registered_address}}", label: "Адрес регистрации", description: "Короткий адрес регистрации.", entity: "client", sourcePath: "deal.client.identityData.registeredAddress", exampleValue: "г. Москва" }),
  placeholder({ code: "{{client.registered_address_full}}", label: "Адрес регистрации полный", description: "Полный адрес регистрации.", entity: "client", sourcePath: "deal.client.identityData.registeredAddressFull", exampleValue: "г. Москва, ул. Пушкина, д. 1" }),
  placeholder({ code: "{{client.registered_address_comment}}", label: "Комментарий к адресу регистрации", description: "Комментарий к адресу регистрации.", entity: "client", sourcePath: "deal.client.identityData.registeredAddressComment", exampleValue: "Подъезд 2" }),
  placeholder({ code: "{{client.registered_fias_code}}", label: "ФИАС регистрации", description: "Код ФИАС адреса регистрации.", entity: "client", sourcePath: "deal.client.identityData.registeredFiasCode", exampleValue: "12345678-90ab-cdef" }),
  placeholder({ code: "{{client.actual_address}}", label: "Фактический адрес", description: "Короткий фактический адрес.", entity: "client", sourcePath: "deal.client.identityData.actualAddress", exampleValue: "г. Москва" }),
  placeholder({ code: "{{client.actual_address_full}}", label: "Фактический адрес полный", description: "Полный фактический адрес.", entity: "client", sourcePath: "deal.client.identityData.actualAddressFull", exampleValue: "г. Москва, ул. Ленина, д. 10" }),
  placeholder({ code: "{{client.actual_address_comment}}", label: "Комментарий к фактическому адресу", description: "Комментарий к фактическому адресу.", entity: "client", sourcePath: "deal.client.identityData.actualAddressComment", exampleValue: "Квартира 8" }),
  placeholder({ code: "{{client.actual_fias_code}}", label: "ФИАС фактического адреса", description: "Код ФИАС фактического адреса.", entity: "client", sourcePath: "deal.client.identityData.actualFiasCode", exampleValue: "abcdef12-3456-7890" }),
  placeholder({ code: "{{client.relatives_summary}}", label: "Контакты доверия", description: "Сводка по родственникам/контактам доверия.", entity: "client", sourcePath: "deal.client.relatives", exampleValue: "Петр Иванов - +7 999 111-22-33" })
];

const RENTAL_DEAL_PLACEHOLDERS = [
  placeholder({ code: "{{deal.type}}", label: "Тип сделки", description: "Тип сделки для документа.", entity: "deal", sourcePath: "deal.type", exampleValue: "Аренда" }),
  placeholder({ code: "{{deal.number}}", label: "Номер сделки", description: "Номер rental-сделки.", entity: "deal", sourcePath: "deal.dealNumber", exampleValue: "LRY-000123" }),
  placeholder({ code: "{{deal.start_date}}", label: "Дата старта", description: "Дата начала аренды.", entity: "deal", sourcePath: "deal.startsAt", exampleValue: "20.03.2026" }),
  placeholder({ code: "{{deal.next_payment_date}}", label: "Следующая дата оплаты", description: "Следующий due date сделки.", entity: "deal", sourcePath: "deal.nextPaymentAt", exampleValue: "27.03.2026" }),
  placeholder({ code: "{{deal.amount_rub}}", label: "Сумма сделки, руб", description: "Основная сумма сделки для документа.", entity: "deal", sourcePath: "deal.plannedPaymentKopecks", exampleValue: "4 500" }),
  placeholder({ code: "{{deal.tariff_label}}", label: "Тариф", description: "Название тарифа аренды.", entity: "deal", sourcePath: "deal.tariffLabel", exampleValue: "Monster 7 дней" }),
  placeholder({ code: "{{deal.tariff_code}}", label: "Код тарифа", description: "Код тарифа аренды.", entity: "deal", sourcePath: "deal.tariffCode", exampleValue: "MONSTER-7" }),
  placeholder({ code: "{{deal.payment_amount_rub}}", label: "Платеж, руб", description: "Плановый платеж по графику.", entity: "deal", sourcePath: "deal.plannedPaymentKopecks", exampleValue: "4 500" }),
  placeholder({ code: "{{deal.deposit_target_rub}}", label: "Залог, руб", description: "Целевая сумма залога по сделке.", entity: "deal", sourcePath: "deal.depositTargetKopecks", exampleValue: "15 000" }),
  placeholder({ code: "{{deal.grace_days}}", label: "Льготные дни", description: "Льготный период до автоштрафа.", entity: "deal", sourcePath: "deal.graceDays", exampleValue: "2" })
];

const BUYOUT_DEAL_PLACEHOLDERS = [
  placeholder({ code: "{{deal.type}}", label: "Тип сделки", description: "Тип сделки для документа.", entity: "deal", sourcePath: "deal.type", exampleValue: "Выкуп" }),
  placeholder({ code: "{{deal.number}}", label: "Номер сделки", description: "Номер buyout-сделки.", entity: "deal", sourcePath: "deal.dealNumber", exampleValue: "LBY-000321" }),
  placeholder({ code: "{{deal.start_date}}", label: "Дата старта", description: "Дата старта выкупа.", entity: "deal", sourcePath: "deal.startsAt", exampleValue: "20.03.2026" }),
  placeholder({ code: "{{deal.next_payment_date}}", label: "Следующая дата оплаты", description: "Следующий due date выкупа.", entity: "deal", sourcePath: "deal.nextPaymentAt", exampleValue: "20.04.2026" }),
  placeholder({ code: "{{deal.amount_rub}}", label: "Сумма сделки, руб", description: "Основная сумма сделки для документа.", entity: "deal", sourcePath: "deal.totalPriceKopecks", exampleValue: "120 000" }),
  placeholder({ code: "{{deal.cadence}}", label: "Схема оплаты", description: "Недельная или месячная схема.", entity: "deal", sourcePath: "deal.paymentCadence", exampleValue: "Ежемесячно" }),
  placeholder({ code: "{{deal.term_months}}", label: "Срок, мес", description: "Срок выкупа.", entity: "deal", sourcePath: "deal.termMonths", exampleValue: "12" }),
  placeholder({ code: "{{deal.total_price_rub}}", label: "Сумма выкупа, руб", description: "Полная цена выкупа.", entity: "deal", sourcePath: "deal.totalPriceKopecks", exampleValue: "120 000" }),
  placeholder({ code: "{{deal.down_payment_rub}}", label: "Первый взнос, руб", description: "Первоначальный взнос.", entity: "deal", sourcePath: "deal.downPaymentKopecks", exampleValue: "20 000" }),
  placeholder({ code: "{{deal.residual_debt_rub}}", label: "Остаток долга, руб", description: "Остаток долга по выкупу.", entity: "deal", sourcePath: "deal.residualDebtKopecks", exampleValue: "65 000" })
];

const PAYMENT_PLACEHOLDERS = [
  placeholder({
    code: "{{payment.next_date}}",
    label: "Следующая дата платежа",
    description: "Следующий платеж по текущему заказу.",
    entity: "payment",
    sourcePath: "deal.nextPaymentAt",
    exampleValue: "27.03.2026"
  })
];

const DEPOSIT_PLACEHOLDERS = [
  placeholder({
    code: "{{deposit.target_rub}}",
    label: "Залог по договору, руб",
    description: "Сумма залога, которая должна быть собрана по сделке.",
    entity: "deposit",
    sourcePath: "deal.depositTargetKopecks",
    exampleValue: "10 000"
  }),
  placeholder({
    code: "{{deposit.collected_rub}}",
    label: "Принято залога, руб",
    description: "Сколько залога уже принято по сделке.",
    entity: "deposit",
    sourcePath: "deal.depositCollectedKopecks",
    exampleValue: "7 000"
  }),
  placeholder({
    code: "{{deposit.returned_rub}}",
    label: "Возвращено залога, руб",
    description: "Сколько залога уже возвращено клиенту.",
    entity: "deposit",
    sourcePath: "deal.depositReturnedKopecks",
    exampleValue: "3 000"
  })
];

const PENALTY_PLACEHOLDERS = [
  placeholder({
    code: "{{penalties.total_rub}}",
    label: "Штрафы, руб",
    description: "Общая сумма активных штрафов по сделке.",
    entity: "penalty",
    sourcePath: "deal.penalties.amountKopecks",
    exampleValue: "1 500"
  })
];

const BIKE_PLACEHOLDERS = [
  placeholder({ code: "{{bike.article}}", label: "Артикул велосипеда", description: "Артикул единицы техники.", entity: "bike", sourcePath: "deal.bikeUnit.article", exampleValue: "KUGOO-MAX-001" }),
  placeholder({ code: "{{bike.title}}", label: "Название велосипеда", description: "Название единицы техники.", entity: "bike", sourcePath: "deal.bikeUnit.title", exampleValue: "Kugoo Kirin V3 Pro" }),
  placeholder({ code: "{{bike.model_name}}", label: "Модель", description: "Модель велосипеда.", entity: "bike", sourcePath: "deal.bikeUnit.bikeModel.name", exampleValue: "Kugoo Kirin V3 Pro" }),
  placeholder({ code: "{{bike.serial_number}}", label: "Серийный номер / рама", description: "Серийный номер или номер рамы.", entity: "bike", sourcePath: "deal.bikeUnit.serialNumber", exampleValue: "SN-000045" })
];

const BANK_PLACEHOLDERS = [
  placeholder({ code: "{{bank.name}}", label: "Банк", description: "Выбранный банк сделки.", entity: "bank", sourcePath: "deal.bank.name", exampleValue: "Сбер QR" }),
  placeholder({ code: "{{bank.phone}}", label: "Телефон банка", description: "Контактный телефон банка из карточки CRM.", entity: "bank", sourcePath: "deal.bank.phone", exampleValue: "+7 495 000-00-00" }),
  placeholder({ code: "{{bank.comment}}", label: "Комментарий по банку", description: "Комментарий банка из CRM.", entity: "bank", sourcePath: "deal.bank.comment", exampleValue: "Оплата по реквизитам доступна в рабочие часы" }),
  placeholder({ code: "{{bank.instruction_type}}", label: "Тип инструкции", description: "Какой сценарий оплаты выбран у банка: QR или реквизиты.", entity: "bank", sourcePath: "deal.bank.instructionType", exampleValue: "Реквизиты" }),
  placeholder({ code: "{{bank.requisites_title}}", label: "Заголовок реквизитов", description: "Название primary REQUISITES asset выбранного банка.", entity: "bank", sourcePath: "deal.bank.assets[primary type=REQUISITES].title", exampleValue: "Реквизиты для оплаты" }),
  placeholder({ code: "{{bank.requisites_text}}", label: "Текст реквизитов", description: "Текст primary REQUISITES asset выбранного банка.", entity: "bank", sourcePath: "deal.bank.assets[primary type=REQUISITES].textBody", exampleValue: "ООО ПРОКОЛЕСА, р/с ... " })
];

const EQUIPMENT_PLACEHOLDERS = [
  placeholder({ code: "{{equipment.summary}}", label: "Комплект", description: "Сводка по выданному комплекту.", entity: "equipment", sourcePath: "deal.equipmentItems", exampleValue: "Держатель телефона, Замок" }),
  placeholder({ code: "{{deal.equipment_summary}}", label: "Комплект", description: "Совместимый legacy-код для сводки по комплекту.", entity: "equipment", sourcePath: "deal.equipmentItems", exampleValue: "Держатель телефона, Замок" })
];

const PLACEHOLDER_CATALOG = {
  CLIENT: [
    ...DOCUMENT_PLACEHOLDERS,
    ...COMPANY_PLACEHOLDERS,
    ...BRANCH_PLACEHOLDERS,
    ...CLIENT_PLACEHOLDERS
  ],
  RENTAL: [
    ...DOCUMENT_PLACEHOLDERS,
    ...COMPANY_PLACEHOLDERS,
    ...BRANCH_PLACEHOLDERS,
    ...RENTAL_DEAL_PLACEHOLDERS,
    ...PAYMENT_PLACEHOLDERS,
    ...PENALTY_PLACEHOLDERS,
    ...DEPOSIT_PLACEHOLDERS,
    ...CLIENT_PLACEHOLDERS,
    ...BIKE_PLACEHOLDERS,
    ...BANK_PLACEHOLDERS,
    ...EQUIPMENT_PLACEHOLDERS
  ],
  BUYOUT: [
    ...DOCUMENT_PLACEHOLDERS,
    ...COMPANY_PLACEHOLDERS,
    ...BRANCH_PLACEHOLDERS,
    ...BUYOUT_DEAL_PLACEHOLDERS,
    ...PAYMENT_PLACEHOLDERS,
    ...PENALTY_PLACEHOLDERS,
    ...DEPOSIT_PLACEHOLDERS,
    ...CLIENT_PLACEHOLDERS,
    ...BIKE_PLACEHOLDERS,
    ...BANK_PLACEHOLDERS,
    ...EQUIPMENT_PLACEHOLDERS
  ]
} as const;

type SourceEntityType = keyof typeof PLACEHOLDER_CATALOG;
type PlaceholderOrigin = "CRM" | "LEGACY" | "NONE";
type PlaceholderStatus = "FILLED" | "EMPTY" | "MISSING" | "UNKNOWN";

const PLACEHOLDER_DEFINITIONS_BY_CODE = new Map<string, PlaceholderDefinition>(
  Object.values(PLACEHOLDER_CATALOG).flat().map((entry) => [entry.code, entry])
);

function formatMoney(kopecks: number | null | undefined) {
  return new Intl.NumberFormat("ru-RU").format(Math.round((kopecks ?? 0) / 100));
}

function formatClientType(value: string | null | undefined) {
  if (value === "LEGAL_ENTITY") {
    return "Юридическое лицо";
  }

  if (value === "INDIVIDUAL") {
    return "Физическое лицо";
  }

  return "";
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function formatDocumentNumber(params: {
  templateCode: string | null;
  kind: string;
  numberPrefix: string | null;
  nextNumber: number;
  numberPadding: number;
}) {
  const prefix = params.numberPrefix?.trim() || params.templateCode?.trim() || params.kind;
  return `${prefix}-${String(Math.max(1, params.nextNumber)).padStart(Math.max(2, params.numberPadding), "0")}`;
}

function buildEquipmentSummary(items: Array<{
  label: string;
  quantity: number;
  comment?: string | null;
}>) {
  if (items.length === 0) {
    return "";
  }

  return items
    .map((item) => {
      const quantityPart = item.quantity > 1 ? ` ×${item.quantity}` : "";
      const commentPart = item.comment?.trim() ? ` (${item.comment.trim()})` : "";
      return `${item.label}${quantityPart}${commentPart}`;
    })
    .join(", ");
}

function buildBankValues(bank: {
  name?: string | null;
  phone?: string | null;
  comment?: string | null;
  instructionType?: string | null;
  assets?: Array<{
    title?: string | null;
    textBody?: string | null;
  }>;
} | null | undefined): DocumentValueMap {
  const requisitesAsset = bank?.assets?.[0] ?? null;

  return {
    "{{bank.name}}": bank?.name ?? "",
    "{{bank.phone}}": bank?.phone ?? "",
    "{{bank.comment}}": bank?.comment ?? "",
    "{{bank.instruction_type}}": bank?.instructionType ?? "",
    "{{bank.requisites_title}}": requisitesAsset?.title ?? "",
    "{{bank.requisites_text}}": requisitesAsset?.textBody ?? ""
  };
}

function buildGeneratedFileName(documentNumber: string, templatePath: string) {
  const extension = path.extname(templatePath) || ".txt";
  return `${sanitizeFileName(documentNumber)}${extension}`;
}

function buildDocumentRegistryFilter(params: {
  sourceEntityType?: SourceEntityType;
  sourceEntityId?: string;
}) {
  if (!params.sourceEntityType) {
    return {};
  }

  if (params.sourceEntityType === "CLIENT") {
    return params.sourceEntityId
      ? { clientId: params.sourceEntityId }
      : { clientId: { not: null } };
  }

  if (params.sourceEntityType === "RENTAL") {
    return params.sourceEntityId
      ? { rentalId: params.sourceEntityId }
      : { rentalId: { not: null } };
  }

  return params.sourceEntityId
    ? { buyoutId: params.sourceEntityId }
    : { buyoutId: { not: null } };
}

function resolveDocumentSourceLabel(params: {
  clientName: string | null;
  rentalNumber: string | null;
  buyoutNumber: string | null;
}) {
  return params.rentalNumber ?? params.buyoutNumber ?? params.clientName ?? "Без источника";
}

type DocumentValueMap = Record<string, string>;

function buildClientValues(client: {
  fullName: string;
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  clientType?: string | null;
  taxId?: string | null;
  primaryPhone?: string | null;
  telegramHandle?: string | null;
  email?: string | null;
  fax?: string | null;
  maxHandle?: string | null;
  courierId?: string | null;
  address?: string | null;
  legalTitle?: string | null;
  gender?: string | null;
  workplace?: string | null;
  comment?: string | null;
  relatives?: Array<{
    fullName?: string | null;
    phone?: string | null;
    comment?: string | null;
  }>;
  identityData?: {
    passportSeries?: string | null;
    passportNumber?: string | null;
    issuedBy?: string | null;
    issuedAt?: Date | string | null;
    departmentCode?: string | null;
    birthDate?: Date | string | null;
    registeredAddress?: string | null;
    registeredAddressFull?: string | null;
    registeredAddressComment?: string | null;
    registeredFiasCode?: string | null;
    actualAddress?: string | null;
    actualAddressFull?: string | null;
    actualAddressComment?: string | null;
    actualFiasCode?: string | null;
  } | null;
}): DocumentValueMap {
  const relativesSummary = (client.relatives ?? [])
    .map((relative) => [relative.fullName, relative.phone, relative.comment].filter(Boolean).join(" - "))
    .filter(Boolean)
    .join("\n");

  return {
    "{{client.full_name}}": client.fullName ?? "",
    "{{client.last_name}}": client.lastName ?? "",
    "{{client.first_name}}": client.firstName ?? "",
    "{{client.middle_name}}": client.middleName ?? "",
    "{{client.type}}": formatClientType(client.clientType),
    "{{client.inn}}": client.taxId ?? "",
    "{{client.phone}}": client.primaryPhone ?? "",
    "{{client.telegram}}": client.telegramHandle ?? "",
    "{{client.email}}": client.email ?? "",
    "{{client.fax}}": client.fax ?? "",
    "{{client.max}}": client.maxHandle ?? "",
    "{{client.comment}}": client.comment ?? "",
    "{{client.address}}": client.address ?? "",
    "{{client.legal_title}}": client.legalTitle ?? "",
    "{{client.gender}}": client.gender ?? "",
    "{{client.birth_date}}": formatDate(client.identityData?.birthDate),
    "{{client.workplace}}": client.workplace ?? "",
    "{{client.courier_id}}": client.courierId ?? "",
    "{{client.passport_series}}": client.identityData?.passportSeries ?? "",
    "{{client.passport_number}}": client.identityData?.passportNumber ?? "",
    "{{client.passport_issued_by}}": client.identityData?.issuedBy ?? "",
    "{{client.passport_issued_at}}": formatDate(client.identityData?.issuedAt),
    "{{client.passport_department_code}}": client.identityData?.departmentCode ?? "",
    "{{client.registered_address}}": client.identityData?.registeredAddress ?? "",
    "{{client.registered_address_full}}": client.identityData?.registeredAddressFull ?? "",
    "{{client.registered_address_comment}}": client.identityData?.registeredAddressComment ?? "",
    "{{client.registered_fias_code}}": client.identityData?.registeredFiasCode ?? "",
    "{{client.actual_address}}": client.identityData?.actualAddress ?? "",
    "{{client.actual_address_full}}": client.identityData?.actualAddressFull ?? "",
    "{{client.actual_address_comment}}": client.identityData?.actualAddressComment ?? "",
    "{{client.actual_fias_code}}": client.identityData?.actualFiasCode ?? "",
    "{{client.relatives_summary}}": relativesSummary
  };
}

async function loadClientDocumentProfile(tenantId: string, clientId: string) {
  return prisma.client.findFirst({
    where: {
      id: clientId,
      tenantId
    },
    select: {
      id: true,
      legacyReference: true,
      fullName: true,
      lastName: true,
      firstName: true,
      middleName: true,
      clientType: true,
      taxId: true,
      primaryPhone: true,
      telegramHandle: true,
      email: true,
      fax: true,
      maxHandle: true,
      courierId: true,
      address: true,
      legalTitle: true,
      gender: true,
      workplace: true,
      comment: true,
      relatives: {
        orderBy: [{ createdAt: "asc" }],
        select: {
          fullName: true,
          phone: true,
          comment: true
        }
      },
      branch: {
        select: {
          name: true
        }
      },
      identityData: {
        select: {
          passportSeries: true,
          passportNumber: true,
          issuedBy: true,
          issuedAt: true,
          departmentCode: true,
          birthDate: true,
          registeredAddress: true,
          registeredAddressFull: true,
          registeredAddressComment: true,
          registeredFiasCode: true,
          actualAddress: true,
          actualAddressFull: true,
          actualAddressComment: true,
          actualFiasCode: true
        }
      }
    }
  });
}

function buildPlaceholderOriginMap(params: {
  values: DocumentValueMap;
  codes: string[];
  legacyFilledCodes?: Set<string>;
}) {
  const legacyFilledCodes = params.legacyFilledCodes ?? new Set<string>();
  return Object.fromEntries(
    params.codes.map((code) => {
      const value = params.values[code] ?? "";
      const origin: PlaceholderOrigin = !value
        ? "NONE"
        : legacyFilledCodes.has(code)
          ? "LEGACY"
          : "CRM";
      return [code, origin];
    })
  ) as Record<string, PlaceholderOrigin>;
}

async function ensureClientProfileForDocuments(tenantId: string, clientId: string) {
  const beforeClient = await loadClientDocumentProfile(tenantId, clientId);
  if (!beforeClient) {
    throw new HttpError(404, `Client '${clientId}' was not found`);
  }

  let hydrationStatus = {
    status: "NOT_RUN",
    message: "Legacy hydration не запускался.",
    legacyFilledCodes: new Set<string>()
  };

  try {
    const hydrationResult = await hydrateClientFromLegacyCounterparty({
      tenantId,
      clientId
    });

    hydrationStatus = hydrationResult.updated
      ? {
          status: "UPDATED",
          message: "Часть клиентских данных была добрана из legacy перед генерацией.",
          legacyFilledCodes: new Set<string>()
        }
      : hydrationResult.reason === "already_hydrated"
        ? {
            status: "ALREADY_HYDRATED",
            message: "Legacy hydration не внес новых значений: клиент уже был достаточно заполнен.",
            legacyFilledCodes: new Set<string>()
          }
        : hydrationResult.reason === "no_legacy_reference"
          ? {
              status: "SKIPPED_NO_REFERENCE",
              message: "У клиента нет stable legacyReference, поэтому legacy hydration пропущен.",
              legacyFilledCodes: new Set<string>()
            }
          : hydrationResult.reason === "no_connection"
            ? {
                status: "SKIPPED_NO_CONNECTION",
                message: "Нет подключения к legacy MoySklad, поэтому legacy hydration пропущен.",
                legacyFilledCodes: new Set<string>()
              }
            : {
                status: "FAILED",
                message: "Legacy hydration завершился с ошибкой.",
                legacyFilledCodes: new Set<string>()
              };
  } catch (error) {
    hydrationStatus = {
      status: "FAILED",
      message: error instanceof Error ? error.message : "Ошибка legacy hydration.",
      legacyFilledCodes: new Set<string>()
    };
  }

  const client = await loadClientDocumentProfile(tenantId, clientId);
  if (!client) {
    throw new HttpError(404, `Client '${clientId}' was not found`);
  }

  const beforeValues = buildClientValues(beforeClient);
  const afterValues = buildClientValues(client);
  const legacyFilledCodes = new Set<string>(
    Object.keys(afterValues).filter((code) => !(beforeValues[code] ?? "").trim() && Boolean((afterValues[code] ?? "").trim()))
  );

  return {
    client,
    hydrationStatus: {
      ...hydrationStatus,
      legacyFilledCodes
    }
  };
}

async function resolvePreview(params: {
  tenantId: string;
  tenantName: string;
  sourceEntityType: SourceEntityType;
  sourceEntityId: string;
  documentNumber: string;
}) {
  const documentDate = formatDate(new Date());

  if (params.sourceEntityType === "CLIENT") {
    const { client, hydrationStatus } = await ensureClientProfileForDocuments(params.tenantId, params.sourceEntityId);
    const values: DocumentValueMap = {
      "{{document.number}}": params.documentNumber,
      "{{document.date}}": documentDate,
      "{{company.name}}": params.tenantName,
      "{{branch.name}}": client.branch?.name ?? "",
      ...buildClientValues(client)
    };

    return {
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: client.id,
      sourceLabel: client.fullName,
      associations: {
        clientId: client.id,
        rentalId: null,
        buyoutId: null,
        bikeUnitId: null
      },
      values,
      origins: buildPlaceholderOriginMap({
        values,
        codes: PLACEHOLDER_CATALOG.CLIENT.map((item) => item.code),
        legacyFilledCodes: hydrationStatus.legacyFilledCodes
      }),
      hydration: {
        status: hydrationStatus.status,
        message: hydrationStatus.message,
        legacyFilledCodes: [...hydrationStatus.legacyFilledCodes].sort((left, right) => left.localeCompare(right, "ru"))
      }
    };
  }

  if (params.sourceEntityType === "RENTAL") {
    const rental = await prisma.rental.findFirst({
      where: {
        id: params.sourceEntityId,
        tenantId: params.tenantId
      },
      select: {
        id: true,
        dealNumber: true,
        tariffCode: true,
        tariffLabel: true,
        startsAt: true,
        nextPaymentAt: true,
        plannedPaymentKopecks: true,
        depositTargetKopecks: true,
        depositCollectedKopecks: true,
        depositReturnedKopecks: true,
        graceDays: true,
        penalties: {
          where: {
            status: "ACTIVE"
          },
          select: {
            amountKopecks: true
          }
        },
        branch: {
          select: {
            name: true
          }
        },
        bank: {
          select: {
            name: true,
            phone: true,
            comment: true,
            instructionType: true,
            assets: {
              where: {
                type: "REQUISITES"
              },
              orderBy: [
                { isPrimary: "desc" },
                { createdAt: "asc" }
              ],
              take: 1,
              select: {
                title: true,
                textBody: true
              }
            }
          }
        },
        client: {
          select: {
            id: true
          }
        },
        bikeUnit: {
          select: {
            id: true,
            article: true,
            title: true,
            serialNumber: true,
            bikeModel: {
              select: {
                name: true
              }
            }
          }
        },
        equipmentItems: {
          orderBy: [
            { createdAt: "asc" },
            { label: "asc" }
          ],
          select: {
            label: true,
            quantity: true,
            comment: true
          }
        }
      }
    });

    if (!rental) {
      throw new HttpError(404, `Rental '${params.sourceEntityId}' was not found`);
    }

    const { client, hydrationStatus } = await ensureClientProfileForDocuments(params.tenantId, rental.client.id);
    const equipmentSummary = buildEquipmentSummary(rental.equipmentItems);
    const penaltyTotalKopecks = rental.penalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
    const values: DocumentValueMap = {
      "{{document.number}}": params.documentNumber,
      "{{document.date}}": documentDate,
      "{{company.name}}": params.tenantName,
      "{{branch.name}}": rental.branch?.name ?? "",
      "{{deal.type}}": "Аренда",
      "{{deal.number}}": rental.dealNumber,
      "{{deal.start_date}}": formatDate(rental.startsAt),
      "{{deal.next_payment_date}}": formatDate(rental.nextPaymentAt),
      "{{payment.next_date}}": formatDate(rental.nextPaymentAt),
      "{{deal.amount_rub}}": formatMoney(rental.plannedPaymentKopecks),
      "{{deal.tariff_label}}": rental.tariffLabel,
      "{{deal.tariff_code}}": rental.tariffCode,
      "{{deal.payment_amount_rub}}": formatMoney(rental.plannedPaymentKopecks),
      "{{deal.deposit_target_rub}}": formatMoney(rental.depositTargetKopecks),
      "{{deposit.target_rub}}": formatMoney(rental.depositTargetKopecks),
      "{{deposit.collected_rub}}": formatMoney(rental.depositCollectedKopecks),
      "{{deposit.returned_rub}}": formatMoney(rental.depositReturnedKopecks),
      "{{penalties.total_rub}}": formatMoney(penaltyTotalKopecks),
      "{{deal.grace_days}}": String(rental.graceDays),
      "{{equipment.summary}}": equipmentSummary,
      "{{deal.equipment_summary}}": equipmentSummary,
      ...buildClientValues(client),
      "{{bike.article}}": rental.bikeUnit.article ?? "",
      "{{bike.title}}": rental.bikeUnit.title,
      "{{bike.model_name}}": rental.bikeUnit.bikeModel?.name ?? "",
      "{{bike.serial_number}}": rental.bikeUnit.serialNumber ?? "",
      ...buildBankValues(rental.bank)
    };

    return {
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: rental.id,
      sourceLabel: rental.dealNumber,
      associations: {
        clientId: client.id,
        rentalId: rental.id,
        buyoutId: null,
        bikeUnitId: rental.bikeUnit.id
      },
      values,
      origins: buildPlaceholderOriginMap({
        values,
        codes: PLACEHOLDER_CATALOG.RENTAL.map((item) => item.code),
        legacyFilledCodes: hydrationStatus.legacyFilledCodes
      }),
      hydration: {
        status: hydrationStatus.status,
        message: hydrationStatus.message,
        legacyFilledCodes: [...hydrationStatus.legacyFilledCodes].sort((left, right) => left.localeCompare(right, "ru"))
      }
    };
  }

  const buyout = await prisma.buyout.findFirst({
    where: {
      id: params.sourceEntityId,
      tenantId: params.tenantId
    },
    select: {
      id: true,
      dealNumber: true,
      startsAt: true,
      nextPaymentAt: true,
      paymentCadence: true,
      termMonths: true,
      totalPriceKopecks: true,
      downPaymentKopecks: true,
      residualDebtKopecks: true,
      depositTargetKopecks: true,
      depositCollectedKopecks: true,
      depositReturnedKopecks: true,
      penalties: {
        where: {
          status: "ACTIVE"
        },
        select: {
          amountKopecks: true
        }
      },
      branch: {
        select: {
          name: true
        }
      },
      bank: {
        select: {
          name: true,
          phone: true,
          comment: true,
          instructionType: true,
          assets: {
            where: {
              type: "REQUISITES"
            },
            orderBy: [
              { isPrimary: "desc" },
              { createdAt: "asc" }
            ],
            take: 1,
            select: {
              title: true,
              textBody: true
            }
          }
        }
      },
      client: {
        select: {
          id: true
        }
      },
      bikeUnit: {
        select: {
          id: true,
          article: true,
          title: true,
          serialNumber: true,
          bikeModel: {
            select: {
              name: true
            }
          }
        }
      },
      equipmentItems: {
        orderBy: [
          { createdAt: "asc" },
          { label: "asc" }
        ],
        select: {
          label: true,
          quantity: true,
          comment: true
        }
      }
    }
  });

  if (!buyout) {
    throw new HttpError(404, `Buyout '${params.sourceEntityId}' was not found`);
  }

  const { client, hydrationStatus } = await ensureClientProfileForDocuments(params.tenantId, buyout.client.id);
  const equipmentSummary = buildEquipmentSummary(buyout.equipmentItems);
  const penaltyTotalKopecks = buyout.penalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
  const values: DocumentValueMap = {
    "{{document.number}}": params.documentNumber,
    "{{document.date}}": documentDate,
    "{{company.name}}": params.tenantName,
    "{{branch.name}}": buyout.branch?.name ?? "",
    "{{deal.type}}": "Выкуп",
    "{{deal.number}}": buyout.dealNumber,
    "{{deal.start_date}}": formatDate(buyout.startsAt),
    "{{deal.next_payment_date}}": formatDate(buyout.nextPaymentAt),
    "{{payment.next_date}}": formatDate(buyout.nextPaymentAt),
    "{{deal.amount_rub}}": formatMoney(buyout.totalPriceKopecks),
    "{{deal.cadence}}": buyout.paymentCadence,
    "{{deal.term_months}}": String(buyout.termMonths),
    "{{deal.total_price_rub}}": formatMoney(buyout.totalPriceKopecks),
    "{{deal.down_payment_rub}}": formatMoney(buyout.downPaymentKopecks),
    "{{deal.residual_debt_rub}}": formatMoney(buyout.residualDebtKopecks),
    "{{deposit.target_rub}}": formatMoney(buyout.depositTargetKopecks),
    "{{deposit.collected_rub}}": formatMoney(buyout.depositCollectedKopecks),
    "{{deposit.returned_rub}}": formatMoney(buyout.depositReturnedKopecks),
    "{{penalties.total_rub}}": formatMoney(penaltyTotalKopecks),
    "{{equipment.summary}}": equipmentSummary,
    "{{deal.equipment_summary}}": equipmentSummary,
    ...buildClientValues(client),
    "{{bike.article}}": buyout.bikeUnit.article ?? "",
    "{{bike.title}}": buyout.bikeUnit.title,
    "{{bike.model_name}}": buyout.bikeUnit.bikeModel?.name ?? "",
    "{{bike.serial_number}}": buyout.bikeUnit.serialNumber ?? "",
    ...buildBankValues(buyout.bank)
  };

  return {
    sourceEntityType: params.sourceEntityType,
    sourceEntityId: buyout.id,
    sourceLabel: buyout.dealNumber,
    associations: {
      clientId: client.id,
      rentalId: null,
      buyoutId: buyout.id,
      bikeUnitId: buyout.bikeUnit.id
    },
    values,
    origins: buildPlaceholderOriginMap({
      values,
      codes: PLACEHOLDER_CATALOG.BUYOUT.map((item) => item.code),
      legacyFilledCodes: hydrationStatus.legacyFilledCodes
    }),
    hydration: {
      status: hydrationStatus.status,
      message: hydrationStatus.message,
      legacyFilledCodes: [...hydrationStatus.legacyFilledCodes].sort((left, right) => left.localeCompare(right, "ru"))
    }
  };
}

async function buildTemplateManifest(params: {
  templatePath: string;
  sourceEntityType: SourceEntityType;
}) {
  const sourceCodes = PLACEHOLDER_CATALOG[params.sourceEntityType].map((item) => item.code);
  const sourceCodeSet = new Set(sourceCodes);
  const manifest = await analyzeTemplateManifest({
    templatePath: params.templatePath,
    knownCodes: [...PLACEHOLDER_DEFINITIONS_BY_CODE.keys()]
  });

  const rows = manifest.foundCodes.map((code) => {
    const definition = PLACEHOLDER_DEFINITIONS_BY_CODE.get(code) ?? null;
    return {
      code,
      known: Boolean(definition),
      allowedForSource: sourceCodeSet.has(code),
      label: definition?.label ?? "Неизвестный код",
      description: definition?.description ?? "CRM не знает этот placeholder.",
      entity: definition?.entity ?? null,
      sourcePath: definition?.sourcePath ?? null,
      exampleValue: definition?.exampleValue ?? null
    };
  });

  const contextMismatchCount = rows.filter((row) => row.known && !row.allowedForSource).length;

  return {
    ...manifest,
    rows,
    counts: {
      ...manifest.counts,
      sourceKnownCodes: rows.filter((row) => row.allowedForSource).length,
      contextMismatchCodes: contextMismatchCount
    },
    warnings: [
      ...manifest.warnings,
      ...(contextMismatchCount > 0
        ? ["В шаблоне есть коды, которые известны CRM, но не относятся к выбранному типу документа."]
        : [])
    ]
  };
}

function buildTemplatePreviewRows(params: {
  sourceEntityType: SourceEntityType;
  manifest: Awaited<ReturnType<typeof buildTemplateManifest>>;
  preview: Awaited<ReturnType<typeof resolvePreview>>;
}) {
  const sourceCodeSet = new Set(PLACEHOLDER_CATALOG[params.sourceEntityType].map((item) => item.code));
  const rows = params.manifest.rows.map((row) => {
    if (!row.known) {
      return {
        ...row,
        status: "UNKNOWN" as PlaceholderStatus,
        origin: "NONE" as PlaceholderOrigin,
        value: "",
        issueText: "Этот код не найден в каталоге CRM."
      };
    }

    if (!row.allowedForSource || !sourceCodeSet.has(row.code)) {
      return {
        ...row,
        status: "MISSING" as const,
        origin: "NONE" as PlaceholderOrigin,
        value: "",
        issueText: "Код существует в CRM, но не относится к текущему document context."
      };
    }

    const value = params.preview.values[row.code] ?? "";
    const origin = params.preview.origins[row.code] ?? "NONE";
    return {
      ...row,
      status: value ? "FILLED" as const : "EMPTY" as const,
      origin,
      value,
      issueText: value
        ? origin === "LEGACY"
          ? "Значение было добранo из legacy во время preview."
          : null
        : "По этому коду значение в текущем deal context пустое."
    };
  });

  const summary = {
    totalRows: rows.length,
    filledRows: rows.filter((row) => row.status === "FILLED").length,
    emptyRows: rows.filter((row) => row.status === "EMPTY").length,
    missingRows: rows.filter((row) => row.status === "MISSING").length,
    unknownRows: rows.filter((row) => row.status === "UNKNOWN").length,
    legacyRows: rows.filter((row) => row.origin === "LEGACY").length
  };

  const warnings = [
    ...params.manifest.warnings,
    ...(summary.emptyRows > 0
      ? [`В preview есть пустые значения: ${summary.emptyRows}. Документ нельзя считать полностью предсказуемым без проверки.`]
      : []),
    ...(summary.missingRows > 0
      ? [`В шаблоне есть коды, не относящиеся к текущему deal context: ${summary.missingRows}.`]
      : []),
    ...(summary.unknownRows > 0
      ? [`В шаблоне есть неизвестные CRM placeholders: ${summary.unknownRows}.`]
      : []),
    ...(params.preview.hydration.status === "SKIPPED_NO_REFERENCE" || params.preview.hydration.status === "SKIPPED_NO_CONNECTION" || params.preview.hydration.status === "FAILED"
      ? [params.preview.hydration.message]
      : [])
  ];

  return {
    rows,
    summary,
    warnings
  };
}

export function createDocumentsRouter() {
  const router = Router();

  router.get("/templates", asyncHandler(async (req, res) => {
    const query = templatesQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");

    const rows = await prisma.documentTemplate.findMany({
      where: {
        tenantId: tenant.id,
        ...(query.sourceEntityType ? { sourceEntityType: query.sourceEntityType } : {})
      },
      orderBy: [
        { isActive: "desc" },
        { updatedAt: "desc" }
      ],
      select: {
        id: true,
        kind: true,
        name: true,
        templateCode: true,
        sourceEntityType: true,
        filePath: true,
        numberPrefix: true,
        numberPadding: true,
        nextNumber: true,
        placeholdersGuide: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            generations: true
          }
        }
      }
    });

    const readyRows = (await Promise.all(rows.map(async (row) => (
      await fileExists(row.filePath)
        ? row
        : null
    )))).filter((row): row is (typeof rows)[number] => Boolean(row));

    const rowsWithManifest = await Promise.all(readyRows.map(async (row) => {
      const manifest = row.sourceEntityType
        ? await buildTemplateManifest({
            templatePath: row.filePath,
            sourceEntityType: row.sourceEntityType as SourceEntityType
          })
        : null;

      return {
        ...row,
        nextDocumentNumber: formatDocumentNumber({
          templateCode: row.templateCode,
          kind: row.kind,
          numberPrefix: row.numberPrefix,
          nextNumber: row.nextNumber,
          numberPadding: row.numberPadding
        }),
        manifest: manifest
          ? {
              foundCodes: manifest.counts.foundCodes,
              sourceKnownCodes: manifest.counts.sourceKnownCodes,
              unknownCodes: manifest.counts.unknownCodes,
              contextMismatchCodes: manifest.counts.contextMismatchCodes,
              warnings: manifest.warnings
            }
          : null
      };
    }));

    res.status(200).json({
      tenant,
      total: rowsWithManifest.length,
      rows: rowsWithManifest
    });
  }));

  router.get("/placeholders", asyncHandler(async (req, res) => {
    const query = placeholdersQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");
    const requestedTypes = query.sourceEntityType ? [query.sourceEntityType] : (Object.keys(PLACEHOLDER_CATALOG) as SourceEntityType[]);

    res.status(200).json({
      tenant,
      rows: requestedTypes.map((sourceEntityType) => ({
        sourceEntityType,
        placeholders: PLACEHOLDER_CATALOG[sourceEntityType]
      }))
    });
  }));

  router.get("/preview-values", asyncHandler(async (req, res) => {
    const query = previewQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.generate");
    const documentNumber = `${query.sourceEntityType}-PREVIEW`;
    const preview = await resolvePreview({
      tenantId: tenant.id,
      tenantName: tenant.name,
      sourceEntityType: query.sourceEntityType,
      sourceEntityId: query.sourceEntityId,
      documentNumber
    });

    res.status(200).json({
      tenant,
      preview
    });
  }));

  router.get("/registry", asyncHandler(async (req, res) => {
    const query = documentRegistryQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");

    const rows = await prisma.document.findMany({
      where: {
        tenantId: tenant.id,
        ...buildDocumentRegistryFilter({
          sourceEntityType: query.sourceEntityType,
          sourceEntityId: query.sourceEntityId
        })
      },
      orderBy: {
        createdAt: "desc"
      },
      take: query.limit,
      select: {
        id: true,
        title: true,
        documentNumber: true,
        status: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            fullName: true
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
        },
        generations: {
          orderBy: {
            createdAt: "desc"
          },
          take: 1,
          select: {
            id: true,
            sourceEntityType: true,
            sourceEntityId: true,
            template: {
              select: {
                id: true,
                name: true,
                kind: true
              }
            }
          }
        }
      }
    });

    res.status(200).json({
      tenant,
      total: rows.length,
      rows: rows.map((row) => {
        const generation = row.generations[0] ?? null;
        return {
          id: row.id,
          title: row.title,
          documentNumber: row.documentNumber,
          status: row.status,
          createdAt: row.createdAt,
          createdBy: row.createdBy
            ? {
                id: row.createdBy.id,
                fullName: row.createdBy.fullName
              }
            : null,
          client: row.client
            ? {
                id: row.client.id,
                fullName: row.client.fullName
              }
            : null,
          sourceEntityType: generation?.sourceEntityType ?? (row.rental ? "RENTAL" : row.buyout ? "BUYOUT" : row.client ? "CLIENT" : null),
          sourceEntityId: generation?.sourceEntityId ?? row.rental?.id ?? row.buyout?.id ?? row.client?.id ?? null,
          sourceLabel: resolveDocumentSourceLabel({
            clientName: row.client?.fullName ?? null,
            rentalNumber: row.rental?.dealNumber ?? null,
            buyoutNumber: row.buyout?.dealNumber ?? null
          }),
          template: generation?.template
            ? {
                id: generation.template.id,
                name: generation.template.name,
                kind: generation.template.kind
              }
            : null,
          order: row.rental
            ? {
                kind: "RENTAL",
                id: row.rental.id,
                dealNumber: row.rental.dealNumber,
                href: `/rentals/${row.rental.id}`
              }
            : row.buyout
              ? {
                  kind: "BUYOUT",
                  id: row.buyout.id,
                  dealNumber: row.buyout.dealNumber,
                  href: `/buyouts/${row.buyout.id}`
                }
              : null,
          downloadHref: `/api/v1/documents/${row.id}/download?tenantSlug=${tenant.slug}`
        };
      })
    });
  }));

  router.post("/templates", asyncHandler(async (req, res) => {
    const payload = createTemplateSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "documents.manage_templates");
    const filePath = payload.fileName?.trim() && payload.fileBase64?.trim()
      ? await persistUploadedTemplateFile({
          tenantSlug: tenant.slug,
          fileName: payload.fileName.trim(),
          fileBase64: payload.fileBase64.trim()
        })
      : payload.filePath?.trim() ?? "";

    const template = await prisma.documentTemplate.create({
      data: {
        tenantId: tenant.id,
        kind: payload.kind,
        name: payload.name,
        templateCode: payload.templateCode?.trim() || null,
        sourceEntityType: payload.sourceEntityType,
        filePath,
        numberPrefix: payload.numberPrefix?.trim() || null,
        numberPadding: payload.numberPadding,
        nextNumber: payload.nextNumber ?? 1,
        placeholdersGuide: payload.placeholdersGuide?.trim() || null
      },
      select: {
        id: true,
        kind: true,
        name: true,
        templateCode: true,
        sourceEntityType: true,
        filePath: true,
        numberPrefix: true,
        numberPadding: true,
        nextNumber: true,
        isActive: true
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "document_template",
        entityId: template.id,
        action: "template_created",
        newValueText: JSON.stringify(template, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(201).json({
      tenant,
      template: {
        ...template,
        nextDocumentNumber: formatDocumentNumber({
          templateCode: template.templateCode,
          kind: template.kind,
          numberPrefix: template.numberPrefix,
          nextNumber: template.nextNumber,
          numberPadding: template.numberPadding
        })
      }
    });
  }));

  router.patch("/templates/:templateId", asyncHandler(async (req, res) => {
    const params = templateParamsSchema.parse(req.params);
    const payload = updateTemplateSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "documents.manage_templates");

    const existing = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        templateCode: true,
        numberPrefix: true,
        isActive: true,
        kind: true,
        numberPadding: true,
        nextNumber: true,
        sourceEntityType: true,
        filePath: true
      }
    });

    if (!existing) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    const nextFilePath = payload.fileName?.trim() && payload.fileBase64?.trim()
      ? await persistUploadedTemplateFile({
          tenantSlug: tenant.slug,
          fileName: payload.fileName.trim(),
          fileBase64: payload.fileBase64.trim()
        })
      : undefined;

    const template = await prisma.documentTemplate.update({
      where: { id: existing.id },
      data: {
        ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
        ...(payload.templateCode !== undefined ? { templateCode: payload.templateCode?.trim() || null } : {}),
        ...(payload.numberPrefix !== undefined ? { numberPrefix: payload.numberPrefix?.trim() || null } : {}),
        ...(payload.nextNumber !== undefined ? { nextNumber: payload.nextNumber } : {}),
        ...(nextFilePath ? { filePath: nextFilePath } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {})
      },
      select: {
        id: true,
        kind: true,
        name: true,
        templateCode: true,
        sourceEntityType: true,
        filePath: true,
        numberPrefix: true,
        numberPadding: true,
        nextNumber: true,
        isActive: true
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "document_template",
        entityId: template.id,
        action: "template_updated",
        oldValueText: JSON.stringify(existing, null, 2),
        newValueText: JSON.stringify(template, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      template: {
        ...template,
        nextDocumentNumber: formatDocumentNumber({
          templateCode: template.templateCode,
          kind: template.kind,
          numberPrefix: template.numberPrefix,
          nextNumber: template.nextNumber,
          numberPadding: template.numberPadding
        })
      }
    });
  }));

  router.delete("/templates/:templateId", asyncHandler(async (req, res) => {
    const params = templateParamsSchema.parse(req.params);
    const query = tenantQuerySchema.parse(req.query);
    const { actor, tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.manage_templates");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        filePath: true,
        _count: {
          select: {
            generations: true
          }
        }
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    if (template._count.generations > 0) {
      throw new HttpError(409, "Шаблон уже использовался в документах. Его можно заменить или отключить, но не удалить.");
    }

    await prisma.documentTemplate.delete({
      where: {
        id: template.id
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "document_template",
        entityId: template.id,
        action: "template_deleted",
        oldValueText: JSON.stringify(template, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      deleted: {
        id: template.id,
        name: template.name
      }
    });
  }));

  router.get("/templates/:templateId/file", asyncHandler(async (req, res) => {
    const params = templateParamsSchema.parse(req.params);
    const query = templateFileDownloadQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        filePath: true
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    const extension = path.extname(template.filePath).toLowerCase();
    const fileName = `${sanitizeFileName(template.name)}${extension || ".txt"}`;
    const mimeType = extension === ".txt"
      ? "text/plain; charset=utf-8"
      : extension === ".docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";

    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `${query.disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    const stream = (await import("node:fs")).createReadStream(template.filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(404).json({
          error: {
            message: "Файл шаблона не найден"
          }
        });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }));

  router.get("/templates/:templateId/content", asyncHandler(async (req, res) => {
    const params = templateParamsSchema.parse(req.params);
    const query = tenantQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        sourceEntityType: true,
        filePath: true,
        numberPrefix: true,
        nextNumber: true,
        numberPadding: true
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    if (!isPlainTextTemplatePath(template.filePath)) {
      throw new HttpError(409, "Встроенное редактирование доступно только для TXT-шаблонов.");
    }

    const content = await readPlainTextTemplateContent(template.filePath);

    res.status(200).json({
      tenant,
      template: {
        ...template,
        isEditableText: true
      },
      content
    });
  }));

  router.patch("/templates/:templateId/content", asyncHandler(async (req, res) => {
    const params = templateParamsSchema.parse(req.params);
    const payload = updateTemplateContentSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "documents.manage_templates");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        filePath: true
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    if (!isPlainTextTemplatePath(template.filePath)) {
      throw new HttpError(409, "Встроенное редактирование доступно только для TXT-шаблонов.");
    }

    await writePlainTextTemplateContent({
      templatePath: template.filePath,
      content: payload.content
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.userId,
        entityType: "document_template",
        entityId: template.id,
        action: "template_content_updated",
        newValueText: JSON.stringify({
          contentLength: payload.content.length
        }, null, 2),
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? null
      }
    });

    res.status(200).json({
      tenant,
      updated: {
        id: template.id,
        name: template.name,
        contentLength: payload.content.length
      }
    });
  }));

  router.get("/templates/:templateId/manifest", asyncHandler(async (req, res) => {
    const params = templateParamsSchema.parse(req.params);
    const query = tenantQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        name: true,
        kind: true,
        sourceEntityType: true,
        filePath: true,
        isActive: true
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    if (!template.sourceEntityType) {
      throw new HttpError(409, "Template sourceEntityType is not configured");
    }

    const manifest = await buildTemplateManifest({
      templatePath: template.filePath,
      sourceEntityType: template.sourceEntityType as SourceEntityType
    });

    res.status(200).json({
      tenant,
      template,
      manifest
    });
  }));

  router.get("/templates/:templateId/preview", asyncHandler(async (req, res) => {
    // Preview is intentionally non-committing and shared by /documents authoring and document issuing from deal cards.
    const params = templateParamsSchema.parse(req.params);
    const query = templatePreviewSchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.generate");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id,
        isActive: true
      },
      select: {
        id: true,
        name: true,
        kind: true,
        templateCode: true,
        sourceEntityType: true,
        filePath: true,
        numberPrefix: true,
        numberPadding: true,
        nextNumber: true,
        isActive: true
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    if (!template.sourceEntityType) {
      throw new HttpError(409, "Template sourceEntityType is not configured");
    }

    const sourceEntityType = template.sourceEntityType as SourceEntityType;
    const documentNumber = formatDocumentNumber({
      templateCode: template.templateCode,
      kind: template.kind,
      numberPrefix: template.numberPrefix,
      nextNumber: template.nextNumber,
      numberPadding: template.numberPadding
    });

    const [manifest, preview] = await Promise.all([
      buildTemplateManifest({
        templatePath: template.filePath,
        sourceEntityType
      }),
      resolvePreview({
        tenantId: tenant.id,
        tenantName: tenant.name,
        sourceEntityType,
        sourceEntityId: query.sourceEntityId,
        documentNumber
      })
    ]);
    const renderedText = await renderPlainTextTemplatePreview({
      templatePath: template.filePath,
      values: preview.values
    });

    const previewRows = buildTemplatePreviewRows({
      sourceEntityType,
      manifest,
      preview
    });

    res.status(200).json({
      tenant,
      template: {
        ...template,
        nextDocumentNumber: documentNumber
      },
      preview: {
        sourceEntityType: preview.sourceEntityType,
        sourceEntityId: preview.sourceEntityId,
        sourceLabel: preview.sourceLabel,
        hydration: preview.hydration,
        manifest,
        renderedText,
        rows: previewRows.rows,
        summary: previewRows.summary,
        warnings: previewRows.warnings
      }
    });
  }));

  router.post("/templates/:templateId/generate-draft", asyncHandler(async (req, res) => {
    // Generation reuses preview values so numbering, hydration and placeholder resolution stay consistent with operator preview.
    const params = templateParamsSchema.parse(req.params);
    const payload = generateDraftSchema.parse(req.body);
    const { actor, tenant } = await requireTenantPermission(req, payload.tenantSlug, "documents.generate");

    const template = await prisma.documentTemplate.findFirst({
      where: {
        id: params.templateId,
        tenantId: tenant.id,
        isActive: true
      },
      select: {
        id: true,
        kind: true,
        name: true,
        templateCode: true,
        filePath: true,
        sourceEntityType: true,
        numberPrefix: true,
        numberPadding: true,
        nextNumber: true
      }
    });

    if (!template) {
      throw new HttpError(404, `Document template '${params.templateId}' was not found`);
    }

    if (!template.sourceEntityType) {
      throw new HttpError(409, "Template sourceEntityType is not configured");
    }

    const previewNumber = formatDocumentNumber({
      templateCode: template.templateCode,
      kind: template.kind,
      numberPrefix: template.numberPrefix,
      nextNumber: template.nextNumber,
      numberPadding: template.numberPadding
    });

    const preview = await resolvePreview({
      tenantId: tenant.id,
      tenantName: tenant.name,
      sourceEntityType: template.sourceEntityType as SourceEntityType,
      sourceEntityId: payload.sourceEntityId,
      documentNumber: previewNumber
    });

    if (!payload.commit) {
      return res.status(200).json({
        tenant,
        draft: {
          documentNumber: previewNumber,
          templateId: template.id,
          sourceEntityType: preview.sourceEntityType,
          sourceEntityId: preview.sourceEntityId,
          values: preview.values
        }
      });
    }

    const fileName = buildGeneratedFileName(previewNumber, template.filePath);
    const storageDir = path.join(env.FILE_STORAGE_ROOT, "documents", tenant.slug);
    const filePath = path.join(storageDir, fileName);
    const rendered = await renderDocumentFromTemplate({
      templatePath: template.filePath,
      targetPath: filePath,
      values: preview.values
    });

    const result = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          tenantId: tenant.id,
          createdById: actor.userId,
          clientId: preview.associations.clientId,
          rentalId: preview.associations.rentalId,
          buyoutId: preview.associations.buyoutId,
          bikeUnitId: preview.associations.bikeUnitId,
          documentNumber: previewNumber,
          title: payload.title?.trim() || template.name,
          filePath,
          mimeType: rendered.mimeType
        },
        select: {
          id: true,
          documentNumber: true,
          title: true,
          filePath: true,
          mimeType: true,
          createdAt: true
        }
      });

      const generation = await tx.documentGeneration.create({
        data: {
          tenantId: tenant.id,
          createdById: actor.userId,
          templateId: template.id,
          documentId: document.id,
          sourceEntityType: preview.sourceEntityType,
          sourceEntityId: preview.sourceEntityId
        },
        select: {
          id: true,
          createdAt: true
        }
      });

      await tx.documentTemplate.update({
        where: { id: template.id },
        data: {
          nextNumber: {
            increment: 1
          }
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actor.userId,
          entityType: "document",
          entityId: document.id,
          action: "document_generated",
          newValueText: JSON.stringify({
            templateId: template.id,
            generationId: generation.id,
            documentNumber: previewNumber,
            filePath
          }, null, 2),
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null
        }
      });

      return {
        document,
        generation
      };
    });

    res.status(201).json({
      tenant,
      draft: {
        ...result,
        downloadHref: `/api/v1/documents/${result.document.id}/download?tenantSlug=${tenant.slug}`,
        values: preview.values
      }
    });
  }));

  router.get("/:documentId/download", asyncHandler(async (req, res) => {
    const params = documentParamsSchema.parse(req.params);
    const query = documentDownloadQuerySchema.parse(req.query);
    const { tenant } = await requireTenantPermission(req, query.tenantSlug, "documents.view");

    const document = await prisma.document.findFirst({
      where: {
        id: params.documentId,
        tenantId: tenant.id
      },
      select: {
        id: true,
        title: true,
        documentNumber: true,
        filePath: true,
        mimeType: true
      }
    });

    if (!document) {
      throw new HttpError(404, `Document '${params.documentId}' was not found`);
    }

    const fileName = sanitizeFileName(document.documentNumber?.trim() || document.title);
    const extension = path.extname(document.filePath) || ".txt";
    res.setHeader("Content-Type", document.mimeType ?? "application/octet-stream");
    res.setHeader("Content-Disposition", `${query.disposition}; filename=\"${fileName}${extension}\"`);
    res.sendFile(path.resolve(document.filePath));
  }));

  return router;
}
