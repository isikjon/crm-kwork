# Known Issues

Этот документ нужен не как список всех возможных проблем, а как карта риска для нового разработчика.

## Do Not Break

Короткая версия:
- schedule logic
- unified payment / bundle
- deposit flow
- penalty flow
- documents preview / generate
- legacy import bridge

## Что лучше не трогать без понимания

### 1. Schedule logic

Файлы:
- `apps/crm-api/src/modules/deals/schedule-service.ts`
- `apps/crm-api/src/modules/deals/lifecycle-service.ts`
- `apps/crm-api/src/modules/finance/service.ts`

Почему рискованно:
- график влияет на `nextPaymentAt`, долг, overdue, статус сделки;
- частичная оплата и rebuild графика пересчитывают сразу несколько snapshot-полей;
- неправильное изменение легко ломает аренду и выкуп неочевидным образом.

### 2. Unified payment

Файл:
- `apps/crm-api/src/modules/finance/service.ts`

Почему рискованно:
- один пользовательский платеж может создавать несколько finance rows;
- есть bundle / external reference;
- reversal и audit нужно мыслить по каждой transaction row, а не только по общей сумме.

### 3. Deposit / penalty flow

Файлы:
- `apps/crm-web/components/rental-deposit-action.tsx`
- `apps/crm-web/components/rental-penalty-action.tsx`
- `apps/crm-web/components/buyout-penalty-action.tsx`
- `apps/crm-api/src/modules/finance/service.ts`

Почему рискованно:
- начисление штрафа и его оплата — разные операции;
- прием и возврат залога — разные money facts;
- это напрямую влияет на finance registry и snapshot сделки.

### 4. Documents preview / generate

Файлы:
- `apps/crm-api/src/modules/documents/router.ts`
- `apps/crm-api/src/modules/documents/template-renderer.ts`
- `apps/crm-web/components/deal-document-action.tsx`

Почему рискованно:
- `/documents` и deal-card решают разные задачи;
- `.txt` и `.docx` поддерживаются по-разному;
- DOCX preview/generate использует safe pipeline и имеет ограничения Word XML.

### 5. Legacy import bridge

Файлы:
- `apps/crm-api/src/modules/imports/service.ts`
- `apps/crm-api/src/modules/legacy/legacy-source.ts`
- `docs/LEGACY_DATA_BRIDGE.md`

Почему рискованно:
- код держит совместимость с legacy operational JSON;
- часть safe-поведения завязана на грязные реальные данные старой CRM;
- ошибка в bridge может ударить по import dry-run, commit и legacy hydration.

## Safe-pass / временные ограничения

### Documents

- editor-first UI уже упрощен, но `.docx` по-прежнему работает через safe-flow;
- inline preview для `.txt` сильнее, чем для `.docx`;
- DOCX placeholders, разорванные Word по XML-runs, все равно нужно проверять вручную.

### Finance

- current finance реестр сделан как рабочий ledger CRM, а не как полная бухгалтерия;
- не стоит превращать его в новый accounting engine без отдельного проекта решения.

### Import

- import bridge — это слой совместимости, а не финальная forever-архитектура;
- в нем допустимы defensive fixes, но опасно “упростить” его без проверки на реальных legacy-файлах.

## Технический долг

- корневой репозиторий все еще хранит рядом current и legacy контуры, поэтому новый разработчик может по ошибке зайти не туда
- часть env и docker-настроек все еще завязана на абсолютные локальные пути к legacy data
- нет одного большого автотестового контура, который безопасно покрывает все money/document/import сценарии
- часть review-friendly display labels решается на UI-слое, а не в одном центральном mapping-модуле

## Operational assumptions

- `crm-api` ожидает рабочий PostgreSQL и Redis
- для `.docx` нужны системные `zip` и `unzip`
- часть development/review сценариев использует tenant-specific данные, которые могут не существовать в пустой локальной БД

## Как работать безопаснее

Перед изменениями в чувствительных местах:

1. прочитайте `docs/BUSINESS_LOGIC.md`
2. найдите раздел в `docs/MODULE_MAP.md`
3. проверьте связанный backend router/service
4. если затронуты payments/documents/import, протестируйте сценарий руками в UI

## Когда особенно нужна осторожность

- меняете расчет графика или cadence
- меняете posting payment flow
- меняете split одного платежа на несколько finance rows
- меняете выдачу/возврат залога
- меняете оплату штрафа
- меняете preview/generate документов
- меняете import commit и rebuild schedule после импорта
