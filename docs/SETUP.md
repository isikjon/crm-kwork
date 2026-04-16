# Setup

## Что нужно установить

Минимум для локальной разработки:

- Node.js `20+`
- npm
- PostgreSQL `16+` или Docker
- Redis `7+` или Docker
- Prisma CLI через зависимости проекта

Для document flow с `.docx` на локальном backend также нужны системные утилиты:

- `zip`
- `unzip`

`template-renderer.ts` использует их для safe preview/generate DOCX-шаблонов.

## Установка зависимостей

Из корня проекта:

```bash
npm install
```

## Env-файлы

### CRM API

Скопируйте:

```bash
cp apps/crm-api/.env.example apps/crm-api/.env
```

Ключевые переменные:

- `PORT=4200`
- `DATABASE_URL=postgresql://crm:crm@localhost:5433/prokolesa_crm?schema=public`
- `REDIS_URL=redis://localhost:6380`
- `FILE_STORAGE_ROOT=./storage`
- `JWT_SECRET=change-me`
- `LEGACY_CRM_DATA_DIR=...`

`LEGACY_CRM_DATA_DIR` нужен для:
- import dry-run / commit
- части legacy hydration
- некоторых document/client enrichment сценариев

### CRM Web

Скопируйте:

```bash
cp apps/crm-web/.env.local.example apps/crm-web/.env.local
```

Ключевые переменные:

- `CRM_API_INTERNAL_BASE=http://localhost:4200/api/v1`
- `NEXT_PUBLIC_CRM_API_BASE=http://localhost:4200/api/v1`

## Локальный запуск без Docker

1. Установите зависимости:

```bash
npm install
```

2. Подготовьте env-файлы.

3. Поднимите PostgreSQL и Redis.

4. Сгенерируйте Prisma client:

```bash
npm run crm:prisma:generate
```

5. При первом запуске примените схему:

```bash
npm run prisma:deploy -w apps/crm-api
```

Если локальная БД пустая и вы работаете только на dev-окружении:

```bash
npm run prisma:migrate -w apps/crm-api
```

или при необходимости синхронизации схемы без готовых миграций:

```bash
npx prisma db push --schema apps/crm-api/prisma/schema.prisma
```

6. Запустите current CRM:

```bash
npm run dev:crm
```

7. Проверьте:

- API health: `http://localhost:4200/api/v1/system/health`
- Web: `http://localhost:3100`

## Запуск через Docker

Из корня проекта:

```bash
docker compose -f docker-compose.crm.yml up --build
```

Compose поднимает:

- `crm-db`
- `crm-redis`
- `crm-api`
- `crm-web`

Порты:

- API: `4200`
- Web: `3100`
- Postgres: `5433`
- Redis: `6380`

## Что делает Docker Compose автоматически

Контейнер `crm-api`:
- генерирует Prisma client
- делает `db push`
- запускает `tsx watch src/server.ts`

Контейнер `crm-web`:
- поднимает `next dev` на `3100`

## Как проверить, что проект реально поднялся

Минимальный smoke-check:

1. API health:

```bash
curl http://localhost:4200/api/v1/system/health
```

2. Frontend:
- откройте `http://localhost:3100`

3. Проверка meta routes:

```bash
curl http://localhost:4200/api/v1/meta/modules
```

4. Проверка docs/finance/documents flows:
- `/orders`
- `/documents`
- `/finance`

Если все открывается и данные подгружаются, current CRM поднят корректно.

## Prisma и БД

Полезные команды:

```bash
npm run crm:prisma:generate
npm run crm:prisma:validate
npm run prisma:migrate -w apps/crm-api
npm run prisma:deploy -w apps/crm-api
```

Схема:
- `apps/crm-api/prisma/schema.prisma`

## Legacy data и import flow

Если `LEGACY_CRM_DATA_DIR` недоступен:
- import screen будет работать не полностью;
- часть enrichment/hydration сценариев станет недоступна;
- legacy bridge routes будут возвращать ошибки или пустые данные.

Это не всегда ломает весь current CRM, но ломает важные migration/reference сценарии.

## Если используется review/staging tenant

В коде по умолчанию часто фигурирует `tenantSlug=prokolesa`.  
В review-сценариях может использоваться отдельный tenant, если он уже есть в вашей локальной БД или review-окружении.

Если вы не уверены, начинайте с `prokolesa`.

## Частые проблемы

### 1. `crm-web` не видит `crm-api`

Проверьте:
- `NEXT_PUBLIC_CRM_API_BASE`
- `CRM_API_INTERNAL_BASE`
- health route `http://localhost:4200/api/v1/system/health`

### 2. Документы `.docx` не генерируются локально

Проверьте наличие:
- `zip`
- `unzip`

### 3. Import/legacy screens пустые

Проверьте:
- `LEGACY_CRM_DATA_DIR`
- наличие legacy data-папки
- volume mount в `docker-compose.crm.yml`

### 4. Данные не появляются после первого запуска

Проверьте:
- что Prisma client сгенерирован;
- что схема применена к БД;
- что `crm-api` стартовал без ошибок.

## Что читать дальше

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/MODULE_MAP.md`
- `docs/KNOWN_ISSUES.md`
