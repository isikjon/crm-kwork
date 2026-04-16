# New CRM Foundation

> Этот документ оставлен как historical/reference snapshot. Для текущего handover-набора сначала откройте `README.md`, `docs/ARCHITECTURE.md`, `docs/BUSINESS_LOGIC.md` и `docs/MODULE_MAP.md`.

## Как я понял продукт

Нужен отдельный SaaS-продукт для аренды и выкупа электровелосипедов, где главная сущность — сделка аренды или сделка выкупа конкретного велосипеда конкретному клиенту. МойСклад нужен только как стартовый источник данных для импорта, а новая CRM должна стать основным контуром для клиентов, парка, платежей, залогов, штрафов, ремонтов, документов, уведомлений, статистики и multi-tenant-управления.

## Что беру из текущего проекта как референс

- Логика Telegram-уведомлений и сценариев: `apps/backend/src/services/notificationService.ts`
- Логика персональных Telegram-привязок: `apps/backend/src/services/telegramBindingsStore.ts`
- Поведение partial payment и сдвига платежной даты: `apps/backend/src/services/paymentService.ts`
- Текущий операционный UX и mobile-first приемы: `apps/dashboard/components/OrdersTable.tsx`
- Tenant/runtime foundation: `apps/backend/src/companies/runtimeContext.ts`

## Что уже подключено из старой CRM

В новую CRM уже добавлен `legacy bridge`, который читает живую data-папку старой системы и готовит данные для миграции:

- `orders.cache.json` как источник сделок и клиентов-черновиков
- `rental-partial-payments.json` как источник partial cycles
- `order-notes.json` и embedded notes как операционные пометки
- `order-battery-counts.json` как дополнительные данные по выдаче
- `manual-demand-sync.json` как сигнал о demand history
- `config.local.json` как источник serviceDays, buyout presets и notification rules

Bridge специально не копирует секреты Telegram и StarLine в новую CRM.

## Верхнеуровневая архитектура модулей

- `AuthService`
- `TenantService`
- `SubscriptionService`
- `UserService`
- `RolePermissionService`
- `BranchService`
- `ClientService`
- `FleetService`
- `RepairService`
- `RentalService`
- `BuyoutService`
- `ScheduleService`
- `BankService`
- `FinanceService`
- `DepositService`
- `PenaltyService`
- `DocumentService`
- `NotificationService`
- `StatisticsService`
- `ImportService`
- `AuditService`

## Верхнеуровневая схема БД

Базовые доменные группы:

- SaaS и доступ: `tenants`, `subscription_plans`, `tenant_subscriptions`, `users`, `roles`, `permissions`, `role_permissions`, `user_roles`
- Операционный контур: `branches`, `clients`, `client_contacts`, `client_identity_data`, `bike_models`, `bike_units`, `repairs`
- Сделки: `rentals`, `buyouts`, `payment_schedules`, `payment_schedule_items`, `deposits`, `penalties`
- Финансы: `banks`, `bank_assets`, `financial_transactions`
- Документы и коммуникации: `document_templates`, `documents`, `document_generations`, `notification_scenarios`, `notifications`
- Сервисные контуры: `notes`, `audit_logs`, `imports`, `import_jobs`, `integrations`, `settings`

## Frontend-роуты новой CRM

- `/` — дашборд
- `/clients`
- `/bikes`
- `/repairs`
- `/rentals`
- `/buyouts`
- `/banks`
- `/finance`
- `/imports`
- `/statistics`
- `/documents`
- `/users`
- `/settings`
- `/saas`

## MVP

- Auth
- Tenants
- Users
- Roles + permissions
- Branches
- Clients
- Bike units
- Repairs
- Rentals
- Buyouts
- Payment schedules
- Banks
- Finance registry
- DOCX template foundation
- Audit log
- Basic statistics
- Import from MoySklad
- Telegram scenario foundation
- Mobile-ready UI

## Этап 2

- Усложнение тарифов и выкупных схем
- Автоштрафы с гибкими правилами
- Расширенная экономика по технике
- Полноценный конструктор документов
- Подготовка WhatsApp/SMS каналов
- Support / impersonation
- Ограничения по тарифам SaaS

## Принятые допущения

- ORM для нового продукта: Prisma
- Основная БД: PostgreSQL
- Redis сразу закладывается как инфраструктурный слой, даже если часть модулей пока работает без него
- Файлы документов и QR на первом этапе хранятся в файловом storage с возможностью перехода на S3-совместимое хранилище
- Новая CRM живет в отдельных workspace-приложениях `apps/crm-api` и `apps/crm-web`, а текущий дашборд остается референсом и источником сценариев для переноса
- Legacy import на первом этапе читает старую CRM напрямую из `LEGACY_CRM_DATA_DIR` и отдает preview-данные до записи в PostgreSQL
