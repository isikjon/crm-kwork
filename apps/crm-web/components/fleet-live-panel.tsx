import { cookies } from "next/headers";
import { loadFleetList } from "../lib/fleet-api";

type FleetRow = NonNullable<Awaited<ReturnType<typeof loadFleetList>>["data"]>["rows"][number];
type FleetQuickFilter = "available" | "rented" | "buyout" | "repair" | "gps_issue" | "attention";
type FleetStatusTone = "available" | "rented" | "buyout" | "repair" | "attention" | "neutral";

const QUICK_FILTERS: Array<{ value: FleetQuickFilter; label: string }> = [
  { value: "available", label: "Свободен" },
  { value: "rented", label: "В аренде" },
  { value: "buyout", label: "В выкупе" },
  { value: "repair", label: "В ремонте" },
  { value: "gps_issue", label: "Проблема GPS" },
  { value: "attention", label: "Нужно внимание" }
];

function getFleetStatusTone(status: string): FleetStatusTone {
  switch (status) {
    case "AVAILABLE":
      return "available";
    case "RENTED":
      return "rented";
    case "BUYOUT":
      return "buyout";
    case "REPAIR":
      return "repair";
    default:
      return "neutral";
  }
}

function getQuickFilterTone(filter: FleetQuickFilter): FleetStatusTone {
  switch (filter) {
    case "available":
      return "available";
    case "rented":
      return "rented";
    case "buyout":
      return "buyout";
    case "repair":
      return "repair";
    case "gps_issue":
    case "attention":
      return "attention";
    default:
      return "neutral";
  }
}

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

function formatDealStatus(status: string) {
  switch (status) {
    case "NEW":
      return "Новая";
    case "ACTIVE":
      return "Активна";
    case "OVERDUE":
      return "Просрочка";
    case "HOLD":
      return "На удержании";
    case "RETURN_PREP":
      return "Готовится возврат";
    case "COMPLETED":
      return "Завершена";
    case "CANCELED":
      return "Отменена";
    case "CLOSED":
      return "Закрыта";
    case "TERMINATED":
      return "Расторгнута";
    default:
      return status;
  }
}

function formatRepairStatus(status: "OPEN" | "COMPLETED") {
  return status === "OPEN" ? "Открыт" : "Завершен";
}

function trimBikeTitle(value: string) {
  return value.length > 54 ? `${value.slice(0, 54)}...` : value;
}

function getGpsStatusLabel(gps: FleetRow["gps"]) {
  if (!gps) {
    return "GPS не привязан";
  }

  if (gps.lastSyncError) {
    return "Ошибка GPS";
  }

  if (gps.status === "ONLINE") {
    return "GPS в сети";
  }

  if (gps.status === "OFFLINE") {
    return "GPS не в сети";
  }

  return "Нет данных GPS";
}

function getGpsStatusClass(gps: FleetRow["gps"]) {
  if (!gps) {
    return "is-neutral";
  }

  if (gps.lastSyncError || gps.syncState === "ERROR" || gps.syncState === "STALE") {
    return "is-danger";
  }

  if (gps.status === "OFFLINE" || gps.syncState === "WARNING") {
    return "is-warning";
  }

  if (gps.status === "ONLINE") {
    return "is-ok";
  }

  return "is-neutral";
}

function normalizeGpsDeviceLabel(value: string | null | undefined) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (/[ÐÑÃÂ�]/.test(normalized)) {
    return null;
  }

  return normalized;
}

function resolveGpsDisplayLabel(gps: FleetRow["gps"]) {
  if (!gps) {
    return null;
  }

  return normalizeGpsDeviceLabel(gps.deviceAlias)
    ?? normalizeGpsDeviceLabel(gps.deviceName)
    ?? gps.externalDeviceId;
}

function buildFleetHref(query: {
  q?: string | null;
  status?: string | null;
  quick?: string | null;
  focusBikeId?: string | null;
}, patch: Record<string, string | null>) {
  const params = new URLSearchParams();
  const nextState: Record<string, string | null | undefined> = {
    q: query.q ?? null,
    status: query.status ?? null,
    quick: query.quick ?? null,
    focusBikeId: query.focusBikeId ?? null,
    ...patch
  };

  for (const [key, value] of Object.entries(nextState)) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }

    params.set(key, normalized);
  }

  return params.toString() ? `/bikes?${params.toString()}` : "/bikes";
}

