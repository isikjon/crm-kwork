export interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  description: string;
  requiredAnyPermissions?: string[];
}

export interface SectionMetric {
  label: string;
  value: string;
  note: string;
}

export interface SectionContent {
  slug: string;
  eyebrow: string;
  title: string;
  summary: string;
  metrics: SectionMetric[];
  priorities: string[];
  modules: string[];
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Дашборд", shortLabel: "Домой", description: "KPI, активные сделки, проблемные зоны" },
  { href: "/orders", label: "Заказы", shortLabel: "Заказы", description: "Единый реестр аренды и выкупа, долги и ближайшие оплаты", requiredAnyPermissions: ["orders.view"] },
  { href: "/tariffs", label: "Тарифы", shortLabel: "Тарифы", description: "Группы аренды и выкупа, штрафы, залог и закрепление за велосипедами", requiredAnyPermissions: ["tariffs.view"] },
  { href: "/clients", label: "Клиенты", shortLabel: "Клиенты", description: "Контакты, история сделок, заметки, документы", requiredAnyPermissions: ["clients.view"] },
  { href: "/bikes", label: "Велосипеды", shortLabel: "Парк", description: "Единицы техники, статусы, экономика, местоположение", requiredAnyPermissions: ["fleet.view"] },
  { href: "/equipment", label: "Комплекты", shortLabel: "Компл.", description: "Справочник доп. оборудования для выдачи в заказе", requiredAnyPermissions: ["equipment.view"] },
  { href: "/finance", label: "Финансы", shortLabel: "Финансы", description: "Реестр поступлений, возвратов и расходов", requiredAnyPermissions: ["finance.view"] },
  { href: "/repairs", label: "Ремонты", shortLabel: "Ремонт", description: "Затраты, история ремонта, проблемная техника", requiredAnyPermissions: ["repairs.view"] },
  { href: "/banks", label: "Банки", shortLabel: "Банки", description: "QR, реквизиты и платежные инструкции", requiredAnyPermissions: ["banks.view"] },
  { href: "/imports", label: "Импорт", shortLabel: "Импорт", description: "Legacy bridge, dry-run и миграция в новую CRM", requiredAnyPermissions: ["imports.view"] },
  { href: "/statistics", label: "Статистика", shortLabel: "Стат.", description: "Выручка, загрузка парка, ремонты, менеджеры" },
  { href: "/documents", label: "Документы", shortLabel: "Docs", description: "Шаблоны DOCX, генерация, печать", requiredAnyPermissions: ["documents.view"] },
  { href: "/users", label: "Пользователи", shortLabel: "Права", description: "Users, roles, permissions, audit", requiredAnyPermissions: ["users.view"] },
  { href: "/settings", label: "Настройки", shortLabel: "Настр.", description: "Интеграции, уведомления, импорт", requiredAnyPermissions: ["gps.view", "notifications.view"] },
  { href: "/saas", label: "SaaS-админка", shortLabel: "SaaS", description: "Компании, тарифы, ограничения и support", requiredAnyPermissions: ["saas.view"] }
];

