import { cookies } from "next/headers";
import { loadBikeDetail } from "../lib/fleet-api";

type BikeDetailData = NonNullable<Awaited<ReturnType<typeof loadBikeDetail>>["data"]>;
type BikeGpsSnapshot = BikeDetailData["bike"]["gps"];

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

function formatDateTime(value: string | null) {
  if (!value) {
    return "не задано";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
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
      return "Закрыт";
    case "TERMINATED":
      return "Расторгнут";
    default:
      return status;
  }
}

function formatRepairStatus(status: "OPEN" | "COMPLETED") {
  return status === "OPEN" ? "В работе" : "Завершен";
}

function formatDealsCountLabel(totalDeals: number) {
  const mod10 = totalDeals % 10;
  const mod100 = totalDeals % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${totalDeals} сделка за все время`;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${totalDeals} сделки за все время`;
  }

  return `${totalDeals} сделок за все время`;
}

function formatWorkedDaysLabel(days: number) {
  const mod10 = days % 10;
  const mod100 = days % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${days} день`;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${days} дня`;
  }

  return `${days} дней`;
}

function getGpsStatusLabel(status: NonNullable<BikeGpsSnapshot>["status"]) {
  switch (status) {
    case "ONLINE":
      return "GPS в сети";
    case "OFFLINE":
      return "GPS не в сети";
    case "ERROR":
      return "Ошибка GPS";
    default:
      return "Нет данных GPS";
  }
}

function getGpsStatusClass(status: NonNullable<BikeGpsSnapshot>["status"]) {
  switch (status) {
    case "ONLINE":
      return "is-online";
    case "OFFLINE":
      return "is-offline";
    case "ERROR":
      return "is-error";
    default:
      return "is-setup";
  }
}

function getGpsSyncClass(syncState: NonNullable<BikeGpsSnapshot>["syncState"]) {
  switch (syncState) {
    case "FRESH":
      return "is-live";
    case "WARNING":
      return "is-warning";
    case "STALE":
    case "ERROR":
      return "is-stale";
    default:
      return "";
  }
}

