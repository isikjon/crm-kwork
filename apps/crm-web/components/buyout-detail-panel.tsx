import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { BuyoutLifecycleAction } from "./buyout-lifecycle-action";
import { BuyoutPenaltyAction } from "./buyout-penalty-action";
import { DealContextPanel } from "./deal-context-panel";
import { DealDocumentAction } from "./deal-document-action";
import { DealProblemAction } from "./deal-problem-action";
import { DealPaymentAction } from "./deal-payment-action";
import { loadDocumentRegistry, loadDocumentTemplatesForSource } from "../lib/documents-api";
import { loadBuyoutDetail } from "../lib/buyouts-api";
import type { GpsSnapshotRecord } from "../lib/orders-api";

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

function formatCadenceLabel(value: string) {
  switch (value) {
    case "WEEKLY":
      return "еженедельно";
    case "MONTHLY":
      return "ежемесячно";
    case "BIWEEKLY":
      return "раз в две недели";
    default:
      return value;
  }
}

function formatBuyoutStatus(status: string) {
  switch (status) {
    case "NEW":
      return "Новый";
    case "ACTIVE":
      return "Активный";
    case "OVERDUE":
      return "Просрочен";
    case "HOLD":
      return "На паузе";
    case "CLOSED":
      return "Закрыт";
    case "TERMINATED":
      return "Прекращен";
    default:
      return status;
  }
}

function formatBikeStatus(status: string) {
  switch (status) {
    case "AVAILABLE":
      return "Свободен";
    case "RENTED":
      return "В аренде";
    case "BUYOUT":
      return "В выкупе";
    case "REPAIR":
      return "В ремонте";
    case "RESERVED":
      return "Зарезервирован";
    default:
      return status;
  }
}

function formatGpsSummary(gps: GpsSnapshotRecord | null) {
  if (!gps) {
    return "трекер не привязан";
  }

  if (gps.status === "ONLINE") {
    return "в сети";
  }

  if (gps.status === "OFFLINE") {
    return gps.offlineAgeLabel ? `не в сети · ${gps.offlineAgeLabel}` : "не в сети";
  }

  if (gps.status === "ERROR") {
    return "ошибка GPS";
  }

  if (gps.syncState === "ERROR" || gps.syncState === "STALE") {
    return "нужна проверка";
  }

  return "статус уточняется";
}

function getGpsTone(gps: GpsSnapshotRecord | null): "accent" | "warning" | "neutral" {
  if (!gps) {
    return "warning";
  }

  if (gps.status === "ONLINE" && gps.syncState === "FRESH") {
    return "accent";
  }

  if (gps.status === "ERROR" || gps.syncState === "ERROR" || gps.syncState === "STALE") {
    return "warning";
  }

  return "neutral";
}

function DetailFold(props: {
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="surface-card detail-collapsible">
      <summary className="detail-collapsible-summary">
        <div>
          <div className="surface-kicker">{props.kicker}</div>
          <h3>{props.title}</h3>
        </div>
        <span className="detail-collapsible-hint" />
      </summary>
      <div className="detail-collapsible-body">{props.children}</div>
    </details>
  );
}

