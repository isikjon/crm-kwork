# CRM аренды и выкупа велосипедов

Это монорепозиторий CRM для бизнеса по аренде и выкупу велосипедов. Текущий рабочий продукт живет в двух приложениях:

- `apps/crm-api` — backend на `Express + TypeScript + Prisma`
- `apps/crm-web` — frontend на `Next.js`

В репозитории также остались legacy-приложения:

- `apps/backend`
- `apps/dashboard`

Их не нужно воспринимать как основной текущий продукт. Они используются как reference и как источник части legacy-данных для bridge/import flow.

Первый документ для нового разработчика: [docs/START_HERE.md](docs/START_HERE.md)

## Where To Start First

Если вы frontend-разработчик:
- начните с `apps/crm-web/app/(app)` и `apps/crm-web/components`
- затем откройте `docs/MODULE_MAP.md`

Если вы backend-разработчик:
- начните с `apps/crm-api/src/modules`
- затем откройте `docs/ARCHITECTURE.md` и `docs/API_MAP.md`

Если нужно править заказы и сделки:
- смотрите `docs/MODULE_MAP.md`
- ключевые backend-узлы: `apps/crm-api/src/modules/orders`, `apps/crm-api/src/modules/rentals`, `apps/crm-api/src/modules/buyouts`, `apps/crm-api/src/modules/deals`
- ключевые frontend-узлы: `apps/crm-web/components/orders-live-panel.tsx`, `apps/crm-web/components/rental-detail-panel.tsx`, `apps/crm-web/components/buyout-detail-panel.tsx`

Если нужно править документы:
- сначала прочитайте `docs/BUSINESS_LOGIC.md` раздел `Документы`
- затем смотрите `apps/crm-web/components/documents-live-panel.tsx`, `apps/crm-web/components/documents-template-workbench.tsx`
- на backend: `apps/crm-api/src/modules/documents/router.ts`, `apps/crm-api/src/modules/documents/template-renderer.ts`

Если нужно править финансы:
- сначала прочитайте `docs/BUSINESS_LOGIC.md` раздел `Финансы`
- затем смотрите `apps/crm-web/components/finance-live-panel.tsx`
- на backend: `apps/crm-api/src/modules/finance/router.ts`, `apps/crm-api/src/modules/finance/service.ts`

## Current Vs Legacy

Текущий CRM-контур:
- `apps/crm-api`
- `apps/crm-web`

Legacy/reference контур:
- `apps/backend`
- `apps/dashboard`
- `docs/CRM_RUNBOOK.md`
- `docs/NEW_CRM_FOUNDATION.md`
- `docs/LEGACY_DATA_BRIDGE.md`

Если вы не уверены, куда идти, почти всегда начинайте с `crm-api` и `crm-web`.

## Быстрый запуск

### Локально

1. Установите зависимости:

```bash
npm install
```

2. Подготовьте env:

```bash
cp apps/crm-api/.env.example apps/crm-api/.env
cp apps/crm-web/.env.local.example apps/crm-web/.env.local
```

3. Сгенерируйте Prisma client:

```bash
npm run crm:prisma:generate
```

4. Поднимите PostgreSQL и Redis:

- либо локально вручную;
- либо через Docker Compose из `docker-compose.crm.yml`.

5. Запустите current CRM:

```bash
npm run dev:crm
```

6. Проверьте:

- CRM API: `http://localhost:4200/api/v1/system/health`
- CRM Web: `http://localhost:3100`

### Через Docker

```bash
docker compose -f docker-compose.crm.yml up --build
```

Адреса:
- CRM API: `http://localhost:4200/api/v1/system/health`
- CRM Web: `http://localhost:3100`

## Важные команды

```bash
npm run dev:crm
npm run build:crm
npm run lint:crm
npm run typecheck:crm
npm run crm:prisma:generate
npm run crm:prisma:validate
```

## Структура репозитория

```text
apps/
  backend/      # legacy backend, reference only
  dashboard/    # legacy dashboard, reference only
  crm-api/      # current backend
  crm-web/      # current frontend
docs/           # handover docs + historical reference docs
docker-compose.crm.yml
```

## Где что лежит

- UI-роуты current CRM: `apps/crm-web/app/(app)`
- основные current CRM-компоненты: `apps/crm-web/components`
- frontend data-loaders: `apps/crm-web/lib`
- backend HTTP-роутеры: `apps/crm-api/src/modules/*/router.ts`
- backend business logic: `apps/crm-api/src/modules/*/service.ts` и `apps/crm-api/src/modules/deals/*`

## Handover Docs

- [docs/START_HERE.md](docs/START_HERE.md) — быстрый маршрут входа в проект, critical flows, do not break и typical tasks
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — общая архитектура и разделение current/legacy
- [docs/BUSINESS_LOGIC.md](docs/BUSINESS_LOGIC.md) — бизнес-логика аренды, выкупа, штрафов, залогов, документов и финансов
- [docs/MODULE_MAP.md](docs/MODULE_MAP.md) — карта разделов UI, модулей и точек входа
- [docs/API_MAP.md](docs/API_MAP.md) — основные API-роуты и их назначение
- [docs/SETUP.md](docs/SETUP.md) — prerequisites, env, dev-run, docker-run и проверки
- [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — что рискованно трогать без понимания и где уже есть технические ограничения

## Что лучше не трогать без понимания

Сначала прочитайте [docs/START_HERE.md](docs/START_HERE.md) и [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md). Особенно внимательно:

- schedule logic
- unified payment
- deposit / penalty flow
- documents preview / generate
- legacy import bridge

## Исторические документы

Эти документы не удалены, но они уже не должны быть первой точкой входа:

- [docs/CRM_RUNBOOK.md](docs/CRM_RUNBOOK.md)
- [docs/NEW_CRM_FOUNDATION.md](docs/NEW_CRM_FOUNDATION.md)
- [docs/LEGACY_DATA_BRIDGE.md](docs/LEGACY_DATA_BRIDGE.md)

Используйте их как reference/history после того, как прочитали текущий handover-набор выше.
# crm-kwork
