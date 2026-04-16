import { cookies } from "next/headers";
import Link from "next/link";
import { loadRentalsList } from "../lib/rentals-api";

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
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

function formatOutstanding(amountKopecks: number, paidKopecks: number) {
  return formatMoney(Math.max(0, amountKopecks - paidKopecks));
}

export async function RentalsLivePanel() {
  const cookieHeader = (await cookies()).toString();
  const { data, apiBase, error } = await loadRentalsList(cookieHeader);

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Rentals API</div>
        <h3>Реестр аренды пока недоступен</h3>
        <p className="route-card-note">
          Этот экран заработает после import commit и миграций Prisma.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Сначала выполнить `POST /api/v1/imports/legacy/commit`.</li>
          <li>Потом открыть раздел `Аренда` повторно.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return (
    <section className="surface-card">
      <div className="surface-kicker">Live data</div>
      <h3>Сделки аренды в новой БД</h3>
      <p className="route-card-note">
        Tenant: {data.tenant.name} · всего аренд: {data.total}
      </p>

      <div className="record-grid">
        {data.rows.map((rental) => (
          <article className="record-card" key={rental.id}>
            <div className="status-line">
              <div className="record-title">{rental.dealNumber}</div>
              <span>{rental.status}</span>
            </div>
            <div className="record-meta">
              {rental.client.fullName} · {rental.bikeUnit.title} · {rental.tariffLabel}
            </div>
            <div className="record-kpi-row">
              <div className="record-kpi">
                <span>Платеж</span>
                <strong>{formatMoney(rental.plannedPaymentKopecks)}</strong>
              </div>
              <div className="record-kpi">
                <span>Долг</span>
                <strong>{formatMoney(rental.debtKopecks)}</strong>
              </div>
              <div className="record-kpi">
                <span>Просрочка</span>
                <strong>{rental.overdueDays}</strong>
              </div>
            </div>
            <div className="record-tags">
              <span className="tag-chip">start: {formatDate(rental.startsAt)}</span>
              <span className="tag-chip">next: {formatDate(rental.nextPaymentAt)}</span>
              <span className="tag-chip">penalties: {rental._count.penalties}</span>
            </div>
            <div className="record-tags">
              {(rental.paymentSchedules[0]?.items.length ?? 0) > 0 ? (
                rental.paymentSchedules[0].items.map((item) => (
                  <span className="tag-chip" key={`${rental.id}-${item.sequenceNumber}`}>
                    #{item.sequenceNumber} {formatDate(item.dueAt)} · {formatOutstanding(item.amountKopecks, item.paidKopecks)} · {item.status}
                  </span>
                ))
              ) : (
                <span className="tag-chip">schedule: будет создан после import commit</span>
              )}
            </div>
            <div className="record-actions">
              <Link className="detail-link" href={`/rentals/${rental.id}`}>
                Открыть карточку сделки
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
