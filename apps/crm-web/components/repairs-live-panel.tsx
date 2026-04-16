import { cookies } from "next/headers";
import { RepairCompleteAction } from "./repair-complete-action";
import { RepairCreateForm } from "./repair-create-form";
import { RepairLineItemAction } from "./repair-line-item-action";
import { type RepairsListData, loadRepairsWorkspace } from "../lib/repairs-api";

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round((kopecks ?? 0) / 100));
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

function formatRepairStatus(status: "OPEN" | "COMPLETED") {
  return status === "OPEN" ? "В работе" : "Завершен";
}

function formatBikeStatus(status: string) {
  switch (status) {
    case "AVAILABLE":
      return "Свободен";
    case "RESERVED":
      return "Забронирован";
    case "RENTED":
      return "В аренде";
    case "BUYOUT":
      return "В выкупе";
    case "RETURN_PENDING":
      return "Ожидает возврата";
    case "REPAIR":
      return "В ремонте";
    case "WRITTEN_OFF":
      return "Списан";
    default:
      return status;
  }
}

function buildRepairExpenseSummary(repair: RepairsListData["rows"][number]) {
  const expenseItems = repair.items.filter((item) => Boolean(item.transactionId) && item.amountKopecks > 0);
  const expenseAmountKopecks = expenseItems.reduce((total, item) => total + item.amountKopecks, 0);
  const bankLabels = Array.from(
    new Set(
      expenseItems
        .map((item) => item.bank?.name?.trim() ?? "")
        .filter(Boolean)
    )
  );

  return {
    expenseItems,
    expenseAmountKopecks,
    bankLabels,
    hasExpense: expenseItems.length > 0
  };
}

