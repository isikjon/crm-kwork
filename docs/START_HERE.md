# Start Here

Это быстрый вход в current CRM для нового разработчика.  
Цель: за первые 15–30 минут понять, что запускать, что читать и куда идти по коду.

## Первые 15 минут

1. Откройте `README.md`
2. Откройте `docs/SETUP.md`
3. Поднимите current CRM:

```bash
npm install
cp apps/crm-api/.env.example apps/crm-api/.env
cp apps/crm-web/.env.local.example apps/crm-web/.env.local
npm run crm:prisma:generate
npm run dev:crm
```

4. Проверьте:
- `http://localhost:4200/api/v1/system/health`
- `http://localhost:3100`

5. Затем откройте:
- `docs/MODULE_MAP.md` — если нужно быстро идти в код
- `docs/BUSINESS_LOGIC.md` — если нужно быстро понять бизнес-смысл
- `docs/ARCHITECTURE.md` — если нужен общий технический контур

## Current CRM vs Legacy

Current CRM:
- `apps/crm-api`
- `apps/crm-web`

Legacy / reference:
- `apps/backend`
- `apps/dashboard`

Если не уверены, куда идти, почти всегда начинайте с `crm-api` и `crm-web`.

## Куда идти по разделам

- Заказы: `apps/crm-web/components/orders-live-panel.tsx`, `apps/crm-api/src/modules/orders/router.ts`
- Аренда / выкуп: `rental-detail-panel.tsx`, `buyout-detail-panel.tsx`, `apps/crm-api/src/modules/rentals/router.ts`, `apps/crm-api/src/modules/buyouts/router.ts`
- Документы: `documents-live-panel.tsx`, `documents-template-workbench.tsx`, `apps/crm-api/src/modules/documents/router.ts`
- Финансы: `finance-live-panel.tsx`, `apps/crm-api/src/modules/finance/service.ts`
- Клиенты: `clients-live-panel.tsx`, `client-detail-panel.tsx`, `apps/crm-api/src/modules/clients/router.ts`
- Банки: `banks-live-panel.tsx`, `apps/crm-api/src/modules/banks/router.ts`

## Critical Flows

- Заказ / сделка  
  UI: `orders-live-panel.tsx`, `rental-detail-panel.tsx`, `buyout-detail-panel.tsx`  
  API / риск: `orders/router.ts`, `deals/create-service.ts`, `deals/lifecycle-service.ts`, `deals/schedule-service.ts`

- Unified payment  
  UI: deal card payment actions и finance registry  
  API / риск: `finance/service.ts`, особенно `postUnifiedOrderPayment(...)`

- Штрафы  
  UI: `rental-penalty-action.tsx`, `buyout-penalty-action.tsx`  
  API / риск: `rentals/router.ts`, `buyouts/router.ts`, `finance/service.ts`

- Залоги  
  UI: `rental-deposit-action.tsx`  
  API / риск: `rentals/router.ts`, `finance/service.ts`

- Документы  
  UI: `/documents` и `deal-document-action.tsx`  
  API / риск: `documents/router.ts`, `documents/template-renderer.ts`

- Финансы  
  UI: `finance-live-panel.tsx`  
  API / риск: `finance/router.ts`, `finance/service.ts`, `finance/articles.ts`

## Do Not Break

Без понимания лучше не менять:
- schedule logic
- unified payment / bundle
- deposit flow
- penalty flow
- documents preview / generate
- legacy import bridge

Подробности и риски: `docs/KNOWN_ISSUES.md`

## Typical Tasks

- Нужно поменять экран заказа  
  Route / component: `app/(app)/orders/page.tsx`, `orders-live-panel.tsx`  
  Loader / API: `orders-api.ts`  
  Backend: `orders/router.ts`

- Нужно править аренду / выкуп  
  Route / component: `rentals/[dealId]/page.tsx`, `buyouts/[dealId]/page.tsx`, detail panels  
  Loader / API: `rentals-api.ts`, `buyouts-api.ts`  
  Backend: `rentals/router.ts`, `buyouts/router.ts`, `deals/*`

- Нужно править документы  
  Route / component: `documents/page.tsx`, `documents-live-panel.tsx`, `documents-template-workbench.tsx`, `deal-document-action.tsx`  
  Loader / API: `documents-api.ts`  
  Backend: `documents/router.ts`, `documents/template-renderer.ts`

- Нужно править финансы  
  Route / component: `finance/page.tsx`, `finance-live-panel.tsx`  
  Loader / API: `finance-api.ts`  
  Backend: `finance/router.ts`, `finance/service.ts`

- Нужно править расчет графика  
  Route / component: detail panels сделок  
  Loader / API: `rentals-api.ts`, `buyouts-api.ts`  
  Backend: `deals/schedule-service.ts`, `deals/lifecycle-service.ts`, `finance/service.ts`

- Нужно править залог  
  Route / component: `rental-deposit-action.tsx`  
  Backend: `rentals/router.ts`, `finance/service.ts`

- Нужно править штрафы  
  Route / component: `rental-penalty-action.tsx`, `buyout-penalty-action.tsx`  
  Backend: `rentals/router.ts`, `buyouts/router.ts`, `finance/service.ts`

## Если нужен следующий слой

- Архитектура: `docs/ARCHITECTURE.md`
- Бизнес-логика: `docs/BUSINESS_LOGIC.md`
- Карта модулей: `docs/MODULE_MAP.md`
- Setup: `docs/SETUP.md`
- Полные риски: `docs/KNOWN_ISSUES.md`
