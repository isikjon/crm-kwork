# Module Map

Документ нужен как практическая карта: куда идти в коде, если нужно менять конкретный раздел CRM.

Если нужен самый быстрый вход в проект, сначала откройте `docs/START_HERE.md`.

## CRM shell и общая навигация

- UI route: `apps/crm-web/app/(app)/layout.tsx`
- shell: `apps/crm-web/components/crm-shell.tsx`
- nav config: `apps/crm-web/lib/site-data.ts`
- auth actor: `apps/crm-web/components/auth-actor-context.tsx`
- backend auth/runtime: `apps/crm-api/src/modules/auth/router.ts`, `apps/crm-api/src/modules/tenants/runtime.ts`, `apps/crm-api/src/modules/users/permissions.ts`

## Заказы

- UI route: `apps/crm-web/app/(app)/orders/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/orders-live-panel.tsx`
  - `apps/crm-web/components/orders-registry-client.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/orders-api.ts`
- backend:
  - `apps/crm-api/src/modules/orders/router.ts`
- сложная логика рядом:
  - `apps/crm-api/src/modules/deals/create-service.ts`
  - `apps/crm-api/src/modules/deals/lifecycle-service.ts`
  - `apps/crm-api/src/modules/deals/schedule-service.ts`

## Новый заказ

- UI route: `apps/crm-web/app/(app)/orders/new/page.tsx`
- компонент:
  - `apps/crm-web/components/order-create-form.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/order-create-api.ts`
- backend:
  - `apps/crm-api/src/modules/orders/router.ts`
  - `apps/crm-api/src/modules/deals/create-service.ts`

## Аренда

- UI routes:
  - `apps/crm-web/app/(app)/rentals/page.tsx`
  - `apps/crm-web/app/(app)/rentals/[dealId]/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/rentals-live-panel.tsx`
  - `apps/crm-web/components/rental-detail-panel.tsx`
  - `apps/crm-web/components/deal-context-panel.tsx`
  - `apps/crm-web/components/deal-payment-action.tsx`
  - `apps/crm-web/components/rental-deposit-action.tsx`
  - `apps/crm-web/components/rental-penalty-action.tsx`
  - `apps/crm-web/components/deal-document-action.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/rentals-api.ts`
- backend:
  - `apps/crm-api/src/modules/rentals/router.ts`
  - `apps/crm-api/src/modules/deals/schedule-service.ts`
  - `apps/crm-api/src/modules/finance/service.ts`

## Выкуп

- UI routes:
  - `apps/crm-web/app/(app)/buyouts/page.tsx`
  - `apps/crm-web/app/(app)/buyouts/[dealId]/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/buyouts-live-panel.tsx`
  - `apps/crm-web/components/buyout-detail-panel.tsx`
  - `apps/crm-web/components/deal-payment-action.tsx`
  - `apps/crm-web/components/buyout-penalty-action.tsx`
  - `apps/crm-web/components/deal-document-action.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/buyouts-api.ts`
- backend:
  - `apps/crm-api/src/modules/buyouts/router.ts`
  - `apps/crm-api/src/modules/deals/schedule-service.ts`
  - `apps/crm-api/src/modules/finance/service.ts`

## Клиенты

- UI routes:
  - `apps/crm-web/app/(app)/clients/page.tsx`
  - `apps/crm-web/app/(app)/clients/[clientId]/page.tsx`
  - `apps/crm-web/app/(app)/clients/new/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/clients-live-panel.tsx`
  - `apps/crm-web/components/client-detail-panel.tsx`
  - `apps/crm-web/components/client-create-form.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/clients-api.ts`
- backend:
  - `apps/crm-api/src/modules/clients/router.ts`
  - `apps/crm-api/src/modules/clients/legacy-counterparty-sync.ts`

## Велосипеды и парк

- UI routes:
  - `apps/crm-web/app/(app)/bikes/page.tsx`
  - `apps/crm-web/app/(app)/bikes/[bikeId]/page.tsx`
  - `apps/crm-web/app/(app)/bikes/new/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/fleet-live-panel.tsx`
  - `apps/crm-web/components/bike-detail-panel.tsx`
  - `apps/crm-web/components/bike-form.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/fleet-api.ts`
- backend:
  - `apps/crm-api/src/modules/fleet/router.ts`
  - `apps/crm-api/src/modules/fleet/bike-unit-classifier.ts`

