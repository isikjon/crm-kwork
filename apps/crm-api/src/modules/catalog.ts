export interface CrmModuleDefinition {
  slug: string;
  name: string;
  summary: string;
  pages: string[];
  services: string[];
  entities: string[];
  mvp: boolean;
  phase: "mvp" | "phase-2";
  referenceSignals?: string[];
}

export interface NavigationItem {
  href: string;
  label: string;
  description: string;
}

export interface DataModelGroup {
  title: string;
  tables: string[];
}

const moduleCatalog: CrmModuleDefinition[] = [
  {
    slug: "auth",
    name: "Auth",
    summary: "Авторизация, сессии, backend-RBAC и защита tenant-aware запросов.",
    pages: ["/users", "/settings", "/saas"],
    services: ["AuthService"],
    entities: ["users", "roles", "permissions", "role_permissions", "user_roles"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "tenants",
    name: "Tenants & Subscription",
    summary: "Компании, тарифы SaaS, ограничения и support/impersonation foundation.",
    pages: ["/saas", "/settings"],
    services: ["TenantService", "SubscriptionService"],
    entities: ["tenants", "subscription_plans", "tenant_subscriptions", "settings"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "branches",
    name: "Branches",
    summary: "Филиалы, точки, ограничения доступа сотрудников и привязка сделок к точке.",
    pages: ["/settings", "/orders", "/rentals", "/buyouts"],
    services: ["BranchService"],
    entities: ["branches"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "orders",
    name: "Orders Registry",
    summary: "Единый рабочий реестр, где аренда и выкуп видны в одном списке с долгом, ближайшей оплатой и просрочкой.",
    pages: ["/orders"],
    services: ["RentalService", "BuyoutService", "ScheduleService", "FinanceService"],
    entities: ["rentals", "buyouts", "payment_schedules", "payment_schedule_items", "financial_transactions"],
    mvp: true,
    phase: "mvp",
    referenceSignals: [
      "Unified operational UX reference from apps/dashboard/components/OrdersTable.tsx"
    ]
  },
  {
    slug: "tariffs",
    name: "Tariffs",
    summary: "Тарифные группы аренды и выкупа с бесплатными днями, общими штрафами и закреплением только за реальными велосипедами.",
    pages: ["/tariffs", "/rentals", "/buyouts"],
    services: ["TariffService", "PenaltyService", "RentalService", "BuyoutService"],
    entities: ["rental_tariff_groups", "rental_tariff_group_rates", "bike_units", "rentals"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "clients",
    name: "Clients",
    summary: "Карточки клиентов, контакты, паспортные данные, история сделок и действий.",
    pages: ["/clients"],
    services: ["ClientService"],
    entities: ["clients", "client_contacts", "client_identity_data", "notes"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "fleet",
    name: "Fleet",
    summary: "Модели, единицы техники, статусы, экономика, фото и связи с ремонтом.",
    pages: ["/bikes", "/repairs"],
    services: ["FleetService", "RepairService"],
    entities: ["bike_models", "bike_units", "repairs"],
    mvp: true,
    phase: "mvp",
    referenceSignals: [
      "Current StarLine matching logic from apps/backend/src/services/starlineService.ts"
    ]
  },
  {
    slug: "equipment",
    name: "Equipment Catalog",
    summary: "Справочник доп. оборудования, которое выбирают в заказе и фиксируют в сделке и документах.",
    pages: ["/equipment", "/orders"],
    services: ["EquipmentCatalogService", "RentalService", "BuyoutService", "DocumentService"],
    entities: ["equipment_catalog_items", "deal_equipment_items"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "rentals",
    name: "Rentals",
    summary: "Сделки аренды, фиксированные тарифы 1/7/30 дней, долг, залоги, штрафы и возвраты.",
    pages: ["/orders", "/rentals"],
    services: ["RentalService", "ScheduleService", "DepositService", "PenaltyService"],
    entities: ["rentals", "payment_schedules", "payment_schedule_items", "deposits", "penalties"],
    mvp: true,
    phase: "mvp",
    referenceSignals: [
      "Partial payment behavior from apps/backend/src/services/paymentService.ts",
      "Debt calculation reference from apps/backend/src/services/orderDebtService.ts"
    ]
  },
  {
    slug: "buyouts",
    name: "Buyouts",
    summary: "Выкуп на 6 месяцев с недельной или месячной схемой и контролем графика.",
    pages: ["/orders", "/buyouts"],
    services: ["BuyoutService", "ScheduleService"],
    entities: ["buyouts", "payment_schedules", "payment_schedule_items"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "banks",
    name: "Banks",
    summary: "Справочник реквизитов и QR для выбора способа оплаты внутри сделки.",
    pages: ["/banks"],
    services: ["BankService"],
    entities: ["banks", "bank_assets"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "finance",
    name: "Finance",
    summary: "Реестр всех поступлений, списаний, залогов, штрафов и сервисных расходов.",
    pages: ["/finance"],
    services: ["FinanceService"],
    entities: ["financial_transactions"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "documents",
    name: "Documents",
    summary: "Шаблоны DOCX, генерация, хранение и печать договоров и актов.",
    pages: ["/documents"],
    services: ["DocumentService"],
    entities: ["document_templates", "documents", "document_generations"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "notifications",
    name: "Notifications",
    summary: "Сценарные уведомления через Telegram с подготовкой к будущим каналам.",
    pages: ["/settings", "/clients", "/orders", "/rentals", "/buyouts"],
    services: ["NotificationService"],
    entities: ["notification_scenarios", "notifications", "integrations"],
    mvp: true,
    phase: "mvp",
    referenceSignals: [
      "Scenario engine reference from apps/backend/src/services/notificationService.ts",
      "Telegram bindings reference from apps/backend/src/services/telegramBindingsStore.ts"
    ]
  },
  {
    slug: "statistics",
    name: "Statistics",
    summary: "KPI, загрузка парка, выручка, расходы, ремонты и эффективность менеджеров.",
    pages: ["/statistics", "/"],
    services: ["StatisticsService"],
    entities: ["financial_transactions", "rentals", "buyouts", "repairs", "bike_units"],
    mvp: true,
    phase: "mvp"
  },
  {
    slug: "imports",
    name: "Imports",
    summary: "Импорт клиентов и парка из МойСклад и legacy bridge из старой CRM с dry-run, mapping и защитой от дублей.",
    pages: ["/imports", "/settings", "/clients", "/bikes"],
    services: ["ImportService"],
    entities: ["imports", "import_jobs", "integrations"],
    mvp: true,
    phase: "mvp",
    referenceSignals: [
      "Live legacy cache bridge from apps/crm-api/src/modules/legacy/legacy-source.ts"
    ]
  },
  {
    slug: "audit",
    name: "Audit",
    summary: "Журнал действий, причин, impersonation и истории изменений.",
    pages: ["/users", "/saas", "/settings"],
    services: ["AuditService"],
    entities: ["audit_logs"],
    mvp: true,
    phase: "mvp"
  }
];

const navigation: NavigationItem[] = [
  { href: "/", label: "Дашборд", description: "Активные сделки, просрочки и быстрые действия" },
  { href: "/orders", label: "Заказы", description: "Единый реестр аренды и выкупа для контроля оплат" },
  { href: "/tariffs", label: "Тарифы", description: "Общие правила залога и штрафов по тарифам" },
  { href: "/clients", label: "Клиенты", description: "Карточки клиентов и история взаимодействий" },
  { href: "/bikes", label: "Велосипеды", description: "Учет единиц техники и состояния парка" },
  { href: "/equipment", label: "Комплекты", description: "Справочник доп. оборудования для выдачи в сделке" },
  { href: "/repairs", label: "Ремонты", description: "История сервисных затрат и проблемной техники" },
  { href: "/banks", label: "Банки", description: "QR, реквизиты и способы отправки инструкций" },
  { href: "/finance", label: "Финансы", description: "Реестр поступлений, возвратов и расходов" },
  { href: "/imports", label: "Импорт", description: "Миграция из старой CRM и стартовые загрузки" },
  { href: "/statistics", label: "Статистика", description: "KPI, выручка, ремонты и загрузка парка" },
  { href: "/documents", label: "Документы", description: "DOCX-шаблоны, генерация и печать" },
  { href: "/users", label: "Пользователи", description: "Роли, права, точки доступа и audit" },
  { href: "/settings", label: "Настройки", description: "Интеграции, уведомления и импорт" },
  { href: "/saas", label: "SaaS-админка", description: "Компании, тарифы, ограничения и support" }
];

const dataModel: DataModelGroup[] = [
  {
    title: "SaaS и доступ",
    tables: ["tenants", "subscription_plans", "tenant_subscriptions", "users", "roles", "permissions", "role_permissions", "user_roles"]
  },
  {
    title: "Операционный контур",
    tables: ["branches", "clients", "client_contacts", "client_identity_data", "bike_models", "bike_units", "equipment_catalog_items", "deal_equipment_items", "repairs", "notes"]
  },
  {
    title: "Сделки и графики",
    tables: ["rentals", "buyouts", "payment_schedules", "payment_schedule_items", "deposits", "penalties"]
  },
  {
    title: "Финансы и платежные каналы",
    tables: ["banks", "bank_assets", "financial_transactions"]
  },
  {
    title: "Документы, уведомления и сервисные контуры",
    tables: ["document_templates", "documents", "document_generations", "notification_scenarios", "notifications", "imports", "import_jobs", "integrations", "settings", "audit_logs"]
  }
];

const mvp = [
  "auth",
  "tenants",
  "branches",
  "orders",
  "clients",
  "fleet",
  "repairs",
  "rentals",
  "buyouts",
  "banks",
  "finance",
  "documents",
  "notifications",
  "statistics",
  "imports",
  "audit"
];

const phaseTwo = [
  "Dynamic tariff engine",
  "Flexible automatic penalties",
  "Advanced profitability analytics",
  "Support / impersonation workflow",
  "WhatsApp / SMS delivery channels",
  "Expanded bank and cash abstractions"
];

export function getProductSnapshot() {
  return {
    product: {
      name: "PROKOLESA CRM SaaS",
      tagline: "Separate operational CRM for e-bike rental and buyout companies",
      mainEntity: "deal",
      modes: ["rental", "buyout"],
      mobileFirst: true,
      multiTenant: true,
      database: "PostgreSQL"
    },
    modules: moduleCatalog,
    navigation,
    dataModel,
    mvp,
    phaseTwo,
    references: [
      {
        topic: "Telegram scenarios",
        source: "apps/backend/src/services/notificationService.ts"
      },
      {
        topic: "Telegram client bindings",
        source: "apps/backend/src/services/telegramBindingsStore.ts"
      },
      {
        topic: "Payment and partial logic",
        source: "apps/backend/src/services/paymentService.ts"
      },
      {
        topic: "Operational mobile UI patterns",
        source: "apps/dashboard/components/OrdersTable.tsx"
      }
    ]
  };
}
