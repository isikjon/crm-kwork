"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { OrderInlineDetailData, UnifiedOrdersListData } from "../lib/orders-api";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";
import { DealDocumentAction } from "./deal-document-action";
import { RentalDepositAction } from "./rental-deposit-action";

const DISPLAY_TIME_ZONE = "Europe/Moscow";

type OrderRow = UnifiedOrdersListData["rows"][number];
type OrderDetail = OrderInlineDetailData["deal"];
type PaymentMethod = "BANK" | "CASH";

const NOTE_COLOR_OPTIONS = [
  { label: "Красный", colorHex: "#b42318" },
  { label: "Коралловый", colorHex: "#ef4444" },
  { label: "Синий", colorHex: "#3b82f6" },
  { label: "Бирюзовый", colorHex: "#14b8a6" },
  { label: "Оранжевый", colorHex: "#f59e0b" },
  { label: "Зеленый", colorHex: "#22c55e" }
] as const;

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(Math.max(0, kopecks) / 100));
}

function formatDate(value: string | null) {
  if (!value) {
    return "не задана";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: DISPLAY_TIME_ZONE
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
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE
  }).format(new Date(value));
}

function getAttentionClass(code: string) {
  if (code === "OVERDUE") {
    return "is-overdue";
  }

  if (code === "TODAY") {
    return "is-today";
  }

  if (code === "DEBT") {
    return "is-debt";
  }

  return "is-ok";
}

function getMainStatusClass(code: string) {
  switch (code) {
    case "RENTAL":
      return "is-rental";
    case "BUYOUT":
      return "is-buyout";
    case "RENTAL_COMPLETED":
      return "is-rental-completed";
    case "BUYOUT_COMPLETED":
      return "is-buyout-completed";
    case "PROBLEM":
      return "is-problem";
    case "REPAIR":
      return "is-repair";
    default:
      return "is-ok";
  }
}

function getGpsStatusLabel(status: NonNullable<OrderRow["gps"]>["status"]) {
  switch (status) {
    case "ONLINE":
      return "GPS в сети";
    case "OFFLINE":
      return "GPS не в сети";
    case "ERROR":
      return "Ошибка GPS";
    default:
      return "GPS не подключен";
  }
}

function getGpsStatusClass(status: NonNullable<OrderRow["gps"]>["status"]) {
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

function getGpsSyncClass(syncState: NonNullable<OrderRow["gps"]>["syncState"]) {
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

function getGpsCompactHint(gps: NonNullable<OrderRow["gps"]>) {
  if (gps.lastSyncError || gps.syncState === "ERROR") {
    return "ошибка синхронизации";
  }

  if (gps.status === "OFFLINE") {
    return gps.offlineAgeLabel ?? "нет связи";
  }

  if (gps.syncState === "STALE") {
    return "давно не обновлялся";
  }

  if (gps.syncState === "WARNING") {
    return "нужна синхронизация";
  }

  return "связь стабильна";
}

function getPaymentTypeLabel(type: string) {
  switch (type) {
    case "RENTAL_PAYMENT_IN":
      return "Оплата аренды";
    case "BUYOUT_PAYMENT_IN":
      return "Оплата выкупа";
    case "PARTIAL_PAYMENT_IN":
      return "Частичная оплата";
    case "PENALTY_PAYMENT_IN":
      return "Оплата штрафа";
    case "DOWN_PAYMENT_IN":
      return "Первый взнос";
    default:
      return "Оплата";
  }
}

function buildRowKey(order: OrderRow) {
  return `${order.kind}:${order.id}`;
}

function buildDebtShortLine(order: OrderRow) {
  if (order.totalDueKopecks <= 0) {
    return "—";
  }

  if (order.penaltyBalanceKopecks > 0) {
    return `${formatMoney(order.totalDueKopecks)} · штраф ${formatMoney(order.penaltyBalanceKopecks)}`;
  }

  return formatMoney(order.totalDueKopecks);
}

function formatDepositSummary(deposit: OrderDetail["deposit"]) {
  if (!deposit) {
    return null;
  }

  return `${formatMoney(deposit.targetKopecks)} / ${formatMoney(deposit.collectedKopecks)} руб.`;
}

function formatDepositDisclosureCaption(deposit: OrderDetail["deposit"]) {
  if (!deposit) {
    return "залог не настроен";
  }

  const collected = formatMoney(deposit.collectedKopecks);
  const returned = formatMoney(deposit.returnedKopecks);
  return `принято ${collected} · возвращено ${returned}`;
}

function formatPenaltyReason(reason: string, mode?: string | null) {
  if (mode === "MANUAL") {
    return "Ручной штраф";
  }

  switch (reason.trim()) {
    case "AUTO_OVERDUE_DAILY":
      return "Автоштраф просрочки";
    case "MANUAL":
      return "Ручной штраф";
    default:
      return "Штраф";
  }
}

function formatPenaltyStatus(status: string) {
  switch (status) {
    case "ACTIVE":
      return "активен";
    case "PAID":
      return "оплачен";
    case "WAIVED":
      return "списан";
    case "DRAFT":
      return "черновик";
    default:
      return "штраф";
  }
}

function clampText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function withHexAlpha(colorHex: string, alphaHex: string) {
  const normalized = colorHex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(normalized) && /^[0-9a-f]{2}$/i.test(alphaHex)) {
    return `${normalized}${alphaHex}`;
  }

  return normalized;
}

function isNestedInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("a, button, input, select, textarea, summary, details, [data-stop-row-open='true']"))
    : false;
}

