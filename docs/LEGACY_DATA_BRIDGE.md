# Legacy Data Bridge

## Что это

`apps/crm-api/src/modules/legacy` — это первый рабочий мост между старой CRM и новой CRM в папке `CRM Велосипеды`.

Он не превращает старую систему в источник истины, а помогает безопасно вынуть из нее то, что уже накоплено:

- сделки
- partial payments
- заметки
- battery counters
- demand sync markers
- business rules из runtime-конфига

## Откуда читаются данные

По умолчанию:

`/Users/Thompson/Documents/codex project/New project/apps/backend/data`

Путь можно переопределить через `LEGACY_CRM_DATA_DIR`.

## Что намеренно не переносится автоматически

- Telegram API credentials
- Telegram session string
- StarLine secret
- любые другие секреты из legacy-конфига

## Что уже умеет bridge

- показывать статус файлов old CRM
- считать количество сделок, клиентов, partial cycles и operational notes
- вытаскивать serviceDays и buyout payment presets
- переживать поврежденный JSON в `rental-partial-payments.json`
- отдавать sample order preview для нового import UI

## Следующий шаг

Следующий backend-этап — это не просто `preview`, а запись legacy-данных в PostgreSQL:

1. создать import job
2. записать client stubs
3. записать rental / buyout deals
4. пересобрать графики в новой доменной модели
5. проставить audit trail миграции