export async function RepairsLivePanel() {
  const { data, apiBase, error } = await loadRepairsWorkspace(cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Repairs API</div>
        <h3>Ремонты пока недоступны</h3>
        <p className="route-card-note">
          Проверь `crm-api`, Prisma sync и новый repair-модуль. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверь `http://localhost:4200/api/v1/system/health`.</li>
          <li>Если БД пустая, повтори `POST /api/v1/imports/legacy/commit`.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const openRepairs = data.repairs.rows.filter((repair) => repair.status === "OPEN");
  const completedRepairs = data.repairs.rows.filter((repair) => repair.status === "COMPLETED");
  const repairsWithExpense = data.repairs.rows.filter((repair) => buildRepairExpenseSummary(repair).hasExpense).length;

  return (
    <section className="section-stack repairs-screen">
      <section className="surface-card orders-simple-panel repairs-summary-panel">
        <div className="orders-simple-head">
          <div>
            <div className="surface-kicker">Ремонты</div>
            <h3>Рабочий реестр ремонтов</h3>
            <p className="route-card-note">
              {data.repairs.tenant.name} · {data.repairs.summary.openCount} в работе · {data.repairs.summary.completedCount} завершено
            </p>
          </div>
        </div>

        <div className="orders-simple-counters">
          <div className="orders-counter-card">
            <span>Открытые</span>
            <strong>{data.repairs.summary.openCount}</strong>
          </div>
          <div className="orders-counter-card">
            <span>Завершенные</span>
            <strong>{data.repairs.summary.completedCount}</strong>
          </div>
          <div className="orders-counter-card">
            <span>Всего</span>
            <strong>{data.repairs.total}</strong>
          </div>
          <div className="orders-counter-card">
            <span>Со списанием</span>
            <strong>{repairsWithExpense}</strong>
          </div>
        </div>
      </section>

      <RepairCreateForm banks={data.banks} />

      <section className="section-stack repairs-sections">
        <section className="surface-card repairs-section-card">
          <div className="surface-kicker">Открытые</div>
          <h3>В работе</h3>

          {openRepairs.length === 0 ? (
            <p className="route-card-note repairs-empty-note">Открытых ремонтов сейчас нет.</p>
          ) : (
            <div className="record-grid repairs-record-grid">
              {openRepairs.map((repair) => {
                const expenseSummary = buildRepairExpenseSummary(repair);

                return (
                  <article className="record-card repairs-record-card" id={`repair-${repair.id}`} key={repair.id}>
                  <div className="status-line">
                    <a className="record-title record-link" href={`/bikes/${repair.bikeUnit.id}`}>{repair.bikeUnit.title}</a>
                    <span>{formatRepairStatus(repair.status)}</span>
                  </div>
                  <div className="record-meta">
                    {repair.bikeUnit.article ?? repair.bikeUnit.internalCode} · {repair.title}
                  </div>
                  <div className="record-tags repairs-inline-tags">
                    <span className="tag-chip">{formatBikeStatus(repair.bikeUnit.status)}</span>
                    {expenseSummary.hasExpense ? (
                      <span className="tag-chip is-warning">Есть списание</span>
                    ) : (
                      <span className="tag-chip is-neutral">Пока без списания</span>
                    )}
                    <span className="tag-chip is-ok">После завершения: Свободен</span>
                  </div>
                  <div className="record-kpi-row">
                    <div className="record-kpi">
                      <span>Дата</span>
                      <strong>{formatDate(repair.serviceDate)}</strong>
                    </div>
                    <div className="record-kpi">
                      <span>Сумма</span>
                      <strong>{formatMoney(repair.costKopecks)}</strong>
                    </div>
                    <div className="record-kpi">
                      <span>Позиции</span>
                      <strong>{repair.items.length}</strong>
                    </div>
                    <div className="record-kpi">
                      <span>Списано</span>
                      <strong>{formatMoney(expenseSummary.expenseAmountKopecks)}</strong>
                    </div>
                  </div>

                  <div className="repairs-context-grid">
                    <div className="repairs-context-card">
                      <span>Велосипед</span>
                      <strong>{repair.bikeUnit.title}</strong>
                      <small>{formatBikeStatus(repair.bikeUnit.status)}</small>
                    </div>
                    <div className="repairs-context-card">
                      <span>Списание / банк</span>
                      <strong>
                        {expenseSummary.hasExpense
                          ? expenseSummary.bankLabels.join(", ")
                          : "Без списания"}
                      </strong>
                      <small>
                        {expenseSummary.hasExpense
                          ? `Расход проведен через банк · ${expenseSummary.expenseItems.length} поз.`
                          : "Можно добавить работу или запчасть без расхода, а списание провести позже."}
                      </small>
                    </div>
                    <div className="repairs-context-card">
                      <span>Завершение</span>
                      <strong>Вернет велосипед в парк</strong>
                      <small>Кнопка завершения переведет велосипед в статус “Свободен”.</small>
                    </div>
                  </div>

                  {repair.description ? (
                    <p className="route-card-note repairs-card-note">{repair.description}</p>
                  ) : null}

                  <div className="timeline-list repairs-timeline-list">
                    {repair.items.length > 0 ? repair.items.map((item) => (
                      <div className="timeline-item" key={item.id}>
                        <div>
                          {item.title} · {item.quantity} шт. · {formatMoney(item.amountKopecks)}
                        </div>
                        <div className="timeline-meta">
                          {item.transactionId
                            ? `Списано через ${item.bank?.name ?? "банк"}`
                            : "Без списания"} · {formatDate(item.createdAt)}
                        </div>
                      </div>
                    )) : (
                      <div className="timeline-item">
                        <div>Позиции еще не добавлены.</div>
                      </div>
                    )}
                  </div>

                  <RepairLineItemAction banks={data.banks} repairId={repair.id} />
                  <RepairCompleteAction repairId={repair.id} />
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="surface-card repairs-section-card">
          <div className="surface-kicker">История</div>
          <h3>Завершенные ремонты</h3>

          {completedRepairs.length === 0 ? (
            <p className="route-card-note repairs-empty-note">Завершенных ремонтов пока нет.</p>
          ) : (
            <div className="record-grid repairs-record-grid">
              {completedRepairs.map((repair) => {
                const expenseSummary = buildRepairExpenseSummary(repair);

                return (
                  <article className="record-card repairs-record-card" id={`repair-${repair.id}`} key={repair.id}>
                  <div className="status-line">
                    <a className="record-title record-link" href={`/bikes/${repair.bikeUnit.id}`}>{repair.bikeUnit.title}</a>
                    <span>{formatRepairStatus(repair.status)}</span>
                  </div>
                  <div className="record-meta">
                    {repair.bikeUnit.article ?? repair.bikeUnit.internalCode} · {repair.title}
                  </div>
                  <div className="record-tags repairs-inline-tags">
                    <span className="tag-chip is-ok">Завершен</span>
                    {expenseSummary.hasExpense ? (
                      <span className="tag-chip is-warning">
                        Списание: {expenseSummary.bankLabels.join(", ")}
                      </span>
                    ) : (
                      <span className="tag-chip is-neutral">Без списания</span>
                    )}
                  </div>
                  <div className="record-kpi-row">
                    <div className="record-kpi">
                      <span>Открыт</span>
                      <strong>{formatDate(repair.serviceDate)}</strong>
                    </div>
                    <div className="record-kpi">
                      <span>Завершен</span>
                      <strong>{formatDate(repair.completedAt)}</strong>
                    </div>
                    <div className="record-kpi">
                      <span>Сумма</span>
                      <strong>{formatMoney(repair.costKopecks)}</strong>
                    </div>
                  </div>
                  <p className="route-card-note repairs-card-note">
                    После завершения ремонт вернул велосипед в рабочий парк. Текущий статус велосипеда сейчас: <strong>{formatBikeStatus(repair.bikeUnit.status)}</strong>.
                  </p>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </section>
  );
}
