import { cookies } from "next/headers";
import { ClientProfileAction } from "./client-profile-action";
import { ClientPassportAction } from "./client-passport-action";
import { ClientRelativesAction } from "./client-relatives-action";
import { loadClientDetail } from "../lib/clients-api";

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

function formatDate(value: string | null) {
  if (!value) {
    return "Без даты";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function formatClientType(clientType: "INDIVIDUAL" | "LEGAL_ENTITY") {
  return clientType === "LEGAL_ENTITY" ? "Юр. лицо" : "Физ. лицо";
}

function formatDealStatus(status: string) {
  const map: Record<string, string> = {
    NEW: "Новая",
    ACTIVE: "Активна",
    OVERDUE: "Просрочка",
    HOLD: "Удержание",
    RETURN_PREP: "Готовится возврат",
    COMPLETED: "Завершена",
    CANCELED: "Отменена",
    CLOSED: "Закрыт",
    TERMINATED: "Расторгнут"
  };

  return map[status] ?? status;
}

function formatPaymentType(type: string) {
  const map: Record<string, string> = {
    RENTAL_PAYMENT_IN: "Аренда",
    BUYOUT_PAYMENT_IN: "Выкуп",
    DOWN_PAYMENT_IN: "Первый взнос",
    PARTIAL_PAYMENT_IN: "Частичная",
    PENALTY_PAYMENT_IN: "Штраф"
  };

  return map[type] ?? type;
}

export async function ClientDetailPanel(props: {
  clientId: string;
}) {
  const { data, apiBase, error } = await loadClientDetail(props.clientId, cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card client-page-panel">
        <div className="surface-kicker">Клиент</div>
        <h3>Карточка клиента пока недоступна</h3>
        <p className="route-card-note">
          Проверь `crm-api` и наличие клиента в базе. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Вернуться в список клиентов и открыть запись заново.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const { client, activeDeals, recentPayments } = data.detail;
  const identityAccess = data.detail.identityAccess;
  const workplaces = data.workplaces.rows;

  return (
    <div className="client-page-shell">
      <section className="surface-card client-page-panel">
        <a className="detail-back-link" href="/clients">
          {"<-"} Назад к списку клиентов
        </a>

        <div className="client-page-head">
          <div>
            <div className="surface-kicker">Карточка клиента</div>
            <h3>{client.fullName}</h3>
            <p className="route-card-note">
              {formatClientType(client.clientType)}
              {client.primaryPhone ? ` · ${client.primaryPhone}` : ""}
              {client.telegramHandle ? ` · ${client.telegramHandle}` : ""}
            </p>
          </div>
        </div>

        <div className="record-kpi-row client-page-kpis client-page-kpis-4">
          <div className="record-kpi">
            <span>Долг</span>
            <strong>{formatMoney(client.currentDebtKopecks)}</strong>
          </div>
          <div className="record-kpi">
            <span>Принес денег</span>
            <strong>{formatMoney(client.moneyBroughtKopecks)}</strong>
          </div>
          <div className="record-kpi">
            <span>Дней в аренде ~</span>
            <strong>{client.rentalDaysTotal}</strong>
          </div>
          <div className="record-kpi">
            <span>Активные сделки</span>
            <strong>{client.activeDealsCount}</strong>
          </div>
        </div>

        <div className="record-tags">
          <span className="tag-chip">{formatClientType(client.clientType)}</span>
          <span className={`tag-chip${client.isThief ? " is-danger" : client.isProblemClient ? " is-warning" : " is-ok"}`}>
            {client.clientState}
          </span>
          {(client.isProblemClient || client.isThief) && client.flagComment ? (
            <span className={`tag-chip${client.isThief ? " is-danger" : " is-neutral"}`}>{client.flagComment}</span>
          ) : null}
          {client.clientType === "LEGAL_ENTITY" && client.taxId ? <span className="tag-chip">ИНН: {client.taxId}</span> : null}
          {client.clientType === "INDIVIDUAL" && client.workplace ? <span className="tag-chip">Работа: {client.workplace}</span> : null}
          {client.clientType === "INDIVIDUAL" && client.courierId ? <span className="tag-chip">ID курьера: {client.courierId}</span> : null}
        </div>
      </section>

      <div className="client-detail-layout">
        <div className="client-side-stack">
          {client.clientType === "INDIVIDUAL" && identityAccess.canView ? (
            <section className="surface-card client-side-panel">
              <div className="surface-kicker">Паспорт</div>
              <h3>Паспортные данные</h3>
              <ClientPassportAction clientId={client.id} compact identityData={client.identityData} />
            </section>
          ) : client.clientType === "INDIVIDUAL" ? (
            <section className="surface-card client-side-panel">
              <div className="surface-kicker">Паспорт</div>
              <h3>Паспортные данные скрыты</h3>
              <p className="route-card-note">Для просмотра и изменения паспортных и адресных данных нужно отдельное право `clients.identity.view`.</p>
            </section>
          ) : null}

          <section className="surface-card client-side-panel">
            <div className="surface-kicker">Контакты доверия</div>
            <h3>Родственники</h3>
            <ClientRelativesAction clientId={client.id} compact openByDefault rows={client.relatives} />
          </section>
        </div>

        <section className="surface-card client-page-panel-form client-main-panel">
          <div className="surface-kicker">Данные клиента</div>
          <h3>Карточка клиента</h3>
          <div className="client-main-grid">
            <ClientProfileAction
              client={client}
              compact
              openRequisites
              options={workplaces}
            />

            <div className="client-insight-stack">
              <section className="client-insight-card">
                <div className="client-insight-head">
                  <span>Активные сделки</span>
                  <strong>{activeDeals.length}</strong>
                </div>

                {activeDeals.length > 0 ? (
                  <div className="client-insight-list">
                    {activeDeals.map((deal) => (
                      <a
                        className="client-insight-row"
                        href={deal.kind === "RENTAL" ? `/rentals/${deal.id}` : `/buyouts/${deal.id}`}
                        key={`${deal.kind}-${deal.id}`}
                      >
                        <div>
                          <strong>{deal.kind === "RENTAL" ? "Аренда" : "Выкуп"} · {deal.dealNumber}</strong>
                          <span>{formatDealStatus(deal.status)} · {deal.nextPaymentAt ? `след. оплата ${formatDate(deal.nextPaymentAt)}` : "без даты оплаты"}</span>
                        </div>
                        <div className="client-insight-side">
                          <strong>{formatMoney(deal.debtKopecks)}</strong>
                          <span title={deal.bikeLabel}>{deal.bikeArticle ?? deal.bikeLabel}</span>
                        </div>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="route-card-note">Сейчас активных сделок нет.</p>
                )}
              </section>

              <section className="client-insight-card">
                <div className="client-insight-head">
                  <span>Последние оплаты</span>
                  <strong>{recentPayments.length}</strong>
                </div>

                {recentPayments.length > 0 ? (
                  <div className="client-insight-list">
                    {recentPayments.map((payment) => (
                      <div className="client-insight-row" key={payment.id}>
                        <div>
                          <strong>{formatPaymentType(payment.type)}</strong>
                          <span>{formatDate(payment.postedAt ?? payment.happenedAt)} · {payment.paymentMethod === "BANK" ? "банк" : "наличные"}</span>
                        </div>
                        <div className="client-insight-side">
                          <strong>{formatMoney(payment.amountKopecks)}</strong>
                          <span>{payment.comment ?? "без комментария"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="route-card-note">Оплаты по клиенту пока не зафиксированы.</p>
                )}
              </section>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