export async function BuyoutDetailPanel({ dealId }: { dealId: string }) {
  const cookieHeader = (await cookies()).toString();
  const [{ data, apiBase, error }, templatesWorkspace, documentsWorkspace] = await Promise.all([
    loadBuyoutDetail(dealId, cookieHeader),
    loadDocumentTemplatesForSource("BUYOUT", cookieHeader),
    loadDocumentRegistry({
      sourceEntityType: "BUYOUT",
      sourceEntityId: dealId,
      limit: 12
    }, cookieHeader)
  ]);

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Карточка выкупа</div>
        <h3>Карточка выкупа пока недоступна</h3>
        <p className="route-card-note">
          Проверь `crm-api`, Prisma migration и import commit. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Поднять `crm-api` и PostgreSQL.</li>
          <li>Повторно выполнить `POST /api/v1/imports/legacy/commit`.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const { deal, tenant } = data;
  const activeDocumentTemplates = templatesWorkspace.data?.rows
    .filter((template) => template.isActive)
    .map((template) => ({
      id: template.id,
      kind: template.kind,
      name: template.name,
      nextDocumentNumber: template.nextDocumentNumber
    })) ?? [];
  const schedule = deal.paymentSchedules[0] ?? null;
  const defaultPaymentAmountKopecks = schedule?.items
    .map((item) => Math.max(0, item.amountKopecks - item.paidKopecks))
    .find((amount) => amount > 0)
    ?? schedule?.cycleAmountKopecks
    ?? deal.residualDebtKopecks;
  const dealStatusLabel = formatBuyoutStatus(deal.status);
  const bikeStatusLabel = formatBikeStatus(deal.bikeUnit.status);
  const heroSummary = [
    {
      label: "Клиент",
      value: deal.client.fullName
    },
    {
      label: "Велосипед",
      value: `${deal.bikeUnit.title} · ${bikeStatusLabel}`
    },
    {
      label: "Следующий платеж",
      value: `${formatMoney(defaultPaymentAmountKopecks)} руб. · ${formatDate(deal.nextPaymentAt)}`
    },
    {
      label: "Остаток",
      value: `${formatMoney(deal.residualDebtKopecks)} руб.`,
      tone: deal.residualDebtKopecks > 0 ? "warning" as const : "accent" as const
    },
    {
      label: "Просрочка",
      value: `${deal.overdueDays} дн.`,
      tone: deal.overdueDays > 0 ? "warning" as const : "neutral" as const
    },
    {
      label: "Первый взнос",
      value: `${formatMoney(deal.downPaymentKopecks)} руб.`
    },
    {
      label: "GPS",
      value: formatGpsSummary(deal.gps),
      tone: getGpsTone(deal.gps)
    },
    {
      label: "Точка",
      value: deal.branch?.name ?? "не выбрана"
    }
  ];
  const contextSummary = [
    {
      label: "Активных сделок у клиента",
      value: `${deal.client.activeDealsCount}`
    },
    {
      label: "Платежей у клиента",
      value: `${deal.client.paymentCount}`
    },
    {
      label: "Просрочек у клиента",
      value: `${deal.client.overdueCount}`,
      tone: deal.client.overdueCount > 0 ? "warning" as const : "neutral" as const
    },
    {
      label: "Статус велосипеда",
      value: bikeStatusLabel
    },
    {
      label: "План оплаты",
      value: `${formatCadenceLabel(deal.paymentCadence)} · ${deal.termMonths} мес.`
    },
    {
      label: "Точка",
      value: deal.branch?.name ?? "не выбрана"
    }
  ];
  const overviewRows = [
    {
      label: "Телефон",
      value: deal.client.primaryPhone ?? "не заполнен"
    },
    {
      label: "Telegram",
      value: deal.client.telegramHandle ?? "не заполнен"
    },
    {
      label: "Артикул / код",
      value: `${deal.bikeUnit.article ?? "не указан"} · ${deal.bikeUnit.internalCode}`
    },
    {
      label: "Модель",
      value: deal.bikeUnit.bikeModel?.name ?? "без модели"
    },
    {
      label: "Серийный номер",
      value: deal.bikeUnit.serialNumber ?? "не заполнен"
    },
    {
      label: "Старт сделки",
      value: formatDate(deal.startsAt)
    }
  ];

  return (
    <div className="detail-stack">
      <section className="detail-hero-card deal-main-hero-card">
        <Link className="detail-back-link" href="/orders">
          {"<-"} Назад к общему реестру заказов
        </Link>

        <div className="detail-hero-header">
          <div>
            <div className="detail-kicker">Выкуп · {tenant.name}</div>
            <h2 className="detail-title">{deal.dealNumber}</h2>
            <p className="detail-summary">
              {deal.client.fullName} · {deal.bikeUnit.title} · {deal.branch?.name ?? "без точки"}
            </p>
          </div>
          <div className="orders-simple-statuses">
            {deal.isProblem ? <span className="orders-simple-badge is-problem">Проблемы</span> : null}
            <span className="tag-chip">{dealStatusLabel}</span>
          </div>
        </div>

        <div className="deal-main-hero-summary-grid">
          {heroSummary.map((item) => (
            <div className={`deal-main-hero-summary-item${item.tone ? ` is-${item.tone}` : ""}`} key={`${item.label}-${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="deal-center-shell">
        <div className="deal-center-main">
          <article className="surface-card deal-center-operator-zone">
            <div className="surface-kicker">Работа по сделке</div>
            <div className="status-line">
              <h3>Деньги и следующие действия</h3>
              <span>{dealStatusLabel}</span>
            </div>
            <p className="route-card-note">
              Здесь собраны оплата, штрафы, проблемный флаг и закрытие выкупа без отдельного похода по модулям CRM.
            </p>

            <div className="record-tags deal-center-operator-tags">
              <span className="tag-chip">сумма выкупа: {formatMoney(deal.totalPriceKopecks)} руб.</span>
              <span className="tag-chip">взнос: {formatMoney(deal.downPaymentKopecks)} руб.</span>
              <span className={`tag-chip${deal.residualDebtKopecks > 0 ? " is-warning" : ""}`}>остаток: {formatMoney(deal.residualDebtKopecks)} руб.</span>
              <span className={`tag-chip${deal.overdueDays > 0 ? " is-warning" : ""}`}>просрочка: {deal.overdueDays} дн.</span>
              <span className="tag-chip">{deal.bank ? `банк: ${deal.bank.name}` : "банк не выбран"}</span>
            </div>

            <section className="deal-center-action-section">
              <div className="surface-kicker">Деньги</div>
              <h4>Оплата и штрафы</h4>
              <p className="route-card-note">Основной денежный контур выкупа: принять платеж и закрыть начисленные штрафы.</p>
              <div className="deal-center-actions-grid is-money-grid is-buyout-money-grid">
                <DealPaymentAction
                  bankId={deal.bank?.id ?? null}
                  bankName={deal.bank?.name ?? null}
                  dealId={deal.id}
                  dealKind="BUYOUT"
                  defaultAmountKopecks={defaultPaymentAmountKopecks}
                />

                <BuyoutPenaltyAction
                  autoPenaltyDailyKopecks={deal.autoPenaltyDailyKopecks}
                  autoPenaltyEnabled={deal.autoPenaltyEnabled}
                  bankId={deal.bank?.id ?? null}
                  bankName={deal.bank?.name ?? null}
                  penalties={deal.penalties}
                  overdueDays={deal.overdueDays}
                  buyoutId={deal.id}
                />
              </div>
            </section>

            <section className="deal-center-action-section">
              <div className="surface-kicker">Следующий шаг</div>
              <h4>Проблемный флаг и закрытие сделки</h4>
              <p className="route-card-note">Менеджер из этого блока ставит проблемный статус и закрывает выкуп после полной оплаты.</p>
              <div className="deal-center-actions-grid is-management-grid">
                <DealProblemAction
                  dealId={deal.id}
                  dealKind="BUYOUT"
                  isProblem={deal.isProblem}
                />

                <BuyoutLifecycleAction
                  buyoutId={deal.id}
                  penaltyCount={deal.penalties.filter((penalty) => penalty.status === "ACTIVE").length}
                  residualDebtKopecks={deal.residualDebtKopecks}
                  status={deal.status}
                />
              </div>
            </section>
          </article>

          <section className="deal-center-primary-block">
            <div className="surface-kicker">Документы</div>
            <div className="status-line">
              <h3>Документы по сделке</h3>
              <span>{documentsWorkspace.data?.rows.length ?? 0} шт.</span>
            </div>
            <p className="route-card-note">
              Выберите шаблон и выпустите документ прямо из сделки. После выпуска его можно сразу открыть, скачать или распечатать.
            </p>

            <DealDocumentAction
              sourceEntityId={deal.id}
              sourceEntityType="BUYOUT"
              templates={activeDocumentTemplates}
              issuedDocuments={documentsWorkspace.data?.rows ?? []}
            />
          </section>
        </div>

        <aside className="deal-center-side">
          <DealContextPanel
            bank={deal.bank}
            equipment={deal.equipment}
            gps={deal.gps}
            isProblem={deal.isProblem}
            kicker="Контекст сделки"
            overviewRows={overviewRows}
            status={dealStatusLabel}
            summaryItems={contextSummary}
            title="Клиент и велосипед"
          />
        </aside>
      </section>

      <section className="detail-grid-full">
        <DetailFold kicker="График" title="Платежи по выкупу">
          {schedule ? (
            <div className="schedule-list">
              {schedule.items.map((item) => (
                <div className="schedule-item" key={item.id}>
                  <div>
                    <div className="schedule-seq">Платеж #{item.sequenceNumber}</div>
                    <div className="timeline-meta">{item.status}</div>
                  </div>
                  <div>
                    <div className="detail-list-label">Дата платежа</div>
                    <div className="detail-list-value">{formatDate(item.dueAt)}</div>
                  </div>
                  <div>
                    <div className="detail-list-label">План / оплачено</div>
                    <div className="detail-list-value">
                      {formatMoney(item.amountKopecks)} / {formatMoney(item.paidKopecks)}
                    </div>
                  </div>
                  <div>
                    <div className="detail-list-label">Остаток / закрыт</div>
                    <div className="detail-list-value">
                      {formatMoney(Math.max(0, item.amountKopecks - item.paidKopecks))} / {formatDate(item.closedAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="route-card-note">График появится после import commit и rebuild schedules.</p>
          )}
        </DetailFold>
      </section>

      <section className="detail-grid">
        <DetailFold kicker="Комментарий" title="Комментарий по сделке">
          {deal.comment ? (
            <p className="detail-comment">{deal.comment}</p>
          ) : (
            <p className="route-card-note">Комментарий по сделке пока не заполнен.</p>
          )}
        </DetailFold>
      </section>

      <section className="detail-grid">
        <DetailFold kicker="Заметки" title="Заметки">
          {deal.notes.length > 0 ? (
            <div className="timeline-list">
              {deal.notes.map((note) => (
                <div className="timeline-item" key={note.id}>
                  <div>{note.text}</div>
                  <div className="timeline-meta">
                    {formatDate(note.createdAt)}{note.colorHex ? ` · ${note.colorHex}` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="route-card-note">Заметок по этому выкупу пока нет.</p>
          )}
        </DetailFold>

        <DetailFold kicker="История" title="Штрафы, залоги и уведомления">
          {deal.notifications.length > 0 || deal.penalties.length > 0 || deal.deposits.length > 0 ? (
            <div className="timeline-list">
              {deal.notifications.map((notification) => (
                <div className="timeline-item" key={notification.id}>
                  <div>{notification.channel} · {notification.status} · {notification.recipient}</div>
                  <div className="timeline-meta">
                    {formatDate(notification.sentAt ?? notification.createdAt)}
                  </div>
                </div>
              ))}
              {deal.penalties.map((penalty) => (
                <div className="timeline-item" key={penalty.id}>
                  <div>{penalty.reason} · {formatMoney(penalty.amountKopecks)} · {penalty.status}</div>
                  <div className="timeline-meta">
                    {formatDate(penalty.accrualDate)} · {penalty.mode}
                  </div>
                </div>
              ))}
              {deal.deposits.map((deposit) => (
                <div className="timeline-item" key={deposit.id}>
                  <div>Залог · {formatMoney(deposit.amountKopecks)} · {deposit.status}</div>
                  <div className="timeline-meta">
                    {formatDate(deposit.createdAt)} · возврат {formatMoney(deposit.refundedKopecks)}
                  </div>
                </div>
              ))}
              {deal.depositRefunds.map((refund) => (
                <div className="timeline-item" key={refund.id}>
                  <div>Возврат залога · {formatMoney(refund.amountKopecks)}</div>
                  <div className="timeline-meta">
                    {formatDate(refund.createdAt)}{refund.comment ? ` · ${refund.comment}` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="route-card-note">Пока нет записей по штрафам, залогам и уведомлениям.</p>
          )}
        </DetailFold>
      </section>
    </div>
  );
}