function getGpsSyncText(gps: NonNullable<BikeGpsSnapshot>) {
  if (gps.lastSyncError) {
    return `Показан последний сохраненный снимок. Последняя синхронизация завершилась ошибкой: ${gps.lastSyncError}`;
  }

  if (gps.syncState === "STALE") {
    return "Показан сохраненный снимок. Данные GPS давно не обновлялись.";
  }

  if (gps.syncState === "WARNING") {
    return "Показан сохраненный снимок. Данные GPS стоит обновить.";
  }

  if (gps.syncState === "ERROR") {
    return "Показан сохраненный снимок. Есть проблема синхронизации GPS.";
  }

  return "Снимок GPS актуален.";
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

function resolveGpsDisplayLabel(gps: NonNullable<BikeGpsSnapshot> | null, options?: {
  allowExternalId?: boolean;
}) {
  if (!gps) {
    return null;
  }

  const label = normalizeGpsDeviceLabel(gps.deviceAlias) ?? normalizeGpsDeviceLabel(gps.deviceName);
  if (label) {
    return label;
  }

  return options?.allowExternalId ? gps.externalDeviceId : null;
}

function isProblematicDealStatus(status: string) {
  return ["OVERDUE", "HOLD", "RETURN_PREP"].includes(status);
}

export async function BikeDetailPanel(props: {
  bikeId: string;
}) {
  const cookieHeader = (await cookies()).toString();
  const { data, apiBase, error } = await loadBikeDetail(props.bikeId, cookieHeader);

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Fleet API</div>
        <h3>Карточка велосипеда пока недоступна</h3>
        <p className="route-card-note">
          Проверь `crm-api`, Prisma sync и загрузку парка.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Сначала выполни import commit, если парк пустой.</li>
          <li>Проверь, что велосипед еще существует в БД.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const bike = data.bike;
  const activeDeal = bike.activeRental
    ? {
        kind: "RENTAL" as const,
        id: bike.activeRental.id,
        dealNumber: bike.activeRental.dealNumber,
        status: bike.activeRental.status,
        clientName: bike.activeRental.client.fullName,
        nextPaymentAt: bike.activeRental.nextPaymentAt
      }
    : bike.activeBuyout
      ? {
          kind: "BUYOUT" as const,
          id: bike.activeBuyout.id,
          dealNumber: bike.activeBuyout.dealNumber,
          status: bike.activeBuyout.status,
          clientName: bike.activeBuyout.client.fullName,
          nextPaymentAt: bike.activeBuyout.nextPaymentAt
        }
      : null;
  const openRepair = bike.repairs.find((repair) => repair.status === "OPEN") ?? null;
  const hasGpsIssue = !bike.gps || bike.gps.status !== "ONLINE" || bike.gps.syncState !== "FRESH" || Boolean(bike.gps.lastSyncError);
  const attentionReasons = [
    ...(openRepair ? ["Открыт ремонт"] : []),
    ...(hasGpsIssue ? [bike.gps ? "GPS требует внимания" : "GPS не привязан"] : []),
    ...(activeDeal && isProblematicDealStatus(activeDeal.status) ? ["Сделка требует внимания"] : [])
  ];
  const totalDealsCount = bike.summary.rentalsCount + bike.summary.buyoutsCount;
  const gpsSummaryLabel = resolveGpsDisplayLabel(bike.gps, { allowExternalId: true });
  const gpsDetailLabel = resolveGpsDisplayLabel(bike.gps);

  return (
    <section className="section-stack">
      <section className="surface-card bike-detail-hero">
        <div className="bike-detail-top-links">
          <a className="client-detail-back" href="/bikes">Назад к парку</a>
          <a className="action-button bike-edit-action" href={`/bikes/${bike.id}/edit`}>Редактировать велосипед</a>
        </div>
        <div className="surface-kicker">Карточка велосипеда</div>
        <div className="bike-detail-hero-head">
          <div>
            <h3>{bike.title}</h3>
            <p className="route-card-note">
              {bike.article ?? bike.internalCode} · {bike.bikeModel?.name ?? "без модели"} · {formatBikeStatus(bike.status)}
            </p>
          </div>

        <div className="record-tags">
          <span className="tag-chip">{formatBikeStatus(bike.status)}</span>
          {bike.branch?.name ? <span className="tag-chip">Точка: {bike.branch.name}</span> : null}
          {bike.currentClient?.fullName ? <span className="tag-chip">Клиент: {bike.currentClient.fullName}</span> : null}
          {bike.gps ? (
            <span className={["gps-chip", getGpsStatusClass(bike.gps.status)].join(" ").trim()}>
              <span className="gps-chip-dot" aria-hidden="true" />
              <span>{getGpsStatusLabel(bike.gps.status)}</span>
            </span>
          ) : null}
        </div>
        </div>

        <div className="bike-kpi-grid">
          <article className="bike-kpi-card is-income">
            <span className="bike-kpi-label">Принес</span>
            <strong className="bike-kpi-value">{formatMoney(bike.economics.moneyBroughtKopecks)}</strong>
            <span className="bike-kpi-note">всего поступлений по этому велосипеду</span>
          </article>
          <article className="bike-kpi-card is-expense">
            <span className="bike-kpi-label">Ремонты</span>
            <strong className="bike-kpi-value">{formatMoney(bike.economics.repairSpentKopecks)}</strong>
            <span className="bike-kpi-note">затраты на сервис и ремонт</span>
          </article>
          <article className="bike-kpi-card is-profit">
            <span className="bike-kpi-label">Чистая прибыль</span>
            <strong className="bike-kpi-value">{formatMoney(bike.economics.netProfitKopecks)}</strong>
            <span className="bike-kpi-note">доход минус ремонтные расходы</span>
          </article>
          <article className="bike-kpi-card">
            <span className="bike-kpi-label">В работе</span>
            <strong className="bike-kpi-value">{bike.summary.workedDurationLabel}</strong>
            <span className="bike-kpi-note">суммарное время в работе</span>
            <span className="bike-kpi-note">{formatDealsCountLabel(totalDealsCount)}</span>
          </article>
        </div>

        <div className="bike-utilization-grid">
          <article className="bike-utilization-card">
            <span className="bike-utilization-label">В работе за 7 дней</span>
            <strong className="bike-utilization-value">{formatWorkedDaysLabel(bike.summary.utilization.last7Days.workedDays)}</strong>
            <span className="bike-utilization-note">Загрузка: {bike.summary.utilization.last7Days.utilizationPercent}%</span>
          </article>
          <article className="bike-utilization-card">
            <span className="bike-utilization-label">В работе за 30 дней</span>
            <strong className="bike-utilization-value">{formatWorkedDaysLabel(bike.summary.utilization.last30Days.workedDays)}</strong>
            <span className="bike-utilization-note">Загрузка: {bike.summary.utilization.last30Days.utilizationPercent}%</span>
          </article>
          <article className="bike-utilization-card">
            <span className="bike-utilization-label">В работе за 365 дней</span>
            <strong className="bike-utilization-value">{formatWorkedDaysLabel(bike.summary.utilization.last365Days.workedDays)}</strong>
            <span className="bike-utilization-note">Загрузка: {bike.summary.utilization.last365Days.utilizationPercent}%</span>
          </article>
        </div>

        <p className="route-card-note bike-economics-note">
          Экономика показана по текущим данным CRM и импортированным legacy-связям.
        </p>

        <div className="record-tags">
          <span className="tag-chip">Аренд: {bike.summary.rentalsCount}</span>
          <span className="tag-chip">Выкупов: {bike.summary.buyoutsCount}</span>
          <span className="tag-chip">Ремонтов: {bike.summary.repairsCount}</span>
          <span className="tag-chip">Пробег: {bike.odometerKm} км</span>
        </div>
      </section>

      <section className="surface-card bike-operator-summary">
        <div className="surface-kicker">Операторский блок</div>
        <h3>Что происходит с велосипедом сейчас</h3>

        <div className="bike-operator-grid">
          <article className="bike-operator-card">
            <span className="bike-operator-label">Статус</span>
            <strong>{formatBikeStatus(bike.status)}</strong>
            <span>{bike.branch?.name ?? "Точка не задана"}</span>
            <span>{bike.currentClient?.fullName ?? "Клиент сейчас не назначен"}</span>
          </article>

          <article className="bike-operator-card">
            <span className="bike-operator-label">Активная сделка</span>
            {activeDeal ? (
              <>
                <strong>{activeDeal.kind === "RENTAL" ? "Аренда" : "Выкуп"} {activeDeal.dealNumber}</strong>
                <span>{activeDeal.clientName}</span>
                <span>{formatDealStatus(activeDeal.status)} · след. оплата: {formatDate(activeDeal.nextPaymentAt)}</span>
              </>
            ) : (
              <>
                <strong>Нет активной сделки</strong>
                <span>Сейчас велосипед не участвует в аренде или выкупе.</span>
              </>
            )}
          </article>

          <article className="bike-operator-card">
            <span className="bike-operator-label">Ремонт</span>
            {openRepair ? (
              <>
                <strong>{openRepair.title}</strong>
                <span>{formatRepairStatus(openRepair.status)} · {formatDate(openRepair.serviceDate)}</span>
                <span>Сумма: {formatMoney(openRepair.costKopecks)}</span>
              </>
            ) : (
              <>
                <strong>Открытого ремонта нет</strong>
                <span>{bike.repairs.length > 0 ? `Всего ремонтов: ${bike.repairs.length}` : "Ремонтов по велосипеду пока нет."}</span>
              </>
            )}
          </article>

          <article className="bike-operator-card">
            <span className="bike-operator-label">GPS</span>
            <strong>{bike.gps ? getGpsStatusLabel(bike.gps.status) : "GPS не привязан"}</strong>
            <span>{bike.gps ? (gpsSummaryLabel ?? "Нужна ручная привязка трекера") : "Нужна ручная привязка трекера"}</span>
            <span>
              {bike.gps
                ? (bike.gps.lastSyncError
                    ? "Есть ошибка синхронизации"
                    : bike.gps.syncAgeLabel
                    ? `Синхронизация: ${bike.gps.syncAgeLabel}`
                      : "Синхронизация без замечаний")
                : "GPS-контекст пока пустой"}
            </span>
          </article>
        </div>

        <div className="record-tags bike-operator-tags">
          {attentionReasons.length > 0 ? attentionReasons.map((reason) => (
            <span className="tag-chip is-warning" key={reason}>{reason}</span>
          )) : <span className="tag-chip is-ok">Критичных проблем нет</span>}
        </div>
      </section>

      <section className="bike-detail-layout">
        <div className="section-stack">
          <section className="surface-card bike-detail-section">
            <div className="surface-kicker">Основное</div>
            <h3>Что по велосипеду сейчас</h3>
            <div className="bike-detail-inline-list">
              <div className="bike-detail-inline-row">
                <strong>Статус</strong>
                <span>{formatBikeStatus(bike.status)}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Модель</strong>
                <span>{bike.bikeModel?.name ?? "не задана"}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Артикул / код</strong>
                <span>{bike.article ?? bike.internalCode}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Серийный номер</strong>
                <span>{bike.serialNumber ?? "не указан"}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Точка</strong>
                <span>{bike.branch?.name ?? "не задана"}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Выдан последний раз</strong>
                <span>{formatDate(bike.lastIssuedAt)}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Себестоимость</strong>
                <span>{formatMoney(bike.purchaseCostKopecks)}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Цена продажи</strong>
                <span>{formatMoney(bike.salePriceKopecks)}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Оценка</strong>
                <span>{formatMoney(bike.valuationKopecks)}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Состояние</strong>
                <span>{bike.conditionNote ?? "без комментария"}</span>
              </div>
            </div>

            {bike.comment ? <p className="route-card-note bike-detail-note">{bike.comment}</p> : null}
          </section>

          <section className="surface-card bike-detail-section">
            <div className="surface-kicker">Тарифы</div>
            <h3>Что закреплено за велосипедом</h3>
            <div className="bike-detail-inline-list">
              <div className="bike-detail-inline-row">
                <strong>Аренда</strong>
                <span>{bike.rentalTariffGroup?.name ?? "не закреплена"}</span>
              </div>
              <div className="bike-detail-inline-row">
                <strong>Выкуп</strong>
                <span>{bike.buyoutTariffGroup?.name ?? "не закреплен"}</span>
              </div>
            </div>
          </section>

          <section className="surface-card bike-detail-section">
            <div className="surface-kicker">Что выдано сейчас</div>
            <h3>Комплект активной сделки</h3>

            {bike.issuedEquipment.length > 0 ? (
              <div className="bike-issued-equipment-list">
                {bike.issuedEquipment.map((item) => (
                  <div className="bike-issued-equipment-row" key={item.id}>
                    <strong>{item.label}</strong>
                    <span>Количество: {item.quantity}</span>
                    {item.comment ? <span>{item.comment}</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="route-card-note">
                Сейчас по активной сделке дополнительное оборудование не выдано.
              </p>
            )}
          </section>
        </div>

        <div className="section-stack bike-detail-side">
          <section className="surface-card bike-detail-section">
            <div className="surface-kicker">GPS</div>
            <h3>Статус трекера</h3>

            {bike.gps ? (
              <>
                <div className="gps-panel-shell bike-gps-panel">
                  <div className="gps-panel-topline">
                    <span className={["gps-chip", getGpsStatusClass(bike.gps.status)].join(" ").trim()}>
                      <span className="gps-chip-dot" aria-hidden="true" />
                      <span>{getGpsStatusLabel(bike.gps.status)}</span>
                    </span>
                    {bike.gps.offlineAgeLabel ? (
                      <span className={["gps-age", bike.gps.status === "ONLINE" ? "is-live" : getGpsSyncClass(bike.gps.syncState) || "is-warning"].join(" ").trim()}>
                        {bike.gps.offlineAgeLabel}
                      </span>
                    ) : null}
                    {gpsDetailLabel ? (
                      <span className="gps-device-pill">{gpsDetailLabel}</span>
                    ) : null}
                  </div>

                  <div className="gps-meta-grid">
                    {bike.gps.externalDeviceId ? (
                      <div className="gps-meta-item">
                        <span>ID устройства</span>
                        <strong>{bike.gps.externalDeviceId}</strong>
                      </div>
                    ) : null}
                    <div className="gps-meta-item">
                      <span>Последний сигнал</span>
                      <strong>{bike.gps.lastSeenLabel ?? "нет данных"}</strong>
                    </div>
                    <div className="gps-meta-item">
                      <span>Последняя синхронизация</span>
                      <strong>
                        {formatDateTime(bike.gps.lastSyncAt)}
                        {bike.gps.syncAgeLabel ? ` · ${bike.gps.syncAgeLabel}` : ""}
                      </strong>
                    </div>
                  </div>
                </div>

                {bike.gps.syncState !== "FRESH" || bike.gps.lastSyncError ? (
                  <p className={["route-card-note", "bike-detail-gps-sync-note", "gps-sync-note", getGpsSyncClass(bike.gps.syncState)].join(" ").trim()}>
                    {getGpsSyncText(bike.gps)}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="route-card-note">
                Трекер к этому велосипеду пока не привязан. Подключение и привязка делаются в настройках GPS.
              </p>
            )}
          </section>

          <section className="surface-card bike-detail-section">
            <div className="surface-kicker">Активная работа</div>
            <h3>Сейчас в аренде или выкупе</h3>

            {bike.activeRental ? (
              <div className="bike-detail-activity-card">
                <strong>Аренда {bike.activeRental.dealNumber}</strong>
                <div className="route-card-note">
                  {bike.activeRental.client.fullName} · {formatDealStatus(bike.activeRental.status)}
                </div>
                <div className="route-card-note">
                  След. оплата: {formatDate(bike.activeRental.nextPaymentAt)} · долг: {formatMoney(bike.activeRental.debtKopecks)}
                </div>
              </div>
            ) : null}

            {bike.activeBuyout ? (
              <div className="bike-detail-activity-card">
                <strong>Выкуп {bike.activeBuyout.dealNumber}</strong>
                <div className="route-card-note">
                  {bike.activeBuyout.client.fullName} · {formatDealStatus(bike.activeBuyout.status)}
                </div>
                <div className="route-card-note">
                  След. оплата: {formatDate(bike.activeBuyout.nextPaymentAt)} · остаток: {formatMoney(bike.activeBuyout.residualDebtKopecks)}
                </div>
              </div>
            ) : null}

            {!bike.activeRental && !bike.activeBuyout ? (
              <p className="route-card-note">Сейчас велосипед свободен и ни в одной активной сделке не участвует.</p>
            ) : null}
          </section>

          <details className="surface-card detail-collapsible bike-detail-collapse">
            <summary className="detail-collapsible-summary">
              <div>
                <div className="surface-kicker">Ремонты</div>
                <h3>Последние работы</h3>
              </div>
              <span className="detail-collapsible-hint" />
            </summary>

            <div className="detail-collapsible-body">
              {bike.repairs.length > 0 ? (
                <div className="timeline-list bike-detail-timeline">
                  {bike.repairs.map((repair) => (
                    <div className="timeline-item" key={repair.id}>
                      <div>
                        {repair.title} · {formatRepairStatus(repair.status)}
                      </div>
                      <div className="timeline-meta">
                        {formatDate(repair.serviceDate)} · {formatMoney(repair.costKopecks)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="route-card-note">Ремонтов по этому велосипеду пока нет.</p>
              )}
            </div>
          </details>

          <details className="surface-card detail-collapsible bike-detail-collapse">
            <summary className="detail-collapsible-summary">
              <div>
                <div className="surface-kicker">История работы</div>
                <h3>Последние сделки</h3>
              </div>
              <span className="detail-collapsible-hint" />
            </summary>

            <div className="detail-collapsible-body">
              <div className="timeline-list bike-detail-timeline">
                {bike.recentDeals.rentals.map((deal) => (
                  <div className="timeline-item" key={deal.id}>
                    <div>Аренда {deal.dealNumber}</div>
                    <div className="timeline-meta">
                      {deal.client.fullName} · {formatDealStatus(deal.status)} · {formatDate(deal.startsAt)}
                    </div>
                  </div>
                ))}

                {bike.recentDeals.buyouts.map((deal) => (
                  <div className="timeline-item" key={deal.id}>
                    <div>Выкуп {deal.dealNumber}</div>
                    <div className="timeline-meta">
                      {deal.client.fullName} · {formatDealStatus(deal.status)} · {formatDate(deal.startsAt)}
                    </div>
                  </div>
                ))}

                {bike.recentDeals.rentals.length === 0 && bike.recentDeals.buyouts.length === 0 ? (
                  <div className="timeline-item">
                    <div>Сделок по этому велосипеду пока нет.</div>
                  </div>
                ) : null}
              </div>
            </div>
          </details>
        </div>
      </section>
    </section>
  );
}
