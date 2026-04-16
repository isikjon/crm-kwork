import { cookies } from "next/headers";
import Link from "next/link";
import { loadBuyoutsList } from "../lib/buyouts-api";

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

export async function BuyoutsLivePanel() {
  const cookieHeader = (await cookies()).toString();
  const { data, apiBase, error } = await loadBuyoutsList(cookieHeader);

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Buyouts API</div>
        <h3>Реестр выкупа пока недоступен</h3>
        <p className="route-card-note">
          Этот экран начнет показывать сделки после import commit и Prisma migration.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Сначала выполнить `POST /api/v1/imports/legacy/commit`.</li>
          <li>Потом открыть раздел `Выкуп` повторно.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return (
    <section className="surface-card">
      <div className="surface-kicker">Live data</div>
      <h3>Сделки выкупа в новой БД</h3>
      <p className="route-card-note">
        Tenant: {data.tenant.name} · всего выкупов: {data.total}
      </p>

      <div className="record-grid">
        {data.rows.map((buyout) => (
          <article className="record-card" key={buyout.id}>
            <div className="status-line">
              <div className="record-title">{buyout.dealNumber}</div>
              <span>{buyout.status}</span>
            </div>
            <div className="record-meta">
              {buyout.client.fullName} · {buyout.bikeUnit.title} · {buyout.paymentCadence}
            </div>
            <div className="record-kpi-row">
              <div className="record-kpi">
                <span>Сумма</span>
                <strong>{formatMoney(buyout.totalPriceKopecks)}</strong>
              </div>
              <div className="record-kpi">
                <span>Остаток</span>
                <strong>{formatMoney(buyout.residualDebtKopecks)}</strong>
              </div>
              <div className="record-kpi">
                <span>Просрочка</span>
                <strong>{buyout.overdueDays}</strong>
              </div>
            </div>
            <div className="record-tags">
              <span className="tag-chip">start: {formatDate(buyout.startsAt)}</span>
              <span className="tag-chip">next: {formatDate(buyout.nextPaymentAt)}</span>
              <span className="tag-chip">penalties: {buyout._count.penalties}</span>
            </div>
            <div className="record-tags">
              {(buyout.paymentSchedules[0]?.items.length ?? 0) > 0 ? (
                buyout.paymentSchedules[0].items.map((item) => (
                  <span className="tag-chip" key={`${buyout.id}-${item.sequenceNumber}`}>
                    #{item.sequenceNumber} {formatDate(item.dueAt)} · {formatOutstanding(item.amountKopecks, item.paidKopecks)} · {item.status}
                  </span>
                ))
              ) : (
                <span className="tag-chip">schedule: будет создан после import commit</span>
              )}
            </div>
            <div className="record-actions">
              <Link className="detail-link" href={`/buyouts/${buyout.id}`}>
                Открыть карточку сделки
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