export const SECTION_CONTENT: Record<string, SectionContent> = {
  orders: {
    slug: "orders",
    eyebrow: "Unified Orders",
    title: "Аренда и выкуп в одном рабочем реестре",
    summary: "Это главный экран менеджера: здесь аренда и выкуп снова собраны в один список, чтобы видеть всех клиентов, кто должен платить сегодня, просрочил или уже ушел в проблемную зону.",
    metrics: [
      { label: "Единый список", value: "Rental + Buyout", note: "одна очередь работы вместо двух разделов" },
      { label: "Контроль", value: "Debt-first", note: "долг, просрочка и ближайший платеж сверху" },
      { label: "Переход", value: "1 click", note: "из общего реестра в карточку конкретной сделки" }
    ],
    priorities: [
      "Свести аренду и выкуп в один операторский экран без потери их разной бизнес-логики.",
      "Сортировать сделки по просрочке, долгу и ближайшей дате оплаты.",
      "Сделать этот реестр основной точкой контроля оплат для менеджера."
    ],
    modules: ["RentalService", "BuyoutService", "ScheduleService", "FinanceService"]
  },
  tariffs: {
    slug: "tariffs",
    eyebrow: "Tariff Rules",
    title: "Тарифные группы аренды и выкупа",
    summary: "Этот раздел нужен, чтобы один раз задать сетки аренды и выкупа, общие штрафы и залог, а затем закрепить эти группы за нужными велосипедами. Менеджер работает уже по готовой группе, а не подбирает суммы вручную в сделке.",
    metrics: [
      { label: "Подход", value: "Rental + Buyout", note: "две независимые сетки на один парк" },
      { label: "Контроль", value: "Bike-locked", note: "сумма идет от закрепленного велосипеда" },
      { label: "Применение", value: "Mass edit", note: "за 2 клика можно сменить группу у набора велосипедов" }
    ],
    priorities: [
      "Убрать ручной выбор суммы из сделки: тариф должен приходить от группы велосипеда.",
      "Поддержать отдельные группы аренды и выкупа для разных типов и партий парка.",
      "Держать общие штрафы, залог и льготный период в одной карточке тарифной группы."
    ],
    modules: ["TariffService", "RentalService", "BuyoutService", "PenaltyService"]
  },
  clients: {
    slug: "clients",
    eyebrow: "Clients CRM",
    title: "Карточки клиентов и контуры доверия",
    summary: "Раздел собирает контактную карточку, историю аренд и выкупов, паспортный блок для договоров, документы, заметки и риск-профиль клиента.",
    metrics: [
      { label: "Поиск", value: "Fast", note: "телефон, ФИО, Telegram, сделка" },
      { label: "История", value: "360°", note: "аренда, выкуп, платежи, audit" },
      { label: "Паспортный блок", value: "Secure", note: "отдельно от обычных контактов" }
    ],
    priorities: [
      "Разделить обычную контактную карточку и identity-данные для договора.",
      "Показывать текущий долг, просрочки и количество активных сделок на первом экране.",
      "Сделать быстрые действия: новая аренда, новый выкуп, отправка реквизитов."
    ],
    modules: ["ClientService", "DocumentService", "NotificationService", "AuditService"]
  },
  bikes: {
    slug: "bikes",
    eyebrow: "Fleet CRM",
    title: "Учет парка по единицам техники",
    summary: "Раздел учитывает не модели, а конкретные велосипеды: себестоимость, цену продажи, статус, точку, клиента, ремонты и историю выдач.",
    metrics: [
      { label: "Единицы учета", value: "1 bike = 1 asset", note: "не каталог, а парк" },
      { label: "Экономика", value: "2 core fields", note: "себестоимость и цена продажи" },
      { label: "Статусы", value: "7", note: "свободен, выкуп, ремонт и др." }
    ],
    priorities: [
      "Не позволять одной единице быть в двух активных сделках одновременно.",
      "Хранить историю выдач и возвратов на уровне bike unit.",
      "Подготовить место для StarLine-link и будущего учета комплектующих."
    ],
    modules: ["FleetService", "RepairService", "StatisticsService"]
  },
  equipment: {
    slug: "equipment",
    eyebrow: "Equipment Catalog",
    title: "Комплекты и доп. оборудование",
    summary: "Это не склад с остатками, а справочник позиций, которые администратор заводит один раз, а менеджер потом выдает клиенту внутри заказа.",
    metrics: [
      { label: "Подход", value: "Catalog first", note: "справочник без складской тяжести" },
      { label: "Выдача", value: "Per deal", note: "оборудование живет в сделке, а не в велосипеде" },
      { label: "Документы", value: "Included", note: "видно в заказе и шаблонах сделки" }
    ],
    priorities: [
      "Держать базовые позиции вроде АКБ, зарядки, шлема и цепного замка в одном месте.",
      "Не превращать этот этап в полноценный складской модуль с остатками.",
      "Сделать выбор доп. оборудования быстрым и понятным прямо в новом заказе."
    ],
    modules: ["EquipmentCatalogService", "RentalService", "BuyoutService", "DocumentService"]
  },
  repairs: {
    slug: "repairs",
    eyebrow: "Repair Ledger",
    title: "Ремонты как часть экономики бизнеса",
    summary: "Ремонт в CRM сразу влияет на аналитику, видимость проблемной техники и экономику каждой единицы велосипеда.",
    metrics: [
      { label: "Затраты", value: "Tracked", note: "каждый ремонт в деньгах" },
      { label: "История", value: "Per bike", note: "по каждому велосипеду" },
      { label: "Убыточность", value: "Visible", note: "в аналитике и карточке парка" }
    ],
    priorities: [
      "Фиксировать исполнителя, источник расхода и комментарий по каждой записи.",
      "Подсвечивать велосипеды с повторяющимися поломками.",
      "Связывать ремонт с текущим статусом парка и доступностью для выдачи."
    ],
    modules: ["RepairService", "FleetService", "FinanceService", "StatisticsService"]
  },
  rentals: {
    slug: "rentals",
    eyebrow: "Rental Deals",
    title: "Сделки аренды как центральный рабочий процесс",
    summary: "Раздел аренды строится вокруг активной сделки, а не заказа. Тут живут тариф, график, следующий платеж, долг, штрафы и возврат.",
    metrics: [
      { label: "Тарифы старта", value: "1 / 7 / 30", note: "дней с запасом под новые" },
      { label: "Залог", value: "Native", note: "получение и возврат как отдельные операции" },
      { label: "Partial", value: "Required", note: "частичная оплата должна корректно уменьшать долг" }
    ],
    priorities: [
      "Считать следующую дату платежа только на backend.",
      "Поддержать ручные и автоштрафы без поломки основной сделки.",
      "Нельзя завершить аренду без корректного сценария возврата."
    ],
    modules: ["RentalService", "ScheduleService", "DepositService", "PenaltyService", "FinanceService"]
  },
  buyouts: {
    slug: "buyouts",
    eyebrow: "Buyout Deals",
    title: "Выкуп на 6 месяцев с прозрачным графиком",
    summary: "Раздел выкупа отслеживает схему оплаты по месяцам или неделям, остаток долга, факт платежей, просрочку и статус закрытия сделки.",
    metrics: [
      { label: "Базовый срок", value: "6 months", note: "на старте фиксирован" },
      { label: "Схемы", value: "Weekly / Monthly", note: "две модели графика" },
      { label: "Debt engine", value: "Backend", note: "остаток и просрочка только на сервере" }
    ],
    priorities: [
      "Строить график автоматически от стоимости модели и условий сделки.",
      "Поддержать частичные платежи без ручной математики менеджера.",
      "Показывать остаток долга и следующий взнос в одном блоке."
    ],
    modules: ["BuyoutService", "ScheduleService", "FinanceService", "DocumentService"]
  },
  banks: {
    slug: "banks",
    eyebrow: "Payment Instructions",
    title: "Банки как реестр реквизитов и QR",
    summary: "Раздел нужен для выбора платежного источника внутри сделки: QR, реквизиты, телефон, режим отправки и связь с клиентским сценарием.",
    metrics: [
      { label: "Режимы", value: "QR / реквизиты", note: "потом можно расширить" },
      { label: "Контекст", value: "Per deal", note: "банк сохраняется в аренде или выкупе" },
      { label: "Telegram", value: "Immediate", note: "отправка без лишнего предпросмотра" }
    ],
    priorities: [
      "Хранить активность, комментарий и способ отправки.",
      "Привязать выбранный банк к сделке и истории коммуникации.",
      "Подготовить архитектуру под наличные, кассу и внутренний счет."
    ],
    modules: ["BankService", "NotificationService", "FinanceService"]
  },
  finance: {
    slug: "finance",
    eyebrow: "Money Ledger",
    title: "Финансы по ментальной модели «Деньги»",
    summary: "Финансовый раздел должен быть привычным: единый реестр операций с фильтрами, статусами, основанием, сделкой и безопасным проведением.",
    metrics: [
      { label: "Registry", value: "Unified", note: "все движения в одном списке" },
      { label: "Methods", value: "Bank + Cash", note: "наличные обязательны" },
      { label: "Critical ops", value: "Transactional", note: "проведение и возврат под backend-контролем" }
    ],
    priorities: [
      "Возврат залога сделать отдельной операцией и отдельным действием менеджера.",
      "Хранить источник, автора, дату проведения и комментарий.",
      "Давать фильтры по клиенту, сделке, банку, типу и статусу."
    ],
    modules: ["FinanceService", "DepositService", "PenaltyService", "AuditService"]
  },
  imports: {
    slug: "imports",
    eyebrow: "Legacy Bridge",
    title: "Импорт из старой CRM как управляемая миграция",
    summary: "Новая CRM читает живые operational JSON из старой системы, нормализует кэш сделок, partial payments, заметки и правила, а затем переносит это в tenant-aware модель PostgreSQL.",
    metrics: [
      { label: "Источник", value: "Live legacy data", note: "старая CRM читается напрямую из data-папки" },
      { label: "Безопасность", value: "Secrets excluded", note: "Telegram и StarLine ключи не копируются" },
      { label: "Режим", value: "Bridge first", note: "сначала dry-run и обзор, потом запись в БД" }
    ],
    priorities: [
      "Переносить активные сделки, partial cycles, заметки и operational rules без ручной пересборки.",
      "Честно показывать пробелы старого кэша: где не хватает телефонов, серийников или свободного парка.",
      "Держать importer tolerant к боевым артефактам вроде поврежденного JSON с лишними скобками."
    ],
    modules: ["ImportService", "NotificationService", "RentalService", "BuyoutService", "AuditService"]
  },
  statistics: {
    slug: "statistics",
    eyebrow: "Business Intelligence",
    title: "Статистика бизнеса без бухгалтерской тяжести",
    summary: "Раздел дает быстрый управленческий обзор: выручка, аренда, выкуп, просрочка, свободные велосипеды, ремонты и нагрузка на парк.",
    metrics: [
      { label: "KPI", value: "Realtime-ready", note: "на основе CRM-сделок и проводок" },
      { label: "Парковая загрузка", value: "Visible", note: "свободные, в аренде, в ремонте" },
      { label: "Менеджеры", value: "Measured", note: "эффективность и скорость закрытия" }
    ],
    priorities: [
      "Сделать mobile-first карточки KPI и упрощенные графики.",
      "Отдельно показать расходы на ремонт и проблемную технику.",
      "Не считать критичную аналитику на frontend."
    ],
    modules: ["StatisticsService", "FinanceService", "FleetService"]
  },
  documents: {
    slug: "documents",
    eyebrow: "DOCX Templates",
    title: "Документы вокруг шаблонов, а не ручной верстки",
    summary: "На старте ключевой приоритет — DOCX-конструктор с переменными и генерацией договоров, актов выдачи и возврата.",
    metrics: [
      { label: "Формат", value: "DOCX first", note: "Word-шаблоны вместо PDF-hardcode" },
      { label: "История", value: "Tracked", note: "генерации и итоговые файлы" },
      { label: "Печать", value: "Ready", note: "из карточки клиента и сделки" }
    ],
    priorities: [
      "Поддержать загрузку шаблона и понятный гайд по переменным.",
      "Привязать сгенерированный документ к клиенту и сделке.",
      "Подготовить архитектуру под договор выкупа и допсоглашения."
    ],
    modules: ["DocumentService", "ClientService", "RentalService", "BuyoutService"]
  },
  users: {
    slug: "users",
    eyebrow: "RBAC",
    title: "Гибкие роли и backend-права",
    summary: "Права должны регулировать разделы, действия, точки, финансы и документы. Никакой жестко зашитой модели ролей.",
    metrics: [
      { label: "Model", value: "roles + permissions", note: "как в зрелых SaaS B2B" },
      { label: "Scopes", value: "Branch-aware", note: "ограничения по точкам и зонам" },
      { label: "Audit", value: "Mandatory", note: "критичные действия пишутся в журнал" }
    ],
    priorities: [
      "Проверка прав только на backend, не на уровне скрытия кнопок.",
      "Критичные действия должны уметь требовать причину.",
      "Support / impersonation допустим только для владельца SaaS."
    ],
    modules: ["AuthService", "UserService", "RolePermissionService", "AuditService"]
  },
  settings: {
    slug: "settings",
    eyebrow: "System Settings",
    title: "Интеграции, импорт и операционные настройки",
    summary: "В этом разделе живут импорт из МойСклад, Telegram-сценарии, документы, ветвление по филиалам и SaaS-ограничения компании.",
    metrics: [
      { label: "Import", value: "Dry-run", note: "mapping, preview, dedupe" },
      { label: "Notifications", value: "Scenario-based", note: "Telegram first" },
      { label: "Files", value: "Storage-aware", note: "локально или S3-compatible" }
    ],
    priorities: [
      "Использовать текущий notification-engine как референс, не изобретать заново.",
      "Подготовить набор tenant-настроек без критичных JSON-хранилищ.",
      "Держать все ключевые интеграции внутри backend-контуров."
    ],
    modules: ["ImportService", "NotificationService", "DocumentService", "TenantService"]
  },
  saas: {
    slug: "saas",
    eyebrow: "SaaS Control Room",
    title: "Управление компаниями и тарифами продукта",
    summary: "Супер-админка нужна для создания компаний, ручного управления тарифом, безопасного support-доступа и диагностики инстансов.",
    metrics: [
      { label: "Companies", value: "Multi-tenant", note: "полная изоляция данных" },
      { label: "Tariffs", value: "Manual first", note: "с запасом под будущую оплату" },
      { label: "Support", value: "Safe", note: "impersonation только для SaaS owner" }
    ],
    priorities: [
      "Видеть статус подписки, ограничения и ключевые интеграции компании.",
      "Управлять доступом компании вручную на старте.",
      "Подготовить поддержку дальнейшей автоматической оплаты SaaS."
    ],
    modules: ["TenantService", "SubscriptionService", "AuditService"]
  }
};
