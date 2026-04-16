# API Map

Это не полный swagger и не попытка документировать вообще все.  
Здесь перечислены ключевые current CRM-роуты, которые чаще всего нужны новому разработчику.

## Базовые адреса

- API base: `http://localhost:4200/api/v1`
- health: `GET /system/health`

## Meta и bootstrap

- `GET /meta/product`
- `GET /meta/modules`
- `GET /meta/navigation`
- `GET /meta/schema`
- `GET /meta/roadmap`
- `GET /meta/progress`

Используются для диагностики, навигации и status/reference экранов.

## Auth и actor

- `GET /auth/status`
- `POST /auth/login`
- `POST /auth/bootstrap`
- `POST /auth/logout`
- `GET /auth/me`

UI consumers:
- `apps/crm-web/lib/auth-api.ts`
- `apps/crm-web/components/crm-shell.tsx`

## Orders

- `GET /orders`
- `GET /orders/workspace`
- `POST /orders`

UI consumers:
- `apps/crm-web/components/orders-live-panel.tsx`
- `apps/crm-web/components/order-create-form.tsx`
- `apps/crm-web/lib/orders-api.ts`
- `apps/crm-web/lib/order-create-api.ts`

## Rentals

- `GET /rentals`
- `GET /rentals/:rentalId`
- `POST /rentals/:rentalId/payments`
- `POST /rentals/:rentalId/deposits/receive`
- `POST /rentals/:rentalId/deposits/refund`
- `POST /rentals/:rentalId/penalties/manual`
- `POST /rentals/:rentalId/penalties/auto-run`
- `POST /rentals/:rentalId/penalties/:penaltyId/pay`

UI consumers:
- `apps/crm-web/components/rentals-live-panel.tsx`
- `apps/crm-web/components/rental-detail-panel.tsx`
- `apps/crm-web/components/deal-payment-action.tsx`
- `apps/crm-web/components/rental-deposit-action.tsx`
- `apps/crm-web/components/rental-penalty-action.tsx`

Critical backend:
- `apps/crm-api/src/modules/rentals/router.ts`
- `apps/crm-api/src/modules/finance/service.ts`
- `apps/crm-api/src/modules/deals/schedule-service.ts`

## Buyouts

- `GET /buyouts`
- `GET /buyouts/:buyoutId`
- `POST /buyouts/:buyoutId/payments`
- `POST /buyouts/:buyoutId/penalties/manual`
- `POST /buyouts/:buyoutId/penalties/:penaltyId/pay`

UI consumers:
- `apps/crm-web/components/buyouts-live-panel.tsx`
- `apps/crm-web/components/buyout-detail-panel.tsx`
- `apps/crm-web/components/deal-payment-action.tsx`
- `apps/crm-web/components/buyout-penalty-action.tsx`

Critical backend:
- `apps/crm-api/src/modules/buyouts/router.ts`
- `apps/crm-api/src/modules/finance/service.ts`
- `apps/crm-api/src/modules/deals/schedule-service.ts`

## Unified payment

Это не отдельный пользовательский UI route, а backend/business-level сценарий в finance service, который разносит один платеж на:
- оплату сделки;
- оплату штрафов.

Если нужно разбираться с “одной оплатой, которая дала несколько finance rows”, смотреть:
- `apps/crm-api/src/modules/finance/service.ts`

## Clients

- `GET /clients`
- `GET /clients/:clientId`
- `POST /clients`
- `POST /clients/sync-legacy-profiles`

UI consumers:
- `apps/crm-web/components/clients-live-panel.tsx`
- `apps/crm-web/components/client-detail-panel.tsx`
- `apps/crm-web/components/client-create-form.tsx`

## Bikes / Fleet

- `GET /bikes`
- `GET /bikes/:bikeId`
- `GET /bikes/workspace`
- `POST /bikes`

UI consumers:
- `apps/crm-web/components/fleet-live-panel.tsx`
- `apps/crm-web/components/bike-detail-panel.tsx`
- `apps/crm-web/components/bike-form.tsx`

## Repairs

- `GET /repairs`
- `POST /repairs`
- related bike repair actions live in repair/fleet domain routers

