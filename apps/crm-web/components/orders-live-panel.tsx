import Link from "next/link";
import type { Route } from "next";
import { cookies } from "next/headers";
import {
  type OrdersQuery,
  type OrdersStatusGroup,
  loadUnifiedOrders
} from "../lib/orders-api";
import { OrdersRegistryClient } from "./orders-registry-client";

function buildOrdersHref(currentQuery: OrdersQuery, overrides: OrdersQuery = {}) {
  const nextQuery: OrdersQuery = {
    ...currentQuery,
    ...overrides
  };

  const searchParams = new URLSearchParams();
  if (nextQuery.q?.trim()) {
    searchParams.set("q", nextQuery.q.trim());
  }
  if (nextQuery.statusGroup && nextQuery.statusGroup !== "ALL_ACTIVE") {
    searchParams.set("statusGroup", nextQuery.statusGroup);
  }

  const search = searchParams.toString();
  return search ? `/orders?${search}` : "/orders";
}

function isFilterActive<T extends OrdersStatusGroup>(current: T | null | undefined, expected: T) {
  return (current ?? null) === expected;
}

const STATUS_FILTERS: Array<{ label: string; value: OrdersStatusGroup }> = [
  { label: "Все активные", value: "ALL_ACTIVE" },
  { label: "Аренда", value: "RENTAL" },
  { label: "Выкуп", value: "BUYOUT" },
  { label: "Проблемы", value: "PROBLEM" },
  { label: "В ремонте", value: "REPAIR" },
  { label: "Аренда завершена", value: "RENTAL_COMPLETED" },
  { label: "Выкуп завершен", value: "BUYOUT_COMPLETED" }
];

export async function OrdersLivePanel({ query }: { query: OrdersQuery }) {
  const { data, apiBase, error } = await loadUnifiedOrders(query, cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Orders API</div>
        <h3>Единый реестр заказов пока недоступен</h3>
        <p className="route-card-note">
          Проверь `crm-api` и импорт сделок. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверить `http://localhost:4200/api/v1/system/health`.</li>
          <li>Если БД пуста, выполнить `POST /api/v1/imports/legacy/commit`.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const summaryCards = [
    {
      label: "В работе",
      value: data.summary.inWorkCount,
      href: buildOrdersHref(query, { statusGroup: "ALL_ACTIVE" })
    },
    {
      label: "Аренда",
      value: data.summary.rentalCount,
      href: buildOrdersHref(query, { statusGroup: "RENTAL" })
    },
    {
      label: "Выкуп",
      value: data.summary.buyoutCount,
      href: buildOrdersHref(query, { statusGroup: "BUYOUT" })
    },
    {
      label: "Проблемы",
      value: data.summary.problemCount,
      href: buildOrdersHref(query, { statusGroup: "PROBLEM" })
    },
    {
      label: "В ремонте",
      value: data.summary.repairBikeCount,
      href: buildOrdersHref(query, { statusGroup: "REPAIR" })
    },
    {
      label: "Простой",
      value: data.summary.idleBikeCount,
      href: "/bikes"
    }
  ] as const;

  return (
    <section className="section-stack">
      <section className="surface-card orders-simple-panel">
        <div className="orders-simple-head">
          <div>
            <h3>Реестр заказов</h3>
            <p className="route-card-note">
              {data.tenant.name} · в работе {data.summary.inWorkCount} · найдено {data.summary.filteredCount}
            </p>
          </div>

          <div className="orders-simple-actions">
            <Link className="action-button" href={"/orders/new" as Route}>
              Новый заказ
            </Link>
          </div>
        </div>

        <div className="orders-simple-counters">
          {summaryCards.map((card) => (
            <Link className="orders-counter-card" href={card.href as Route} key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </Link>
          ))}
        </div>

        <form action="/orders" className="orders-simple-toolbar">
          <input name="statusGroup" type="hidden" value={data.filters.statusGroup} />
          <input
            className="orders-simple-search"
            defaultValue={data.filters.query ?? ""}
            name="q"
            placeholder="Клиент, велосипед или номер"
            type="search"
          />
          <button className="action-button" type="submit">Найти</button>
          <Link className="orders-simple-reset" href={buildOrdersHref(query, { q: null }) as Route}>
            Сбросить
          </Link>
        </form>

        <div className="filter-row">
          {STATUS_FILTERS.map((filter) => (
            <Link
              className={["filter-link", isFilterActive(data.filters.statusGroup, filter.value) ? "active" : ""].join(" ").trim()}
              href={buildOrdersHref(query, { statusGroup: filter.value }) as Route}
              key={filter.value}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </section>

      <section className="surface-card orders-simple-list">
        <OrdersRegistryClient
          initialFocusDeal={query.focusKind && query.focusDealId ? {
            kind: query.focusKind,
            id: query.focusDealId
          } : null}
          rows={data.rows}
        />
      </section>
    </section>
  );
}