function OrderCollapsedNotes(props: {
  notes: Array<{
    id: string;
    text: string;
    colorHex: string | null;
    createdAt: string;
  }>;
}) {
  if (props.notes.length === 0) {
    return null;
  }

  const visibleNotes = props.notes.slice(0, 3);
  const hiddenCount = Math.max(0, props.notes.length - visibleNotes.length);

  return (
    <div className="orders-collapsed-notes" aria-label="Пометки по заказу">
      {visibleNotes.map((note) => (
        <span
          className="orders-collapsed-note-chip"
          key={note.id}
          style={note.colorHex ? {
            color: note.colorHex,
            borderColor: withHexAlpha(note.colorHex, "66"),
            backgroundColor: withHexAlpha(note.colorHex, "18")
          } : undefined}
          title={`${note.text} · ${formatDateTime(note.createdAt)}`}
        >
          {clampText(note.text, 22)}
        </span>
      ))}
      {hiddenCount > 0 ? <span className="orders-collapsed-note-more">+{hiddenCount}</span> : null}
    </div>
  );
}

function splitBikeTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  const parts = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return {
      primary: clampText(normalized, 56),
      secondary: null,
      full: normalized
    };
  }

  return {
    primary: clampText(parts[0] ?? normalized, 56),
    secondary: clampText(parts.slice(1).join(" · "), 92),
    full: normalized
  };
}

function shouldShowPaymentAction(detail: OrderDetail) {
  return detail.mainStatus.code === "RENTAL" || detail.mainStatus.code === "BUYOUT" || detail.mainStatus.code === "PROBLEM";
}

function CompactDisclosure(props: {
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <details className="orders-compact-disclosure">
      <summary className="orders-compact-disclosure-summary">
        <strong>{props.title}</strong>
        <span>{props.caption}</span>
      </summary>
      <div className="orders-compact-disclosure-body">{props.children}</div>
    </details>
  );
}

