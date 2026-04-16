# CRM Runbook

> Этот документ оставлен как reference/history. Для входа нового разработчика сначала откройте `README.md`, `docs/ARCHITECTURE.md` и `docs/SETUP.md`.

## Что уже поднято

- `apps/crm-api` — отдельный backend foundation на `Express + TypeScript + Prisma`
- `apps/crm-web` — отдельный frontend foundation на `Next.js`
- `docker-compose.crm.yml` — dev-compose для PostgreSQL, Redis, CRM API и CRM Web

## Быстрый локальный запуск

1. Установить зависимости:

```bash
npm install
```

2. Сгенерировать Prisma client:

```bash
npm run crm:prisma:generate
```

3. Запустить новый CRM-контур:

```bash
npm run dev:crm
```

4. Или через Docker Compose:

```bash
docker compose -f docker-compose.crm.yml up
```

## Legacy bridge из старой CRM

Новый `crm-api` умеет читать живые operational JSON старой CRM напрямую из папки:

`/Users/Thompson/Documents/codex project/New project/apps/backend/data`

Для этого добавлена переменная:

```bash
LEGACY_CRM_DATA_DIR=/Users/Thompson/Documents/codex project/New project/apps/backend/data
```

В `docker-compose.crm.yml` эта папка уже проброшена в контейнер `crm-api` как read-only volume `/legacy-source`.

Для server-side fetch в `crm-web` используется:

```bash
CRM_API_INTERNAL_BASE=http://localhost:4200/api/v1
```

В Docker Compose он автоматически переключен на `http://crm-api:4200/api/v1`.

Используемые legacy-файлы:

- `orders.cache.json`
- `rental-partial-payments.json`
- `order-notes.json`
- `order-battery-counts.json`
- `manual-demand-sync.json`
- `notification-journal.json`
- `config.local.json`

REST endpoints legacy bridge:

- `GET /api/v1/legacy/overview`
- `GET /api/v1/legacy/orders?limit=6`
- `GET /api/v1/clients?tenantSlug=prokolesa`
- `GET /api/v1/bikes?tenantSlug=prokolesa`
- `GET /api/v1/rentals?tenantSlug=prokolesa`
- `GET /api/v1/rentals/:rentalId?tenantSlug=prokolesa`
- `POST /api/v1/rentals/:rentalId/payments`
- `GET /api/v1/buyouts?tenantSlug=prokolesa`
- `GET /api/v1/buyouts/:buyoutId?tenantSlug=prokolesa`
- `POST /api/v1/buyouts/:buyoutId/payments`
- `GET /api/v1/finance/transactions?tenantSlug=prokolesa`
- `GET /api/v1/banks?tenantSlug=prokolesa`
- `POST /api/v1/clients/sync-legacy-profiles`
- `GET /api/v1/documents/placeholders?tenantSlug=prokolesa&sourceEntityType=RENTAL`
- `GET /api/v1/documents/templates?tenantSlug=prokolesa&sourceEntityType=RENTAL`
- `POST /api/v1/documents/templates`
- `POST /api/v1/documents/templates/:templateId/generate-draft`
- `GET /api/v1/documents/:documentId/download?tenantSlug=prokolesa`
- `GET /api/v1/meta/progress`
- `GET /api/v1/imports/progress`
- `POST /api/v1/imports/legacy/dry-run`
- `POST /api/v1/imports/legacy/commit`
- `GET /api/v1/imports?tenantSlug=prokolesa`

Что bridge делает уже сейчас:

- читает живой кэш старой CRM без копирования в новую кодовую базу
- восстанавливает поврежденный `rental-partial-payments.json`, если в конце есть лишние `}`
- отдает safe overview по сделкам, partial cycles, заметкам, business rules и import targets
- не возвращает Telegram/StarLine секреты в ответ API
- умеет создавать dry-run import jobs в новой БД для tenant `prokolesa` или любого другого slug
- умеет записывать client, bike, rental, buyout и note stubs в PostgreSQL через commit import
- при commit перестраивает `payment_schedules` и `payment_schedule_items` для аренды и выкупа
- обновляет debt / overdue snapshot прямо в сделках после rebuild графика
- отдает detail view аренды и выкупа с графиком, заметками и operational summary для новых CRM pages
- умеет принимать posted payments по аренде и выкупу и писать их в `financial_transactions`
- после posted payment обновляет график, `nextPaymentAt`, debt snapshot сделки и debt snapshot клиента
- умеет подтягивать расширенный профиль клиента из реального контрагента МойСклад по `legacyReference`
- умеет принимать загруженный `.docx` или `.txt` шаблон, подставлять коды клиента/сделки и отдавать готовый файл на скачивание

Пример dry-run запроса:

```bash
curl -X POST http://localhost:4200/api/v1/imports/legacy/dry-run \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantSlug": "prokolesa",
    "tenantName": "ПРОКОЛЕСА",
    "entityTypes": ["clients", "rental_deals", "buyout_deals"]
  }'
```

Пример commit запроса:

```bash
curl -X POST http://localhost:4200/api/v1/imports/legacy/commit \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantSlug": "prokolesa",
    "tenantName": "ПРОКОЛЕСА",
    "entityTypes": ["clients", "rental_deals", "buyout_deals", "notes_and_operational_flags"]
  }'
```

Пример posted payment для аренды:

```bash
curl -X POST http://localhost:4200/api/v1/rentals/<rental-id>/payments \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantSlug": "prokolesa",
    "amountKopecks": 400000,
    "paymentMethod": "CASH",
    "comment": "Оплата в новой CRM"
  }'
```

Пример posted payment для выкупа:

```bash
curl -X POST http://localhost:4200/api/v1/buyouts/<buyout-id>/payments \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantSlug": "prokolesa",
    "amountKopecks": 500000,
    "paymentMethod": "BANK",
    "bankId": "<bank-id>",
    "comment": "Платеж по графику выкупа"
  }'
```

## Базовые адреса

- CRM API: `http://localhost:4200`
- CRM API meta: `http://localhost:4200/api/v1/meta/modules`
- CRM API legacy overview: `http://localhost:4200/api/v1/legacy/overview`
- CRM Web: `http://localhost:3100`
- CRM Web rental detail: `http://localhost:3100/rentals/<deal-id>`
- CRM Web buyout detail: `http://localhost:3100/buyouts/<deal-id>`
- CRM Web finance registry: `http://localhost:3100/finance`
- CRM Web banks registry: `http://localhost:3100/banks`
- CRM Web documents: `http://localhost:3100/documents`

## Следующий этап реализации

- добавить detail view и CRUD-модули сделок поверх новых payment schedules
- поднять migrations и seed для SaaS owner / permissions
- собрать новый transactional payment flow для rental / buyout / deposit / penalty
- перенести Telegram notification reference logic в новый доменный NotificationService
- реализовать auth, роли и tenant bootstrap