## Ремонты

- UI route: `apps/crm-web/app/(app)/repairs/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/repairs-live-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/repairs-api.ts`
- backend:
  - `apps/crm-api/src/modules/repairs/router.ts`

## Банки

- UI route: `apps/crm-web/app/(app)/banks/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/banks-live-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/banks-api.ts`
- backend:
  - `apps/crm-api/src/modules/banks/router.ts`

## Документы

- UI route: `apps/crm-web/app/(app)/documents/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/documents-live-panel.tsx`
  - `apps/crm-web/components/documents-workspace-client.tsx`
  - `apps/crm-web/components/documents-template-workbench.tsx`
  - `apps/crm-web/components/deal-document-action.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/documents-api.ts`
- backend:
  - `apps/crm-api/src/modules/documents/router.ts`
  - `apps/crm-api/src/modules/documents/template-renderer.ts`
- где сложная логика:
  - placeholder catalog
  - preview/generate flow
  - `.txt` vs `.docx` ограничения

## Финансы

- UI route: `apps/crm-web/app/(app)/finance/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/finance-live-panel.tsx`
  - `apps/crm-web/components/finance-registry-actions.tsx`
  - `apps/crm-web/components/finance-manual-transaction-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/finance-api.ts`
- backend:
  - `apps/crm-api/src/modules/finance/router.ts`
  - `apps/crm-api/src/modules/finance/service.ts`
  - `apps/crm-api/src/modules/finance/articles.ts`
- где сложная логика:
  - unified payment
  - bundle/external reference
  - reversal
  - schedule/debt refresh after payment

## Импорт и legacy bridge

- UI route: `apps/crm-web/app/(app)/imports/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/legacy-import-dashboard.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/legacy-api.ts`
- backend:
  - `apps/crm-api/src/modules/imports/router.ts`
  - `apps/crm-api/src/modules/imports/service.ts`
  - `apps/crm-api/src/modules/legacy/router.ts`
  - `apps/crm-api/src/modules/legacy/legacy-source.ts`

## Оборудование

- UI route: `apps/crm-web/app/(app)/equipment/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/equipment-catalog-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/equipment-api.ts`
- backend:
  - `apps/crm-api/src/modules/equipment/router.ts`

## Тарифы

- UI route: `apps/crm-web/app/(app)/tariffs/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/tariffs-live-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/tariffs-api.ts`
- backend:
  - `apps/crm-api/src/modules/tariffs/router.ts`
  - `apps/crm-api/src/modules/tariffs/service.ts`

## Пользователи

- UI route: `apps/crm-web/app/(app)/users/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/users-live-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/users-api.ts`
- backend:
  - `apps/crm-api/src/modules/users/router.ts`
  - `apps/crm-api/src/modules/users/permissions.ts`

## Настройки, GPS и уведомления

- UI route: `apps/crm-web/app/(app)/settings/page.tsx`
- основные компоненты:
  - `apps/crm-web/components/gps-settings-panel.tsx`
  - `apps/crm-web/components/notifications-settings-panel.tsx`
- frontend loader/api:
  - `apps/crm-web/lib/gps-api.ts`
  - `apps/crm-web/lib/notifications-api.ts`
- backend:
  - `apps/crm-api/src/modules/gps/router.ts`
  - `apps/crm-api/src/modules/gps/service.ts`
  - `apps/crm-api/src/modules/notifications/router.ts`
  - `apps/crm-api/src/modules/notifications/service.ts`
  - `apps/crm-api/src/modules/notifications/telegram.ts`

## Meta / service endpoints

- backend root router:
  - `apps/crm-api/src/modules/router.ts`
- useful meta routes:
  - `/system/health`
  - `/meta/modules`
  - `/meta/navigation`
  - `/meta/schema`
  - `/meta/roadmap`
  - `/meta/progress`

## Где искать в первую очередь

Если проблема в UI:
- откройте route file в `app/(app)`
- потом главный компонент раздела в `components`
- потом data-loader в `lib`

Если проблема в поведении бизнес-логики:
- найдите соответствующий `router.ts`
- потом идите в `service.ts`
- для сделок почти всегда проверьте `src/modules/deals/*`

Если проблема затрагивает платежи, штрафы, залог или документы:
- сначала прочитайте `docs/BUSINESS_LOGIC.md`
- потом открывайте `finance/service.ts` или `documents/router.ts`