UI consumers:
- `apps/crm-web/components/repairs-live-panel.tsx`

## Banks

- `GET /banks`
- `POST /banks`
- `PATCH /banks/:bankId`

UI consumers:
- `apps/crm-web/components/banks-live-panel.tsx`

## Finance

- `GET /finance/workspace`
- `GET /finance/transactions`
- `GET /finance/export.csv`
- `POST /finance/articles`
- `PATCH /finance/articles/:articleId`
- `POST /finance/manual-transactions`
- `POST /finance/transactions/:transactionId/reverse`
- `POST /finance/transactions/:transactionId/reconcile`

UI consumers:
- `apps/crm-web/components/finance-live-panel.tsx`
- `apps/crm-web/components/finance-manual-transaction-panel.tsx`
- `apps/crm-web/components/finance-registry-actions.tsx`
- `apps/crm-web/lib/finance-api.ts`

Critical backend:
- `apps/crm-api/src/modules/finance/router.ts`
- `apps/crm-api/src/modules/finance/service.ts`
- `apps/crm-api/src/modules/finance/articles.ts`

## Documents

- `GET /documents/placeholders`
- `GET /documents/preview-values`
- `GET /documents/templates`
- `POST /documents/templates`
- `PATCH /documents/templates/:templateId`
- `GET /documents/templates/:templateId/manifest`
- `GET /documents/templates/:templateId/preview`
- `POST /documents/templates/:templateId/generate-draft`
- `GET /documents/registry`
- `GET /documents/:documentId/download`
- `GET /documents/templates/:templateId/download`
- `PUT /documents/templates/:templateId/content`

UI consumers:
- `apps/crm-web/components/documents-live-panel.tsx`
- `apps/crm-web/components/documents-template-workbench.tsx`
- `apps/crm-web/components/deal-document-action.tsx`
- `apps/crm-web/lib/documents-api.ts`

Critical backend:
- `apps/crm-api/src/modules/documents/router.ts`
- `apps/crm-api/src/modules/documents/template-renderer.ts`

## Imports и legacy bridge

- `GET /legacy/overview`
- `GET /legacy/orders`
- `POST /imports/legacy/dry-run`
- `POST /imports/legacy/commit`
- `GET /imports`
- `GET /imports/progress`

UI consumers:
- `apps/crm-web/components/legacy-import-dashboard.tsx`
- `apps/crm-web/lib/legacy-api.ts`

Critical backend:
- `apps/crm-api/src/modules/legacy/router.ts`
- `apps/crm-api/src/modules/legacy/legacy-source.ts`
- `apps/crm-api/src/modules/imports/router.ts`
- `apps/crm-api/src/modules/imports/service.ts`

## Equipment

- `GET /equipment/catalog`

UI consumers:
- `apps/crm-web/components/equipment-catalog-panel.tsx`
- `apps/crm-web/lib/equipment-api.ts`

## Tariffs

- `GET /tariffs`
- `POST /tariffs`
- `PATCH /tariffs/:tariffId`

UI consumers:
- `apps/crm-web/components/tariffs-live-panel.tsx`
- `apps/crm-web/lib/tariffs-api.ts`

## Users / permissions

- `GET /users/workspace`
- `POST /users`
- `PATCH /users/:userId`
- related permissions live in `users/permissions.ts`

UI consumers:
- `apps/crm-web/components/users-live-panel.tsx`
- `apps/crm-web/lib/users-api.ts`

## Notifications / GPS / Settings

- notifications workspace routes
- telegram QR / password / reset routes
- GPS workspace routes and binding-related operations

UI consumers:
- `apps/crm-web/components/notifications-settings-panel.tsx`
- `apps/crm-web/components/gps-settings-panel.tsx`
- `apps/crm-web/lib/notifications-api.ts`
- `apps/crm-web/lib/gps-api.ts`

## Где смотреть в первую очередь

Если неизвестно, какой route вызывает экран:

1. найдите экран в `apps/crm-web/app/(app)`
2. откройте главный panel/detail component
3. посмотрите используемый loader в `apps/crm-web/lib`
4. по URL этого loader идите в `apps/crm-api/src/modules/*/router.ts`
