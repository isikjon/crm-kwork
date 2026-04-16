import { cookies } from "next/headers";
import { loadClientsWorkspace } from "../lib/clients-api";

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatClientType(clientType: "INDIVIDUAL" | "LEGAL_ENTITY") {
  return clientType === "LEGAL_ENTITY" ? "Юр. лицо" : "Физ. лицо";
}

export async function ClientsLivePanel(props: {
  query: {
    q: string | null;
    limit: number;
  };
}) {
  const { data, apiBase, error } = await loadClientsWorkspace(props.query, cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Clients API</div>
        <h3>Список клиентов пока недоступен</h3>
        <p className="route-card-note">
          Проверь `crm-api`, миграции Prisma и наполнение через import commit.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Сначала выполнить legacy import commit.</li>
          <li>Затем открыть этот экран повторно.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const clients = data.clients;

  return (
    <section className="surface-card clients-list-panel">
      <div className="surface-kicker">Клиенты</div>
      <div className="clients-list-head">
        <div>
          <h3>Клиентская база</h3>
          <p className="route-card-note">
            {clients.tenant.name} · всего: {clients.total}
            {clients.query ? ` · найдено: ${clients.rows.length}` : ""}
          </p>
        </div>

        <a className="action-button clients-list-create" href="/clients/new">
          Новый клиент
        </a>
      </div>

      <form action="/clients" className="clients-list-toolbar">
        <input
          className="orders-simple-search"
          defaultValue={props.query.q ?? ""}
          name="q"
          placeholder="Поиск по ФИО, телефону, Telegram, ИНН, ID курьера, родственникам"
          type="search"
        />
        <button className="action-button clients-search-button" type="submit">
          Найти
        </button>
        {props.query.q ? (
          <a className="orders-simple-reset" href="/clients">
            Сбросить
          </a>
        ) : null}
      </form>

      <div className="clients-list-table">
        <div className="clients-list-header" aria-hidden="true">
          <span />
          <span>Клиент</span>
          <span>Принес</span>
          <span>Активные сделки</span>
          <span>Флаги</span>
        </div>

        {clients.rows.length > 0 ? (
          <div className="clients-list-body">
            {clients.rows.map((client) => {
              const rowHref = `/clients/${client.id}`;
              const hasDebt = client.currentDebtKopecks > 0;
              const hasOverdue = client.overdueDebtKopecks > 0;

              return (
                <a className="clients-list-row" href={rowHref} key={client.id}>
                  <span className={`clients-list-marker${client.isThief ? " is-danger" : client.isProblemClient ? " is-warning" : ""}`} aria-hidden="true" />

                  <div className="clients-list-main">
                    <div className="clients-list-name">{client.fullName}</div>
                    <div className="clients-list-subline">
                      <strong>{client.primaryPhone ?? "Без телефона"}</strong>
                      <span>{client.telegramHandle ?? client.workplace ?? formatClientType(client.clientType)}</span>
                      <span>{formatDateTime(client.updatedAt)}</span>
                    </div>
                  </div>

                  <div className="clients-list-money">
                    <strong>{formatMoney(client.moneyBroughtKopecks)}</strong>
                    <span>руб.</span>
                  </div>

                  <div className="clients-list-deals">
                    <strong>{client.activeDealsCount}</strong>
                    <span>
                      аренды: {client._count.rentals} · выкупы: {client._count.buyouts}
                    </span>
                  </div>

                  <div className="clients-list-flags">
                    {client.isThief ? <span className="tag-chip is-danger">Вор</span> : null}
                    {client.isProblemClient ? <span className="tag-chip is-warning">Проблемный</span> : null}
                    {hasOverdue ? <span className="tag-chip is-danger">Просрочка {formatMoney(client.overdueDebtKopecks)}</span> : null}
                    {hasDebt && !hasOverdue ? <span className="tag-chip is-neutral">Долг {formatMoney(client.currentDebtKopecks)}</span> : null}
                    {!client.isThief && !client.isProblemClient && !hasDebt ? (
                      <span className="tag-chip is-ok">Без флагов</span>
                    ) : null}
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <div className="clients-list-empty">
            {clients.query
              ? "По этому запросу клиентов не найдено."
              : "Клиенты пока не загружены в новую CRM."}
          </div>
        )}
      </div>
    </section>
  );
}
