import Link from "next/link";
import { cookies } from "next/headers";
import { FinanceArticlesManager } from "./finance-articles-manager";
import { FinanceManualTransactionPanel } from "./finance-manual-transaction-panel";
import { FinanceRegistryToolbar, FinanceTransactionActions } from "./finance-registry-actions";
import { loadFinanceWorkspace, type FinanceWorkspaceData } from "../lib/finance-api";

type SearchParamsMap = Record<string, string | string[] | undefined>;
type FinanceTransactionRow = FinanceWorkspaceData["registry"]["rows"][number];
type FinanceArticle = FinanceWorkspaceData["filters"]["articles"][number];
type FinanceContour = "RENTAL" | "BUYOUT" | "PENALTY" | "DEPOSIT" | "BUSINESS_EXPENSE" | "OTHER";

const QUICK_FILTER_CONTOURS = [
  { code: "RENTAL", label: "Аренда" },
  { code: "BUYOUT", label: "Выкуп" },
  { code: "PENALTY", label: "Штрафы" },
  { code: "DEPOSIT", label: "Залоги" }
] as const;

function formatMoney(kopecks: number, options?: { signed?: boolean }) {
  const absolute = new Intl.NumberFormat("ru-RU").format(Math.round(Math.abs(kopecks) / 100));
  if (!options?.signed) {
    return `${absolute} ₽`;
  }

  return `${kopecks >= 0 ? "+" : "-"}${absolute} ₽`;
}