function getAttentionTags(bike: FleetRow) {
  if (!bike.attention.needsAttention) {
    return [];
  }

  return bike.attention.reasons.slice(0, 2);
}

function getDealLabel(deal: NonNullable<FleetRow["activeDeal"]>) {
  return `${deal.kind === "RENTAL" ? "Аренда" : "Выкуп"} ${deal.dealNumber}`;
}

export async function FleetLivePanel(props: {
  query: {
    q: string | null;
    status: string | null;
    quick?: string | null;
    focusBikeId?: string | null;
    limit: number;
  };
}) {
  const cookieHeader = (await cookies()).toString();
  const { data, apiBase, error } = await loadFleetList(props.query, cookieHeader);

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Fleet API</div>
        <h3>Парк пока недоступен</h3>
        <p className="route-card-note">
          Этот экран начнет показывать парк после Prisma migration и import commit.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Подними `crm-api` и БД.</li>
          <li>Выполни `POST /api/v1/imports/legacy/commit`.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const bikes = data.rows;

  return (
    <section className="surface-card fleet-registry-panel">
      <div className="surface-kicker">Парк</div>
      <div className="fleet-registry-head">
        <div>
          <h3>Операторский реестр велосипедов</h3>
          <p className="route-card-note">
            {data.tenant.name} · {data.total} ед.
            {data.query ? ` · поиск: ${data.query}` : ""}
            {data.quickFilter ? ` · быстрый фильтр активен` : ""}
          </p>
        </div>

        <div className="fleet-head-actions">
          <a className="action-button clients-list-create" href="/bikes/new">
            Новый велосипед
          </a>
          <a className="action-button action-button-secondary" href="/repairs">
            Ремонты
          </a>
        </div>
      </div>

      <form action="/bikes" className="fleet-toolbar">
        <input
          className="orders-simple-search"
          defaultValue={props.query.q ?? ""}
          name="q"
          placeholder="Поиск по артикулу, названию, модели, серийному номеру, клиенту"
          type="search"
        />

        <select className="orders-simple-filter" defaultValue={props.query.status ?? ""} name="status">
          <option value="">Все статусы</option>
          <option value="AVAILABLE">Свободен</option>
          <option value="RENTED">В аренде</option>
          <option value="BUYOUT">В выкупе</option>
          <option value="REPAIR">В ремонте</option>
          <option value="RESERVED">Забронирован</option>
          <option value="RETURN_PENDING">Ожидает возврата</option>
          <option value="WRITTEN_OFF">Списан</option>
        </select>

        {props.query.quick ? <input name="quick" type="hidden" value={props.query.quick} /> : null}

        <button className="action-button clients-search-button" type="submit">
          Найти
        </button>

        {props.query.q || props.query.status || props.query.quick ? (
          <a className="orders-simple-reset" href="/bikes">
            Сбросить
          </a>
        ) : null}
      </form>

      <div className="fleet-quick-filters">
        {QUICK_FILTERS.map((filter) => (
          <a
            className={[
              "tag-chip",
              "fleet-filter-chip",
              `is-tone-${getQuickFilterTone(filter.value)}`,
              data.quickFilter === filter.value ? "is-active" : ""
            ].join(" ").trim()}
            href={buildFleetHref(props.query, {
              quick: data.quickFilter === filter.value ? null : filter.value,
              status: null,
              focusBikeId: null
            })}
            key={filter.value}
          >
            {filter.label}
          </a>
        ))}
      </div>

      <div className="orders-simple-counters fleet-counters">
        <div className="orders-counter-card">
          <span>Свободны</span>
          <strong>{data.summary.availableCount}</strong>
        </div>
        <div className="orders-counter-card">
          <span>В аренде</span>
          <strong>{data.summary.rentedCount}</strong>
        </div>
        <div className="orders-counter-card">
          <span>В выкупе</span>
          <strong>{data.summary.buyoutCount}</strong>
        </div>
        <div className="orders-counter-card">
          <span>В ремонте</span>
          <strong>{data.summary.repairCount}</strong>
        </div>
        <div className="orders-counter-card">
          <span>Проблема GPS</span>
          <strong>{data.summary.gpsIssueCount}</strong>
        </div>
        <div className="orders-counter-card">
          <span>Нужно внимание</span>
          <strong>{data.summary.attentionCount}</strong>
        </div>
      </div>

      <div className="fleet-list-table">
        <div className="fleet-list-header" aria-hidden="true">
          <span />
          <span>Велосипед</span>
          <span>Статус</span>
          <span>Активная сделка</span>
          <span>Открытый ремонт</span>
          <span>GPS / внимание</span>
        </div>

        {bikes.length > 0 ? (
          <div className="fleet-list-body">
            {bikes.map((bike) => {
              const attentionTags = getAttentionTags(bike);
              const statusTone = getFleetStatusTone(bike.status);

              return (
                <article
                  className={[
                    "fleet-list-row",
                    `is-tone-${statusTone}`,
                    props.query.focusBikeId === bike.id ? "is-focused" : ""
                  ].join(" ").trim()}
                  key={bike.id}
                >
                  <span className={`fleet-list-marker is-${bike.status.toLowerCase()}`} aria-hidden="true" />

                  <div className="fleet-list-main">
                    <a className="fleet-list-title record-link" href={`/bikes/${bike.id}`} title={bike.title}>
                      {trimBikeTitle(bike.title)}
                    </a>
                    <div className="fleet-list-subline">
                      <strong>{bike.article ?? bike.internalCode}</strong>
                      <span>{bike.bikeModel?.name ?? "без модели"}</span>
                      <span>{bike.branch?.name ?? "точка не задана"}</span>
                    </div>
                  </div>

                  <div className="fleet-list-status">
                    <span className={`fleet-status-chip is-tone-${statusTone}`}>{formatBikeStatus(bike.status)}</span>
                    <span>{bike.currentClient?.fullName ?? "Клиент не назначен"}</span>
                    <span>Выдача: {formatDate(bike.lastIssuedAt)}</span>
                  </div>

                  <div className="fleet-list-deal">
                    {bike.activeDeal ? (
                      <>
                        <strong>{getDealLabel(bike.activeDeal)}</strong>
                        <span>{bike.activeDeal.clientName} · {formatDealStatus(bike.activeDeal.status)}</span>
                        <span>След. оплата: {formatDate(bike.activeDeal.nextPaymentAt)}</span>
                      </>
                    ) : (
                      <>
                        <strong>Нет активной сделки</strong>
                        <span>Сейчас велосипед не участвует в аренде или выкупе.</span>
                      </>
                    )}
                  </div>

                  <div className="fleet-list-repair">
                    {bike.openRepair ? (
                      <>
                        <strong>{bike.openRepair.title}</strong>
                        <span>{formatRepairStatus(bike.openRepair.status)} · {formatDate(bike.openRepair.serviceDate)}</span>
                        <span>Сумма: {formatMoney(bike.openRepair.costKopecks)}</span>
                      </>
                    ) : (
                      <>
                        <strong>Открытого ремонта нет</strong>
                        <span>{bike._count.repairs > 0 ? `Всего ремонтов: ${bike._count.repairs}` : "Ремонтов пока не было."}</span>
                      </>
                    )}
                  </div>

                  <div className="fleet-list-gps">
                    <strong>{getGpsStatusLabel(bike.gps)}</strong>
                    {bike.gps ? (
                      <>
                        <span>{resolveGpsDisplayLabel(bike.gps)}</span>
                        <span>
                          {bike.gps.lastSyncError
                            ? "Есть ошибка синхронизации"
                            : bike.gps.syncAgeLabel
                              ? `Синхронизация: ${bike.gps.syncAgeLabel}`
                              : "Синхронизация без замечаний"}
                        </span>
                      </>
                    ) : (
                      <>
                        <span>Трекер пока не привязан.</span>
                      </>
                    )}

                    <div className="record-tags fleet-attention-tags">
                      <span className={`tag-chip ${bike.attention.hasGpsIssue ? "is-warning" : "is-ok"}`}>
                        {bike.attention.hasGpsIssue ? "Проблема GPS" : "GPS в норме"}
                      </span>
                      {bike.attention.needsAttention ? (
                        <span className="tag-chip is-warning">Нужно внимание</span>
                      ) : null}
                      {attentionTags.map((reason) => (
                        <span className="tag-chip is-neutral" key={reason}>{reason}</span>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="clients-list-empty">
            {data.query || data.statusFilter || data.quickFilter
              ? "По этим условиям велосипеды не найдены."
              : "В парке пока нет загруженных велосипедов."}
          </div>
        )}
      </div>
    </section>
  );
}