function OrderInlinePaymentAction(props: {
  deal: OrderDetail;
  onCompleted: () => void;
}) {
  const router = useRouter();
  const canPostPayment = useHasPermission(props.deal.kind === "RENTAL" ? "rentals.post_payment" : "buyouts.post_payment");
  const canPayPenalty = useHasPermission(props.deal.kind === "RENTAL" ? "rentals.pay_penalty" : "buyouts.pay_penalty");
  const [isPending, startTransition] = useTransition();
  const bankOptions = props.deal.availableBanks;
  const initialPaymentChoice = props.deal.bank?.id && bankOptions.some((bank) => bank.id === props.deal.bank?.id)
    ? `BANK:${props.deal.bank.id}`
    : "CASH";
  const [mainAmountRubles, setMainAmountRubles] = useState(String(Math.max(0, Math.round(props.deal.paymentAmountKopecks / 100))));
  const [paymentChoice, setPaymentChoice] = useState(initialPaymentChoice);
  const [selectedPenaltyIds, setSelectedPenaltyIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const paymentMethod: PaymentMethod = paymentChoice === "CASH" ? "CASH" : "BANK";
  const selectedBankId = paymentChoice.startsWith("BANK:") ? paymentChoice.slice(5) : null;
  const selectedBank = selectedBankId
    ? bankOptions.find((bank) => bank.id === selectedBankId) ?? null
    : null;
  const mainAmountKopecks = Math.max(0, Math.round(Number(mainAmountRubles || "0") * 100));
  const selectedPenalties = selectedPenaltyIds
    .map((penaltyId) => props.deal.penalties.find((penalty) => penalty.id === penaltyId) ?? null)
    .filter(Boolean) as OrderDetail["penalties"];
  const penaltiesAmountKopecks = selectedPenalties.reduce((sum, penalty) => sum + penalty.amountKopecks, 0);
  const totalAmountKopecks = mainAmountKopecks + penaltiesAmountKopecks;
  const canSubmitMainPart = mainAmountKopecks > 0;
  const canSubmitPenaltyPart = penaltiesAmountKopecks > 0;
  const bankRequiredButMissing = paymentMethod === "BANK" && !selectedBankId;
  const permissionBlocked = (canSubmitMainPart && !canPostPayment) || (canSubmitPenaltyPart && !canPayPenalty);
  const nothingAllocated = !canSubmitMainPart && !canSubmitPenaltyPart;

  function togglePenaltySelection(penaltyId: string) {
    setSelectedPenaltyIds((current) => (
      current.includes(penaltyId)
        ? current.filter((value) => value !== penaltyId)
        : [...current, penaltyId]
    ));
  }

  function submitPayment() {
    setError(null);
    setStatus(null);

    if (nothingAllocated || totalAmountKopecks <= 0) {
      setError("Укажите сумму на сделку или выберите штрафы для оплаты.");
      return;
    }

    if (bankRequiredButMissing) {
      setError("В заказе не выбран банк.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const endpoint = `${getApiBase()}/orders/${props.deal.kind}/${props.deal.id}/unified-payment`;
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            totalAmountKopecks,
            mainAmountKopecks,
            penaltyIds: selectedPenaltyIds,
            paymentMethod,
            bankId: paymentMethod === "BANK" ? selectedBankId ?? undefined : undefined,
            comment: comment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        const parts: string[] = [];
        if (payload?.totals?.mainAmountKopecks > 0) {
          parts.push(`${formatMoney(payload.totals.mainAmountKopecks)} руб. на ${props.deal.kind === "RENTAL" ? "сделку аренды" : "сделку выкупа"}`);
        }
        if (payload?.totals?.penaltiesAmountKopecks > 0) {
          parts.push(`${formatMoney(payload.totals.penaltiesAmountKopecks)} руб. на штрафы`);
        }
        const periodsHint = payload?.mainCoveredPeriodsCount > 0
          ? ` Закрыто периодов: ${payload.mainCoveredPeriodsCount}.`
          : "";
        setStatus(`Платеж разнесен: ${parts.join(", ")}.${periodsHint}`);
        setSelectedPenaltyIds([]);
        props.onCompleted();
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось подтвердить оплату.");
      }
    });
  }

  return (
    <section className="orders-expand-payment orders-mobile-payment-card">
      <div className="orders-expand-title-row orders-expand-title-row-payment">
        <div className="orders-payment-title-copy">
          <strong>Единый платеж</strong>
          <span>Один платеж с разнесением по сделке и штрафам</span>
        </div>
      </div>

      <div className="orders-payment-summary-row">
        <div className="orders-payment-summary-context">
          <span>К оплате</span>
          <strong>{formatMoney(props.deal.totalDueKopecks)} руб.</strong>
          <small>текущий долг по сделке</small>
        </div>

        <div className="orders-payment-summary-breakdown">
          <div className="orders-payment-summary-item is-main">
            <span>На сделку</span>
            <strong>{formatMoney(mainAmountKopecks)} руб.</strong>
            <small>{props.deal.kind === "RENTAL" ? "продлевает период" : "идет в график выкупа"}</small>
          </div>

          <div className="orders-payment-summary-item">
            <span>На штрафы</span>
            <strong>{formatMoney(penaltiesAmountKopecks)} руб.</strong>
            <small>не двигает следующую дату</small>
          </div>

          <div className="orders-payment-summary-item is-total">
            <span>Итог</span>
            <strong>{formatMoney(totalAmountKopecks)} руб.</strong>
            <small>общий платеж клиента</small>
          </div>
        </div>
      </div>

      <div className="orders-inline-payment-grid orders-inline-payment-grid-primary">
        <label className="action-field">
          <span>{props.deal.kind === "RENTAL" ? "На аренду, руб." : "На выкуп, руб."}</span>
          <input
            className="action-input"
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={mainAmountRubles}
            onChange={(event) => setMainAmountRubles(event.target.value)}
          />
        </label>

        <label className="action-field">
          <span>Куда провести</span>
          <select
            className="action-input"
            value={paymentChoice}
            onChange={(event) => setPaymentChoice(event.target.value)}
          >
            <option value="CASH">Наличные</option>
            {bankOptions.map((bank) => (
              <option key={bank.id} value={`BANK:${bank.id}`}>
                {bank.name}
              </option>
            ))}
          </select>
        </label>

        <div className="orders-inline-payment-submit">
          <button
            className="action-button"
            disabled={permissionBlocked || isPending || nothingAllocated || totalAmountKopecks <= 0 || bankRequiredButMissing}
            type="button"
            onClick={submitPayment}
          >
            {isPending ? "Сохраняю..." : "Подтвердить оплату"}
          </button>
        </div>
      </div>

      {props.deal.penalties.length > 0 ? (
        <div className="orders-inline-payment-penalties">
          <div className="orders-inline-payment-penalties-head">
            <strong>Штрафы в этом платеже</strong>
            <span>{canSubmitPenaltyPart ? `${selectedPenalties.length} выбрано` : "войдут в этот платеж"}</span>
          </div>
          <div className="orders-inline-payment-penalty-list">
            {props.deal.penalties.map((penalty) => {
              const isSelected = selectedPenaltyIds.includes(penalty.id);
              return (
                <label
                  className={["orders-inline-payment-penalty", isSelected ? "is-selected" : ""].join(" ").trim()}
                  key={penalty.id}
                >
                  <input
                    checked={isSelected}
                    disabled={!canPayPenalty || isPending}
                    type="checkbox"
                    onChange={() => togglePenaltySelection(penalty.id)}
                  />
                  <div>
                    <strong>{formatMoney(penalty.amountKopecks)} руб.</strong>
                    <span>{formatPenaltyReason(penalty.reason, penalty.mode)} · {formatDate(penalty.accrualDate)}</span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="orders-inline-payment-footer">
        <div className="orders-expand-tags orders-expand-tags-inline">
          <span className="tag-chip">{paymentMethod === "BANK" ? (selectedBank?.name ?? "Банк не выбран") : "Наличные"}</span>
          <span className="tag-chip is-neutral">разнесено {formatMoney(totalAmountKopecks)} руб.</span>
          {bankRequiredButMissing ? (
            <span className="tag-chip is-danger">в заказе не выбран банк</span>
          ) : null}
          {canSubmitPenaltyPart && !canPayPenalty ? (
            <span className="tag-chip is-danger">нет права на оплату штрафов</span>
          ) : null}
        </div>

        <details className="orders-inline-payment-comment-toggle">
          <summary>Комментарий к оплате</summary>
          <div className="orders-inline-payment-comment-body">
            <label className="action-field orders-inline-payment-comment">
              <span>Комментарий</span>
              <input
                className="action-input"
                placeholder="Необязательно"
                type="text"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </label>
          </div>
        </details>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {permissionBlocked ? <p className="route-card-note">Недостаточно прав для выбранного разнесения платежа.</p> : null}
      {!permissionBlocked && nothingAllocated ? <p className="route-card-note">Укажите сумму на сделку или добавьте штрафы в этот же платеж.</p> : null}
    </section>
  );
}

function OrderInlineNotesAction(props: {
  deal: OrderDetail;
  onCompleted: () => void;
}) {
  const canEditNotes = useHasPermission("orders.edit");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [selectedColorHex, setSelectedColorHex] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);

  function selectColor(colorHex: string) {
    setSelectedColorHex((current) => (current === colorHex ? null : colorHex));
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function submitNote() {
    const text = draft.replace(/\s+/g, " ").trim();
    setStatus(null);
    setError(null);

    if (!text) {
      setError("Введите текст пометки.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/orders/${props.deal.kind}/${props.deal.id}/notes`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            text,
            colorHex: selectedColorHex ?? undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setDraft("");
        setSelectedColorHex(null);
        setStatus("Пометка сохранена.");
        props.onCompleted();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить пометку.");
      }
    });
  }

  function removeNote(noteId: string) {
    setStatus(null);
    setError(null);
    setDeletingNoteId(noteId);

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(
          `${getApiBase()}/orders/${props.deal.kind}/${props.deal.id}/notes/${noteId}?tenantSlug=${encodeURIComponent(tenantSlug)}`,
          {
            method: "DELETE",
            credentials: "include"
          }
        );

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Пометка удалена.");
        props.onCompleted();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось удалить пометку.");
      } finally {
        setDeletingNoteId((current) => (current === noteId ? null : current));
      }
    });
  }

  return (
    <section className="orders-expand-card orders-inline-notes-card">
      <div className="orders-expand-title-row">
        <strong>Новая пометка</strong>
        <span className="orders-expand-muted">
          {props.deal.notes.length > 0 ? `${props.deal.notes.length} заметок` : "пока пусто"}
        </span>
      </div>

      {props.deal.comment ? (
        <div className="orders-expand-note-chip is-comment">
          <strong>Комментарий к заказу</strong>
          <span>{props.deal.comment}</span>
        </div>
      ) : null}

      <div className="orders-inline-note-compose">
        <label className="action-field orders-inline-note-field">
          <span>Текст пометки</span>
          <input
            ref={inputRef}
            className="action-input"
            disabled={!canEditNotes || isPending}
            maxLength={240}
            placeholder="Напишите пометку"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>

        <button
          className="action-button"
          disabled={!canEditNotes || isPending || !draft.trim()}
          type="button"
          onClick={submitNote}
        >
          {isPending ? "Сохраняю..." : "Добавить"}
        </button>
      </div>

      <div className="orders-inline-note-palette">
        <span className="orders-inline-note-palette-label">Цвет пометки</span>
        <div className="orders-inline-note-swatches">
          {NOTE_COLOR_OPTIONS.map((option) => {
            const isSelected = selectedColorHex === option.colorHex;

            return (
              <button
                key={option.colorHex}
                aria-label={option.label}
                aria-pressed={isSelected}
                className={["orders-inline-note-swatch", isSelected ? "is-selected" : ""].join(" ").trim()}
                disabled={!canEditNotes || isPending}
                style={{
                  borderColor: withHexAlpha(option.colorHex, isSelected ? "cc" : "45"),
                  backgroundColor: withHexAlpha(option.colorHex, isSelected ? "20" : "10")
                }}
                title={option.label}
                type="button"
                onClick={() => selectColor(option.colorHex)}
              >
                <span
                  aria-hidden="true"
                  className="orders-inline-note-swatch-core"
                  style={{ backgroundColor: option.colorHex }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {props.deal.notes.length > 0 ? (
        <div className="orders-inline-note-list">
          {props.deal.notes.map((note) => (
            <div
              className="orders-inline-note-entry"
              key={note.id}
              style={note.colorHex ? {
                borderColor: withHexAlpha(note.colorHex, "44"),
                backgroundColor: withHexAlpha(note.colorHex, "10")
              } : undefined}
              title={formatDateTime(note.createdAt)}
            >
              <strong>{note.text}</strong>
              {canEditNotes ? (
                <button
                  aria-label={`Удалить пометку ${note.text}`}
                  className="orders-inline-note-remove"
                  disabled={isPending || deletingNoteId === note.id}
                  type="button"
                  onClick={() => removeNote(note.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="orders-expand-note is-muted">Заметок по этой сделке пока нет.</p>
      )}

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canEditNotes ? <p className="route-card-note">Недостаточно прав для добавления пометок.</p> : null}
    </section>
  );
}

function OrderInlinePenaltyAction(props: {
  deal: OrderDetail;
  onCompleted: () => void;
}) {
  const tenantSlug = getCurrentTenantSlugBrowser();
  const canManageRentalPenalty = useHasPermission("rentals.manage_penalty");
  const canManualRentalPenalty = useHasPermission("rentals.manual_penalty");
  const canManualBuyoutPenalty = useHasPermission("buyouts.manual_penalty");
  const [isPending, startTransition] = useTransition();
  const [manualAmountRubles, setManualAmountRubles] = useState("0");
  const [manualReason, setManualReason] = useState(props.deal.kind === "RENTAL" ? "Просрочка аренды" : "Просрочка выкупа");
  const [manualComment, setManualComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManualPenalty = props.deal.kind === "RENTAL" ? canManualRentalPenalty : canManualBuyoutPenalty;
  const canRunAutoPenalty = props.deal.kind === "RENTAL" && canManageRentalPenalty;
  const amountKopecks = Math.max(0, Math.round(Number(manualAmountRubles || "0") * 100));

  useEffect(() => {
    setManualReason(props.deal.kind === "RENTAL" ? "Просрочка аренды" : "Просрочка выкупа");
  }, [props.deal.kind]);

  function submitManualPenalty() {
    setError(null);
    setStatus(null);

    if (amountKopecks <= 0) {
      setError("Укажите сумму штрафа больше нуля.");
      return;
    }

    if (!manualReason.trim()) {
      setError("Укажите причину штрафа.");
      return;
    }

    startTransition(async () => {
      try {
        const endpoint = `${getApiBase()}/${props.deal.kind === "RENTAL" ? "rentals" : "buyouts"}/${props.deal.id}/penalties/manual`;
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            amountKopecks,
            reason: manualReason.trim(),
            comment: manualComment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setManualAmountRubles("0");
        setManualComment("");
        setStatus("Штраф начислен. Обновляю заказ...");
        props.onCompleted();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось начислить штраф.");
      }
    });
  }

  function runAutoPenalty() {
    if (props.deal.kind !== "RENTAL") {
      return;
    }

    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.deal.id}/penalties/auto-run`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            comment: "Пересчет автоштрафов из заказа"
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Автоштрафы пересчитаны. Обновляю заказ...");
        props.onCompleted();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось пересчитать автоштрафы.");
      }
    });
  }

  return (
    <section className="orders-expand-card orders-inline-penalties-card">
      <div className="orders-expand-title-row">
        <strong>Штрафы</strong>
        <span className="orders-expand-muted">
          {props.deal.penaltyHistory.length > 0 ? `${props.deal.penaltyHistory.length} начислений` : "пока пусто"}
        </span>
      </div>

      <p className="route-card-note">
        Здесь остаются начисление и автологика. Оплата штрафов проходит только через единый платеж этой сделки.
      </p>

      <div className="orders-expand-tags">
        <span className={`tag-chip${props.deal.penaltyBalanceKopecks > 0 ? " is-warning" : ""}`}>
          активно: {formatMoney(props.deal.penaltyBalanceKopecks)} руб.
        </span>
        <span className="tag-chip is-neutral">активных штрафов: {props.deal.penalties.length}</span>
        <span className="tag-chip">{props.deal.autoPenaltyEnabled ? "автоштраф включен" : "автоштраф выключен"}</span>
        <span className="tag-chip is-neutral">в день: {formatMoney(props.deal.autoPenaltyDailyKopecks)} руб.</span>
      </div>

      <div className="orders-inline-penalty-grid">
        <label className="action-field">
          <span>Сумма штрафа, руб.</span>
          <input
            className="action-input"
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={manualAmountRubles}
            onChange={(event) => setManualAmountRubles(event.target.value)}
          />
        </label>

        <label className="action-field">
          <span>Причина</span>
          <input
            className="action-input"
            maxLength={140}
            type="text"
            value={manualReason}
            onChange={(event) => setManualReason(event.target.value)}
          />
        </label>

        <label className="action-field orders-inline-penalty-comment">
          <span>Комментарий</span>
          <input
            className="action-input"
            maxLength={240}
            placeholder="Необязательно"
            type="text"
            value={manualComment}
            onChange={(event) => setManualComment(event.target.value)}
          />
        </label>
      </div>

      <div className="orders-inline-penalty-actions">
        <button
          className="action-button"
          disabled={!canManualPenalty || isPending || amountKopecks <= 0 || !manualReason.trim()}
          type="button"
          onClick={submitManualPenalty}
        >
          {isPending ? "Начисляю..." : "Начислить штраф"}
        </button>

        {props.deal.kind === "RENTAL" ? (
          <button
            className="action-button is-secondary"
            disabled={!canRunAutoPenalty || isPending || !props.deal.autoPenaltyEnabled || props.deal.autoPenaltyDailyKopecks <= 0}
            type="button"
            onClick={runAutoPenalty}
          >
            {isPending ? "Считаю..." : "Пересчитать автоштрафы"}
          </button>
        ) : null}
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canManualPenalty ? <p className="route-card-note">Недостаточно прав для начисления штрафов.</p> : null}
      {props.deal.kind === "RENTAL" && props.deal.autoPenaltyEnabled && !canRunAutoPenalty ? (
        <p className="route-card-note">Недостаточно прав для пересчета автоштрафов.</p>
      ) : null}
      {props.deal.kind === "RENTAL" && props.deal.autoPenaltyEnabled && props.deal.autoPenaltyDailyKopecks <= 0 ? (
        <p className="route-card-note">Автоштраф включен, но дневная сумма не настроена.</p>
      ) : null}
    </section>
  );
}

function OrderExpandContent(props: {
  detail: OrderDetail;
  onRefresh: () => void;
}) {
  const debtExists = props.detail.totalDueKopecks > 0;
  const bikeTitle = splitBikeTitle(props.detail.bikeUnit.title);
  const paymentsPreview = props.detail.payments.slice(0, 4);
  const equipmentPreview = props.detail.equipment.slice(0, 5);
  const depositSummary = props.detail.kind === "RENTAL" ? formatDepositSummary(props.detail.deposit) : null;
  const penaltiesPreview = props.detail.penalties.slice(0, 3);
  const hiddenPenaltiesCount = Math.max(0, props.detail.penalties.length - penaltiesPreview.length);

  return (
    <div className="orders-expand-shell">
      <section className={["orders-expand-debt", debtExists ? "is-alert" : "is-ok"].join(" ")}>
        <div className="orders-expand-title-row">
          <strong>{debtExists ? "Долг по заказу" : "По заказу все в графике"}</strong>
          <span className="orders-expand-muted">{props.detail.dealNumber}</span>
        </div>

        <div className="orders-expand-debt-values">
          <div>
            <span>Всего к оплате</span>
            <strong>{formatMoney(props.detail.totalDueKopecks)} руб.</strong>
          </div>
          <div>
            <span>По графику</span>
            <strong>{formatMoney(props.detail.debtKopecks)} руб.</strong>
          </div>
          <div>
            <span>Штрафы</span>
            <strong>{formatMoney(props.detail.penaltyBalanceKopecks)} руб.</strong>
            {penaltiesPreview.length > 0 ? (
              <div className="orders-expand-metric-preview">
                {penaltiesPreview.map((penalty) => (
                  <span key={penalty.id}>
                    {formatMoney(penalty.amountKopecks)} руб. — {formatPenaltyReason(penalty.reason, penalty.mode)} — {formatDate(penalty.accrualDate)}
                  </span>
                ))}
                {hiddenPenaltiesCount > 0 ? <span>+ еще {hiddenPenaltiesCount}</span> : null}
              </div>
            ) : null}
          </div>
          <div>
            <span>Следующая дата</span>
            <strong>{formatDate(props.detail.nextPaymentAt)}</strong>
          </div>
          {depositSummary ? (
            <div>
              <span>Залог</span>
              <strong>{depositSummary}</strong>
              <small className="orders-expand-metric-hint">положено / получено</small>
            </div>
          ) : null}
        </div>

        <div className="orders-expand-tags">
          <span className={["orders-simple-badge", getMainStatusClass(props.detail.mainStatus.code)].join(" ")}>
            {props.detail.mainStatus.label}
          </span>
          {props.detail.attention.code !== "OK" && props.detail.mainStatus.code !== "PROBLEM" ? (
            <span className={["orders-simple-badge", `is-${props.detail.attention.code.toLowerCase()}`].join(" ")}>
              {props.detail.attention.label}
            </span>
          ) : null}
          {props.detail.overdueDays > 0 ? (
            <span className="tag-chip">просрочка {props.detail.overdueDays} дн.</span>
          ) : null}
          {props.detail.paymentSchedule ? (
            <span className="tag-chip">
              цикл {formatMoney(props.detail.paymentSchedule.cycleAmountKopecks)} руб.
            </span>
          ) : null}
        </div>

      </section>

      <div className={["orders-expand-primary-grid", shouldShowPaymentAction(props.detail) ? "" : "is-context-only"].join(" ").trim()}>
        <div className="orders-expand-main-column">
          {shouldShowPaymentAction(props.detail) ? (
            <OrderInlinePaymentAction deal={props.detail} onCompleted={props.onRefresh} />
          ) : null}

          {props.detail.kind === "RENTAL" && props.detail.deposit ? (
            <CompactDisclosure
              caption={formatDepositDisclosureCaption(props.detail.deposit)}
              title="Залог"
            >
              <RentalDepositAction
                availableBanks={props.detail.availableBanks}
                depositCollectedKopecks={props.detail.deposit.collectedKopecks}
                depositReturnedKopecks={props.detail.deposit.returnedKopecks}
                depositTargetKopecks={props.detail.deposit.targetKopecks}
                depositTransactions={props.detail.deposit.transactions}
                rentalId={props.detail.id}
                onCompleted={props.onRefresh}
              />
            </CompactDisclosure>
          ) : null}

          <OrderInlinePenaltyAction deal={props.detail} onCompleted={props.onRefresh} />

          <section className="orders-expand-card orders-inline-documents-card">
            <div className="orders-expand-title-row">
              <strong>Документы</strong>
              <span className="orders-expand-muted">печать и выпуск прямо из заказа</span>
            </div>
            <DealDocumentAction
              compact
              onCompleted={props.onRefresh}
              sourceEntityId={props.detail.id}
              sourceEntityType={props.detail.kind}
            />
          </section>

          <div className="orders-expand-secondary-stack">
            <CompactDisclosure
              caption={props.detail.payments.length > 0 ? `${props.detail.payments.length} оплат` : "оплат пока нет"}
              title="История оплат"
            >
              {paymentsPreview.length > 0 ? (
                <div className="orders-expand-inline-list is-compact">
                  {paymentsPreview.map((payment) => (
                    <div className="orders-expand-inline-row is-compact" key={payment.id}>
                      <strong>{formatMoney(payment.amountKopecks)} руб.</strong>
                      <span>{getPaymentTypeLabel(payment.type)}</span>
                      <span>{formatDateTime(payment.happenedAt)}</span>
                    </div>
                  ))}
                  {props.detail.payments.length > paymentsPreview.length ? (
                    <p className="orders-expand-note is-muted">
                      Еще {props.detail.payments.length - paymentsPreview.length} оплат в полной карточке.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="orders-expand-note is-muted">Оплат пока нет.</p>
              )}
            </CompactDisclosure>

            <CompactDisclosure
              caption={props.detail.penaltyHistory.length > 0 ? `${props.detail.penaltyHistory.length} записей` : "штрафов пока нет"}
              title="История штрафов"
            >
              {props.detail.penaltyHistory.length > 0 ? (
                <div className="orders-expand-inline-list is-compact">
                  {props.detail.penaltyHistory.slice(0, 6).map((penalty) => (
                    <div className="orders-expand-inline-row is-compact" key={penalty.id}>
                      <strong>{formatMoney(penalty.amountKopecks)} руб.</strong>
                      <span>{formatPenaltyReason(penalty.reason, penalty.mode)} · {formatPenaltyStatus(penalty.status)} · {formatDate(penalty.accrualDate)}</span>
                      {penalty.comment ? <span>{penalty.comment}</span> : null}
                    </div>
                  ))}
                  {props.detail.penaltyHistory.length > 6 ? (
                    <p className="orders-expand-note is-muted">
                      Еще {props.detail.penaltyHistory.length - 6} штрафов в полной карточке.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="orders-expand-note is-muted">Штрафов по этой сделке пока нет.</p>
              )}
            </CompactDisclosure>

          </div>
        </div>

        <div className="orders-expand-side-column">
          <OrderInlineNotesAction deal={props.detail} onCompleted={props.onRefresh} />

          <section className="orders-expand-card orders-expand-context-card">
            <div className="orders-expand-title-row">
              <strong>Велосипед и банк</strong>
            </div>

            <div className="orders-context-compact-shell">
              <div className="orders-context-stack">
                <div className="orders-context-summary-card is-bike" title={bikeTitle.full}>
                  <span>Велосипед</span>
                  <strong>{bikeTitle.primary}</strong>
                  <small>
                    Код {props.detail.bikeUnit.internalCode}
                    {props.detail.bikeUnit.article ? ` · Артикул ${props.detail.bikeUnit.article}` : ""}
                  </small>
                  {bikeTitle.secondary ? <small>{bikeTitle.secondary}</small> : null}
                </div>

                <div className="orders-context-summary-card">
                  <span>Банк</span>
                  <strong>{props.detail.bank?.name ?? "не выбран"}</strong>
                  <small>
                    {props.detail.bank
                      ? (props.detail.bank.instructionType === "QR" ? "QR для клиента" : "Реквизиты для клиента")
                      : "Выберите банк в денежном блоке"}
                  </small>
                </div>
              </div>

              {props.detail.equipment.length > 0 ? (
                <div className="orders-equipment-inline-block">
                  <strong className="orders-inline-section-title">Комплект</strong>
                  <div className="orders-expand-tags">
                    {equipmentPreview.map((item) => (
                      <span className="tag-chip" key={item.id} title={item.comment ? `${item.label} (${item.comment})` : item.label}>
                        {item.label}{item.quantity > 1 ? ` ×${item.quantity}` : ""}
                      </span>
                    ))}
                  </div>
                  {equipmentPreview.some((item) => item.comment) ? (
                    <div className="orders-expand-inline-list is-compact">
                      {equipmentPreview
                        .filter((item) => item.comment)
                        .map((item) => (
                          <div className="orders-expand-inline-row is-compact" key={`${item.id}-comment`}>
                            <strong>{item.label}</strong>
                            <span>{item.comment}</span>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="orders-expand-note is-muted">Доп. оборудование не выдавалось.</p>
              )}
            </div>
          </section>
        </div>
      </div>

    </div>
  );
}

export function OrdersRegistryClient(props: {
  rows: UnifiedOrdersListData["rows"];
  initialFocusDeal?: {
    kind: OrderRow["kind"];
    id: string;
  } | null;
}) {
  const router = useRouter();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detailsByKey, setDetailsByKey] = useState<Record<string, OrderDetail>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const mobileRefs = useRef<Record<string, HTMLElement | null>>({});

  async function loadDetail(order: OrderRow, force = false) {
    const rowKey = buildRowKey(order);
    if (!force && detailsByKey[rowKey]) {
      return;
    }

    setLoadingKey(rowKey);
    setErrorByKey((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });

    try {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const response = await fetch(`${getApiBase()}/orders/${order.kind}/${order.id}/expand?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
        cache: "no-store",
        credentials: "include"
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }

      setDetailsByKey((current) => ({
        ...current,
        [rowKey]: payload.deal
      }));
    } catch (requestError) {
      setErrorByKey((current) => ({
        ...current,
        [rowKey]: requestError instanceof Error ? requestError.message : "Не удалось открыть заказ."
      }));
    } finally {
      setLoadingKey((current) => (current === rowKey ? null : current));
    }
  }

  function toggleRow(order: OrderRow) {
    const rowKey = buildRowKey(order);
    if (expandedKey === rowKey) {
      setExpandedKey(null);
      return;
    }

    setExpandedKey(rowKey);
    void loadDetail(order);
  }

  function openOrder(order: OrderRow) {
    router.push(order.detailHref as Route);
  }

  function handleRowOpen(order: OrderRow, event: ReactMouseEvent<HTMLElement>) {
    if (isNestedInteractiveTarget(event.target)) {
      return;
    }

    openOrder(order);
  }

  function handleRowOpenKeyDown(order: OrderRow, event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    if (isNestedInteractiveTarget(event.target)) {
      return;
    }

    event.preventDefault();
    openOrder(order);
  }

  useEffect(() => {
    if (autoOpenedRef.current || !props.initialFocusDeal) {
      return;
    }

    const targetOrder = props.rows.find((row) => row.kind === props.initialFocusDeal?.kind && row.id === props.initialFocusDeal?.id);
    if (!targetOrder) {
      return;
    }

    const rowKey = buildRowKey(targetOrder);
    autoOpenedRef.current = true;
    setExpandedKey(rowKey);
    setFocusedKey(rowKey);
    void loadDetail(targetOrder);

    window.setTimeout(() => {
      const targetNode = window.matchMedia("(max-width: 920px)").matches
        ? mobileRefs.current[rowKey]
        : rowRefs.current[rowKey];
      targetNode?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 160);

    window.setTimeout(() => {
      setFocusedKey((current) => (current === rowKey ? null : current));
    }, 2600);
  }, [props.initialFocusDeal, props.rows]);

  return (
    <>
      <div className="orders-simple-table-wrap">
        <table className="orders-simple-table orders-phase1-table">
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Статус</th>
              <th>След. оплата</th>
              <th>Долг</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((order) => {
              const rowKey = buildRowKey(order);
              const detail = detailsByKey[rowKey];
              const isExpanded = expandedKey === rowKey;
              const isLoading = loadingKey === rowKey;
              const error = errorByKey[rowKey];
              const rowNotes = detail?.notes ?? order.notes;

              return (
                <Fragment key={rowKey}>
                  <tr
                    className={[
                      "orders-simple-row",
                      "orders-phase1-row",
                      getAttentionClass(order.attention.code),
                      focusedKey === rowKey ? "is-focused" : "",
                      !isExpanded ? "is-openable" : ""
                    ].join(" ").trim()}
                    key={rowKey}
                    role={!isExpanded ? "link" : undefined}
                    ref={(node) => {
                      rowRefs.current[rowKey] = node;
                    }}
                    tabIndex={!isExpanded ? 0 : -1}
                    onClick={!isExpanded ? (event) => handleRowOpen(order, event) : undefined}
                    onKeyDown={!isExpanded ? (event) => handleRowOpenKeyDown(order, event) : undefined}
                  >
                    <td data-label="Клиент">
                      <div className="orders-row-primary">
                        <button
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? "Свернуть заказ" : "Развернуть заказ"}
                          className={["orders-inline-arrow", isExpanded ? "is-open" : ""].join(" ").trim()}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleRow(order);
                          }}
                        >
                          <span aria-hidden="true">▸</span>
                        </button>

                        <div className="orders-simple-client">
                          <Link
                            className="orders-inline-row-link"
                            href={order.client.detailHref as Route}
                            onClick={(event) => {
                              event.stopPropagation();
                            }}
                          >
                            {order.client.fullName}
                          </Link>
                          <div className="orders-simple-client-meta">{order.dealNumber}</div>
                          {order.gps ? (
                            <div className="orders-simple-gps-inline">
                              <span className={["gps-chip", getGpsStatusClass(order.gps.status)].join(" ").trim()}>
                                <span className="gps-chip-dot" aria-hidden="true" />
                                <span>{getGpsStatusLabel(order.gps.status)}</span>
                              </span>
                              {order.gps.offlineAgeLabel ? (
                                <span className={["gps-age", order.gps.status === "ONLINE" ? "is-live" : getGpsSyncClass(order.gps.syncState) || "is-warning"].join(" ").trim()}>
                                  {order.gps.offlineAgeLabel}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          {!isExpanded && rowNotes.length > 0 ? <OrderCollapsedNotes notes={rowNotes} /> : null}
                        </div>
                      </div>
                    </td>
                    <td data-label="Статус">
                      <div className="orders-simple-statuses">
                        <span className={["orders-simple-badge", getMainStatusClass(order.mainStatus.code)].join(" ")}>
                          {order.mainStatus.label}
                        </span>
                        {order.attention.code !== "OK" && order.mainStatus.code !== "PROBLEM" ? (
                          <span className={["orders-simple-badge", `is-${order.attention.code.toLowerCase()}`].join(" ")}>
                            {order.attention.label}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="След. оплата">
                      <div className="orders-simple-date">{formatDate(order.nextPaymentAt)}</div>
                    </td>
                    <td data-label="Долг">
                      <div className="orders-simple-money-cell">
                        <div className={["orders-simple-money", order.totalDueKopecks > 0 ? "is-danger" : ""].join(" ").trim()}>
                          {buildDebtShortLine(order)}
                        </div>
                        <button
                          className="action-button is-secondary orders-row-open-button"
                          data-stop-row-open="true"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openOrder(order);
                          }}
                        >
                          Открыть заказ
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr className="orders-expand-row" key={`${rowKey}-expand`}>
                      <td colSpan={4}>
                        {isLoading && !detail ? (
                          <div className="orders-expand-loading">Загружаю заказ...</div>
                        ) : error ? (
                          <div className="orders-expand-error">
                            <p>{error}</p>
                            <button className="action-button is-secondary" type="button" onClick={() => loadDetail(order, true)}>
                              Повторить
                            </button>
                          </div>
                        ) : detail ? (
                          <OrderExpandContent detail={detail} onRefresh={() => loadDetail(order, true)} />
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="orders-simple-mobile">
        {props.rows.map((order) => {
          const rowKey = buildRowKey(order);
          const detail = detailsByKey[rowKey];
          const isExpanded = expandedKey === rowKey;
          const isLoading = loadingKey === rowKey;
          const error = errorByKey[rowKey];
          const rowNotes = detail?.notes ?? order.notes;

          return (
            <article
              className={[
                "orders-simple-mobile-card",
                getAttentionClass(order.attention.code),
                focusedKey === rowKey ? "is-focused" : "",
                !isExpanded ? "is-openable" : ""
              ].join(" ").trim()}
              key={`mobile-${rowKey}`}
              role={!isExpanded ? "link" : undefined}
              ref={(node) => {
                mobileRefs.current[rowKey] = node;
              }}
              tabIndex={!isExpanded ? 0 : -1}
              onClick={!isExpanded ? (event) => handleRowOpen(order, event) : undefined}
              onKeyDown={!isExpanded ? (event) => handleRowOpenKeyDown(order, event) : undefined}
            >
              <div className="orders-simple-mobile-top">
                <div className="orders-row-primary">
                  <button
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? "Свернуть заказ" : "Развернуть заказ"}
                    className={["orders-inline-arrow", isExpanded ? "is-open" : ""].join(" ").trim()}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleRow(order);
                    }}
                  >
                    <span aria-hidden="true">▸</span>
                  </button>
                  <div>
                    <Link
                      className="orders-inline-row-link"
                      href={order.client.detailHref as Route}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      {order.client.fullName}
                    </Link>
                    <div className="orders-simple-client-meta">{order.dealNumber}</div>
                    {order.gps ? (
                      <div className="orders-simple-gps-inline">
                        <span className={["gps-chip", getGpsStatusClass(order.gps.status)].join(" ").trim()}>
                          <span className="gps-chip-dot" aria-hidden="true" />
                          <span>{getGpsStatusLabel(order.gps.status)}</span>
                        </span>
                        {order.gps.offlineAgeLabel ? (
                          <span className={["gps-age", order.gps.status === "ONLINE" ? "is-live" : getGpsSyncClass(order.gps.syncState) || "is-warning"].join(" ").trim()}>
                            {order.gps.offlineAgeLabel}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {!isExpanded && rowNotes.length > 0 ? <OrderCollapsedNotes notes={rowNotes} /> : null}
                  </div>
                </div>
                <div className="orders-simple-statuses">
                  <span className={["orders-simple-badge", getMainStatusClass(order.mainStatus.code)].join(" ")}>
                    {order.mainStatus.label}
                  </span>
                </div>
              </div>

              <div className="orders-simple-mobile-grid orders-phase1-mobile-grid">
                <div>
                  <span>След. оплата</span>
                  <strong>{formatDate(order.nextPaymentAt)}</strong>
                </div>
                <div>
                  <span>Долг</span>
                  <strong>{buildDebtShortLine(order)}</strong>
                </div>
              </div>

              <div className="orders-simple-mobile-actions">
                <button
                  className="action-button is-secondary orders-row-open-button"
                  data-stop-row-open="true"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openOrder(order);
                  }}
                >
                  Открыть заказ
                </button>
              </div>

              {isExpanded ? (
                <div className="orders-mobile-expand">
                  {isLoading && !detail ? (
                    <div className="orders-expand-loading">Загружаю заказ...</div>
                  ) : error ? (
                    <div className="orders-expand-error">
                      <p>{error}</p>
                      <button className="action-button is-secondary" type="button" onClick={() => loadDetail(order, true)}>
                        Повторить
                      </button>
                    </div>
                  ) : detail ? (
                    <OrderExpandContent detail={detail} onRefresh={() => loadDetail(order, true)} />
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </>
  );
}