function formatDate(value: string | null) {
  if (!value) {
    return "не задана";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function formatTime(value: string | null) {
  if (!value) {
    return "время не указано";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function formatPaymentMethod(value: string) {
  switch (value) {
    case "BANK":
      return "Перевод";
    case "CASH":
      return "Наличные";
    default:
      return value;
  }
}

function formatDirectionLabel(direction: string) {
  return direction === "INCOME" ? "Приход" : "Расход";
}

function formatStatusLabel(status: string) {
  switch (status) {
    case "POSTED":
      return "Проведено";
    case "DRAFT":
      return "Черновик";
    case "CANCELED":
      return "Отменено";
    default:
      return status;
  }
}

function getSearchParamValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function normalizeSearchParams(searchParams?: SearchParamsMap) {
  const normalized = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(searchParams ?? {})) {
    const value = getSearchParamValue(rawValue).trim();
    if (value) {
      normalized.set(key, value);
    }
  }

  return normalized;
}

function buildFinanceHref(
  currentParams: URLSearchParams,
  updates: Record<string, string | null | undefined>,
  keysToClear: string[] = []
) {
  const next = new URLSearchParams(currentParams.toString());

  for (const key of keysToClear) {
    next.delete(key);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      next.delete(key);
      continue;
    }

    next.set(key, value);
  }

  const query = next.toString();
  return query ? `/finance?${query}` : "/finance";
}

function findArticleBySystemKey(articles: FinanceArticle[], systemKey: string) {
  return articles.find((article) => article.systemKey === systemKey) ?? null;
}

function resolveContour(transaction: FinanceTransactionRow): FinanceContour {
  const systemKey = transaction.article?.systemKey ?? null;

  if (
    transaction.type === "PENALTY_ACCRUAL"
    || transaction.type === "PENALTY_PAYMENT_IN"
    || systemKey === "income_penalty"
  ) {
    return "PENALTY";
  }

  if (
    transaction.type === "DEPOSIT_IN"
    || transaction.type === "DEPOSIT_REFUND_OUT"
    || transaction.type === "REFUND_OUT"
    || systemKey === "income_deposit"
    || systemKey === "expense_deposit_refund"
  ) {
    return "DEPOSIT";
  }

  if (
    transaction.deal?.kind === "BUYOUT"
    || transaction.type === "BUYOUT_PAYMENT_IN"
    || transaction.type === "DOWN_PAYMENT_IN"
    || systemKey === "income_buyout"
  ) {
    return "BUYOUT";
  }

  if (
    transaction.deal?.kind === "RENTAL"
    || transaction.type === "RENTAL_PAYMENT_IN"
    || systemKey === "income_rental"
  ) {
    return "RENTAL";
  }

  if (
    transaction.direction === "EXPENSE"
    && (
      transaction.type === "REPAIR_EXPENSE"
      || transaction.type === "SERVICE_EXPENSE"
      || transaction.type === "MANUAL_ADJUSTMENT"
      || transaction.type === "WRITE_OFF"
      || systemKey === "expense_repair"
      || systemKey === "expense_procurement"
      || systemKey === "expense_misc"
      || systemKey === "expense_admin"
      || systemKey === "expense_logistics"
    )
  ) {
    return "BUSINESS_EXPENSE";
  }

  return "OTHER";
}

function formatContourLabel(contour: FinanceContour, direction?: string) {
  switch (contour) {
    case "RENTAL":
      return "Аренда";
    case "BUYOUT":
      return "Выкуп";
    case "PENALTY":
      return "Штраф";
    case "DEPOSIT":
      return "Залог";
    case "BUSINESS_EXPENSE":
      return "Расход бизнеса";
    default:
      return direction === "EXPENSE" ? "Прочий расход" : "Прочий приход";
  }
}

function formatTransactionLabel(transaction: FinanceTransactionRow) {
  const contour = resolveContour(transaction);
  const systemKey = transaction.article?.systemKey ?? null;

  switch (transaction.type) {
    case "RENTAL_PAYMENT_IN":
      return "Оплата аренды";
    case "BUYOUT_PAYMENT_IN":
      return "Оплата выкупа";
    case "PARTIAL_PAYMENT_IN":
      return contour === "BUYOUT" ? "Частичный платеж выкупа" : "Частичная оплата аренды";
    case "DOWN_PAYMENT_IN":
      return "Первый взнос";
    case "DEPOSIT_IN":
      return "Принят залог";
    case "DEPOSIT_REFUND_OUT":
      return "Возврат залога";
    case "PENALTY_PAYMENT_IN":
      return "Оплата штрафа";
    case "PENALTY_ACCRUAL":
      return "Начисление штрафа";
    case "REPAIR_EXPENSE":
      return "Ремонт";
    case "SERVICE_EXPENSE":
      return systemKey === "expense_logistics" ? "Логистика" : "Сервисный расход";
    case "MANUAL_ADJUSTMENT":
      return transaction.direction === "INCOME" ? "Прочий приход" : (transaction.article?.name ?? "Прочий расход");
    case "REFUND_OUT":
      return contour === "DEPOSIT" ? "Возврат залога" : "Возврат клиенту";
    case "WRITE_OFF":
      return "Списание";
    case "HOLD":
      return "Удержание";
    default:
      return transaction.article?.name ?? transaction.type;
  }
}

function formatArticleSecondaryLabel(transaction: FinanceTransactionRow) {
  if (transaction.article?.name) {
    return transaction.article.name;
  }

  return formatContourLabel(resolveContour(transaction), transaction.direction);
}

function formatOperationSecondaryLabel(transaction: FinanceTransactionRow) {
  const primary = formatTransactionLabel(transaction);
  const secondary = formatArticleSecondaryLabel(transaction);
  const contourLabel = formatContourLabel(resolveContour(transaction), transaction.direction);

  if (secondary === primary || secondary === contourLabel) {
    return null;
  }

  return secondary;
}

function formatTransactionLinkage(transaction: FinanceTransactionRow) {
  if (transaction.reversalOfTransaction) {
    return `Сторно к #${shortId(transaction.reversalOfTransaction.id)}`;
  }

  if (transaction.reversedByTransaction) {
    return `Есть сторно #${shortId(transaction.reversedByTransaction.id)}`;
  }

  if (transaction.externalReference) {
    return `Пакет #${shortId(transaction.externalReference)}`;
  }

  return null;
}

function formatTransactionLinkageNote(transaction: FinanceTransactionRow) {
  if (transaction.reversalOfTransaction) {
    return `Оригинал от ${formatDate(transaction.reversalOfTransaction.happenedAt)}`;
  }

  if (transaction.reversedByTransaction) {
    return `Сторно от ${formatDate(transaction.reversedByTransaction.happenedAt)}`;
  }

  if (transaction.externalReference) {
    return "Одна оплата разбита на несколько записей";
  }

  return null;
}

function buildDealHref(transaction: FinanceTransactionRow) {
  if (!transaction.deal) {
    return null;
  }

  return transaction.deal.kind === "RENTAL"
    ? `/rentals/${transaction.deal.id}`
    : `/buyouts/${transaction.deal.id}`;
}

function computeNoteLabel(transaction: FinanceTransactionRow) {
  return transaction.comment?.trim() || transaction.sourceLabel?.trim() || "Без комментария";
}

export async function FinanceLivePanel(props: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const { data, apiBase, error } = await loadFinanceWorkspace(props.searchParams, cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Finance API</div>
        <h3>Финансовый реестр пока недоступен</h3>
        <p className="route-card-note">
          Этот раздел требует рабочую session-cookie, право `finance.view` и read-model денег.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверьте активную сессию и доступ к финансам.</li>
          <li>Если это новый tenant, сначала выполните bootstrap/login.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const currentParams = normalizeSearchParams(props.searchParams);
  const repairArticle = findArticleBySystemKey(data.filters.articles, "expense_repair");
  const logisticsArticle = findArticleBySystemKey(data.filters.articles, "expense_logistics");
  const selectedDirection = data.registry.filters.direction;
  const selectedContour = data.registry.filters.contour;
  const selectedArticleId = data.registry.filters.articleId;
  const contourSummaryCards = QUICK_FILTER_CONTOURS.map((item) => {
    const amountKopecks = data.registry.rows.reduce((total, transaction) => {
      if (resolveContour(transaction) !== item.code) {
        return total;
      }

      return total + (transaction.direction === "INCOME" ? transaction.amountKopecks : -transaction.amountKopecks);
    }, 0);

    return {
      label: item.label,
      value: formatMoney(amountKopecks)
    };
  });
  const advancedFiltersCount = [
    data.registry.filters.paymentMethod,
    data.registry.filters.status,
    data.registry.filters.amountFrom,
    data.registry.filters.amountTo,
    data.registry.filters.dateFrom,
    data.registry.filters.dateTo,
    data.registry.filters.branchId,
    data.registry.filters.type,
    data.registry.filters.reconciled == null ? "" : String(data.registry.filters.reconciled),
    data.registry.filters.dealKind
  ].filter((value) => Boolean(value)).length;
  const summaryCards = [
    {
      label: "Приход",
      value: formatMoney(data.registry.summary.incomeKopecks),
      tone: "income"
    },
    {
      label: "Расход",
      value: formatMoney(data.registry.summary.expenseKopecks),
      tone: "expense"
    },
    {
      label: "Чистый результат",
      value: formatMoney(data.registry.summary.netKopecks),
      tone: data.registry.summary.netKopecks >= 0 ? "net-positive" : "net-negative"
    }
  ] as const;
  const exportFilters = {
    q: data.registry.query,
    type: data.registry.filters.type,
    contour: data.registry.filters.contour,
    status: data.registry.filters.status,
    direction: data.registry.filters.direction,
    paymentMethod: data.registry.filters.paymentMethod,
    articleId: data.registry.filters.articleId,
    bankId: data.registry.filters.bankId,
    clientId: data.registry.filters.clientId,
    branchId: data.registry.filters.branchId,
    dealKind: data.registry.filters.dealKind,
    dealNumber: data.registry.filters.dealNumber,
    amountFrom: data.registry.filters.amountFrom,
    amountTo: data.registry.filters.amountTo,
    reconciled: data.registry.filters.reconciled == null ? null : String(data.registry.filters.reconciled),
    period: data.registry.filters.period,
    dateFrom: data.registry.filters.dateFrom,
    dateTo: data.registry.filters.dateTo
  };
  const quickFilters = [
    {
      label: "Сегодня",
      href: buildFinanceHref(currentParams, { period: "TODAY", dateFrom: null, dateTo: null }),
      active: data.registry.filters.period === "TODAY" && !data.registry.filters.dateFrom && !data.registry.filters.dateTo
    },
    {
      label: "Неделя",
      href: buildFinanceHref(currentParams, { period: "LAST_7_DAYS", dateFrom: null, dateTo: null }),
      active: data.registry.filters.period === "LAST_7_DAYS"
    },
    {
      label: "Месяц",
      href: buildFinanceHref(currentParams, { period: "THIS_MONTH", dateFrom: null, dateTo: null }),
      active: data.registry.filters.period === "THIS_MONTH"
    },
    {
      label: "Только приход",
      href: buildFinanceHref(currentParams, { direction: "INCOME" }),
      active: data.registry.filters.direction === "INCOME"
    },
    {
      label: "Только расход",
      href: buildFinanceHref(currentParams, { direction: "EXPENSE" }),
      active: data.registry.filters.direction === "EXPENSE"
    },
    ...QUICK_FILTER_CONTOURS.map((item) => ({
      label: item.label,
      href: buildFinanceHref(currentParams, { contour: item.code, articleId: null }),
      active: selectedContour === item.code
    })),
    {
      label: "Ремонт",
      href: buildFinanceHref(currentParams, {
        contour: "BUSINESS_EXPENSE",
        direction: "EXPENSE",
        articleId: repairArticle?.id ?? null
      }),
      active: selectedArticleId === repairArticle?.id
    },
    {
      label: "Логистика",
      href: buildFinanceHref(currentParams, {
        contour: "BUSINESS_EXPENSE",
        direction: "EXPENSE",
        articleId: logisticsArticle?.id ?? null
      }),
      active: selectedArticleId === logisticsArticle?.id
    }
  ];
  const quickPrimaryFilters = quickFilters.slice(0, 5);
  const quickBusinessFilters = quickFilters.slice(5);

  return (
    <section className="section-stack">
      <section className="surface-card finance-registry-card">
        <div className="finance-registry-head">
          <div className="finance-registry-head-copy">
            <div className="surface-kicker">Финансы</div>
            <h3>Журнал денежных операций</h3>
          </div>

          <div className="finance-summary-stack">
            <div className="finance-summary-compact">
              {summaryCards.map((item) => (
                <div className={`finance-summary-chip is-${item.tone}`} key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>

            <div className="finance-summary-secondary">
              {contourSummaryCards.map((item) => (
                <div className="finance-summary-mini" key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="finance-quick-groups">
          <div className="finance-quick-filters">
            {quickPrimaryFilters.map((item) => (
              <Link
                className={`finance-quick-chip${item.active ? " is-active" : ""}`}
                href={item.href}
                key={item.label}
              >
                {item.label}
              </Link>
            ))}
          </div>

          <div className="finance-quick-filters finance-quick-filters-business">
            {quickBusinessFilters.map((item) => (
              <Link
                className={`finance-quick-chip${item.active ? " is-active" : ""}`}
                href={item.href}
                key={item.label}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        <form className="finance-toolbar-shell" method="GET">
          <div className="finance-toolbar-main">
            <label className="action-field finance-field-search">
              <span>Поиск</span>
              <input
                className="action-input"
                name="q"
                defaultValue={data.registry.query ?? ""}
                placeholder="Номер, клиент, комментарий, назначение"
              />
            </label>

            <label className="action-field">
              <span>Период</span>
              <select className="action-input" name="period" defaultValue={data.registry.filters.period ?? ""}>
                <option value="">Все даты</option>
                {data.filters.periods.map((period) => (
                  <option key={period.code} value={period.code}>{period.label}</option>
                ))}
              </select>
            </label>

            <label className="action-field">
              <span>Направление</span>
              <select className="action-input" name="direction" defaultValue={selectedDirection ?? ""}>
                <option value="">Все</option>
                {data.filters.directions.map((item) => (
                  <option key={item.code} value={item.code}>{item.label}</option>
                ))}
              </select>
            </label>

            <label className="action-field">
              <span>Контур денег</span>
              <select className="action-input" name="contour" defaultValue={selectedContour ?? ""}>
                <option value="">Все контуры</option>
                <option value="RENTAL">Аренда</option>
                <option value="BUYOUT">Выкуп</option>
                <option value="PENALTY">Штрафы</option>
                <option value="DEPOSIT">Залоги</option>
                <option value="BUSINESS_EXPENSE">Расходы бизнеса</option>
              </select>
            </label>

            <label className="action-field finance-field-article">
              <span>Статья</span>
              <select className="action-input" name="articleId" defaultValue={selectedArticleId ?? ""}>
                <option value="">Все статьи</option>
                {data.filters.articles
                  .filter((article) => (selectedDirection ? article.direction === selectedDirection : true))
                  .map((article) => (
                    <option key={article.id} value={article.id}>
                      {article.name}{article.isActive ? "" : " · архив"}
                    </option>
                  ))}
              </select>
            </label>

            <label className="action-field">
              <span>Банк</span>
              <select className="action-input" name="bankId" defaultValue={data.registry.filters.bankId ?? ""}>
                <option value="">Все банки</option>
                {data.filters.banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>{bank.name}</option>
                ))}
              </select>
            </label>

            <label className="action-field">
              <span>Клиент</span>
              <select className="action-input" name="clientId" defaultValue={data.registry.filters.clientId ?? ""}>
                <option value="">Все клиенты</option>
                {data.filters.clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.fullName}{client.branch ? ` · ${client.branch.name}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="action-field">
              <span>Заказ</span>
              <input
                className="action-input"
                name="dealNumber"
                defaultValue={data.registry.filters.dealNumber ?? ""}
                placeholder="Номер сделки"
              />
            </label>
          </div>

          <details className="finance-toolbar-more">
            <summary>Еще фильтры{advancedFiltersCount ? ` · ${advancedFiltersCount}` : ""}</summary>
            <div className="finance-toolbar-more-grid">
              <label className="action-field">
                <span>Способ</span>
                <select className="action-input" name="paymentMethod" defaultValue={data.registry.filters.paymentMethod ?? ""}>
                  <option value="">Все способы</option>
                  {data.filters.paymentMethods.map((method) => (
                    <option key={method.code} value={method.code}>{method.label}</option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Статус</span>
                <select className="action-input" name="status" defaultValue={data.registry.filters.status ?? ""}>
                  <option value="">Все статусы</option>
                  {data.filters.statuses.map((item) => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Сделка</span>
                <select className="action-input" name="dealKind" defaultValue={data.registry.filters.dealKind ?? ""}>
                  <option value="">Все сделки</option>
                  {data.filters.dealKinds.map((item) => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Сверка</span>
                <select
                  className="action-input"
                  name="reconciled"
                  defaultValue={data.registry.filters.reconciled == null ? "" : String(data.registry.filters.reconciled)}
                >
                  <option value="">Все</option>
                  {data.filters.reconciliationStates.map((item) => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Сумма от</span>
                <input
                  className="action-input"
                  inputMode="decimal"
                  name="amountFrom"
                  defaultValue={data.registry.filters.amountFrom ?? ""}
                  placeholder="0"
                />
              </label>

              <label className="action-field">
                <span>Сумма до</span>
                <input
                  className="action-input"
                  inputMode="decimal"
                  name="amountTo"
                  defaultValue={data.registry.filters.amountTo ?? ""}
                  placeholder="0"
                />
              </label>

              <label className="action-field">
                <span>С даты</span>
                <input className="action-input" type="date" name="dateFrom" defaultValue={data.registry.filters.dateFrom ?? ""} />
              </label>

              <label className="action-field">
                <span>По дату</span>
                <input className="action-input" type="date" name="dateTo" defaultValue={data.registry.filters.dateTo ?? ""} />
              </label>

              <label className="action-field">
                <span>Точка</span>
                <select className="action-input" name="branchId" defaultValue={data.registry.filters.branchId ?? ""}>
                  <option value="">Все точки</option>
                  {data.filters.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Raw type</span>
                <select className="action-input" name="type" defaultValue={data.registry.filters.type ?? ""}>
                  <option value="">Все типы</option>
                  {Array.from(new Set(data.registry.rows.map((item) => item.type))).map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>

          <div className="finance-toolbar-footer">
            <div className="finance-toolbar-submit">
              <button className="action-button" type="submit">Применить</button>
              <Link className="inline-text-button" href="/finance">Сбросить</Link>
            </div>
          </div>
        </form>

        <div className="finance-ledger-topbar">
          <div className="finance-ledger-topbar-copy">
            <strong>В выборке: {data.registry.total} операций</strong>
          </div>
          <FinanceRegistryToolbar filters={exportFilters} manualEntryHref="#finance-manual-entry" />
        </div>

        {data.registry.rows.length === 0 ? (
          <div className="finance-empty-card">
            <strong>По текущим фильтрам движений не найдено.</strong>
            <span>Измените период, контур денег или поиск, чтобы увидеть операции.</span>
          </div>
        ) : (
          <div className="finance-ledger-table">
            <div className="finance-ledger-header">
              <span>Дата / время</span>
              <span>Деньги</span>
              <span>Операция</span>
              <span>Заказ / клиент</span>
              <span>Способ / банк</span>
              <span>Комментарий</span>
              <span>Статус</span>
              <span>Действия</span>
            </div>

            {data.registry.rows.map((transaction) => {
              const contour = resolveContour(transaction);
              const dealHref = buildDealHref(transaction);
              const linkage = formatTransactionLinkage(transaction);
              const linkageNote = formatTransactionLinkageNote(transaction);
              const operationSecondaryLabel = formatOperationSecondaryLabel(transaction);
              const orderClientSummary = transaction.client?.fullName ?? "Клиент не указан";

              return (
                <article className="finance-ledger-row" key={transaction.id}>
                  <div className="finance-ledger-cell" data-label="Дата / время">
                    <strong>{formatDate(transaction.happenedAt)}</strong>
                    <span>{formatTime(transaction.happenedAt)}</span>
                  </div>

                  <div className="finance-ledger-cell finance-ledger-cell-money" data-label="Деньги">
                    <strong className={transaction.direction === "INCOME" ? "is-income" : "is-expense"}>
                      {formatMoney(transaction.direction === "INCOME" ? transaction.amountKopecks : -transaction.amountKopecks, { signed: true })}
                    </strong>
                    <div className="finance-inline-badges">
                      <span className={`finance-direction-badge is-${transaction.direction === "INCOME" ? "income" : "expense"}`}>
                        {formatDirectionLabel(transaction.direction)}
                      </span>
                      {transaction.correctionKind === "REVERSAL" ? (
                        <span className="finance-support-badge">Коррекция</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="finance-ledger-cell finance-ledger-cell-operation" data-label="Операция">
                    <strong>{formatTransactionLabel(transaction)}</strong>
                    <div className="finance-inline-badges">
                      <span className="finance-contour-badge">{formatContourLabel(contour, transaction.direction)}</span>
                    </div>
                    {operationSecondaryLabel ? <span>{operationSecondaryLabel}</span> : null}
                  </div>

                  <div className="finance-ledger-cell finance-ledger-cell-deal" data-label="Заказ / клиент">
                    {dealHref && transaction.deal ? (
                      <>
                        <Link className="finance-order-link" href={dealHref}>
                          {transaction.deal.dealNumber}
                        </Link>
                        <span>{transaction.deal.kind === "RENTAL" ? "Аренда" : "Выкуп"} · {orderClientSummary}</span>
                      </>
                    ) : (
                      <>
                        <strong>{transaction.sourceLabel ?? "Без заказа"}</strong>
                        <span>{orderClientSummary}</span>
                      </>
                    )}
                  </div>

                  <div className="finance-ledger-cell finance-ledger-cell-bank" data-label="Способ / банк">
                    <strong>{formatPaymentMethod(transaction.paymentMethod)}</strong>
                    <span>{transaction.bank?.name ?? "Без банка"}</span>
                  </div>

                  <div className="finance-ledger-cell finance-ledger-cell-note" data-label="Комментарий">
                    <strong>{computeNoteLabel(transaction)}</strong>
                    {(linkage ?? linkageNote) ? <span>{linkage ?? linkageNote}</span> : null}
                  </div>

                  <div className="finance-ledger-cell" data-label="Статус">
                    <strong>{formatStatusLabel(transaction.status)}</strong>
                    <span>
                      {transaction.reconciledAt
                        ? `Сверено · ${formatDate(transaction.reconciledAt)}`
                        : "Не сверено"}
                    </span>
                  </div>

                  <div className="finance-ledger-cell finance-ledger-cell-actions" data-label="Действия">
                    <FinanceTransactionActions transaction={transaction} />
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {data.registry.reconciliation.banks.length > 0 ? (
          <details className="finance-secondary-details">
            <summary>Сверка по банкам</summary>
            <div className="finance-bank-summary-strip">
              {data.registry.reconciliation.banks.map((bank) => (
                <article className="finance-bank-summary-pill" key={bank.bankId ?? "cashless-none"}>
                  <strong>{bank.bankName}</strong>
                  <span>Сверено {formatMoney(bank.reconciledIncomeKopecks - bank.reconciledExpenseKopecks)}</span>
                  <span>Не сверено {formatMoney(bank.unreconciledIncomeKopecks - bank.unreconciledExpenseKopecks)}</span>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <FinanceManualTransactionPanel
        articles={data.filters.articles}
        banks={data.filters.banks}
        branches={data.filters.branches}
        clients={data.filters.clients}
      />

      <FinanceArticlesManager articles={data.filters.articles} />
    </section>
  );
}
