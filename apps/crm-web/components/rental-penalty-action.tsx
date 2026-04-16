"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

type PaymentMethod = "BANK" | "CASH";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

export function RentalPenaltyAction(props: {
  rentalId: string;
  overdueDays: number;
  autoPenaltyEnabled: boolean;
  autoPenaltyDailyKopecks: number;
  penalties: Array<{
    id: string;
    status: string;
    amountKopecks: number;
    reason: string;
    comment: string | null;
    accrualDate: string;
  }>;
  bankId: string | null;
  bankName: string | null;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canManualPenalty = useHasPermission("rentals.manual_penalty");
  const canRunAutoPenalty = useHasPermission("rentals.manage_penalty");
  const canPayPenalty = useHasPermission("rentals.pay_penalty");
  const [isPending, startTransition] = useTransition();
  const [manualAmountRubles, setManualAmountRubles] = useState("0");
  const [manualReason, setManualReason] = useState("Просрочка аренды");
  const [manualComment, setManualComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPenaltyId, setSelectedPenaltyId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(props.bankId ? "BANK" : "CASH");
  const [paymentComment, setPaymentComment] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const activePenalties = useMemo(() => (
    props.penalties.filter((penalty) => penalty.status === "ACTIVE")
  ), [props.penalties]);

  const selectedPenalty = useMemo(() => (
    activePenalties.find((penalty) => penalty.id === selectedPenaltyId) ?? null
  ), [activePenalties, selectedPenaltyId]);

  useEffect(() => {
    if (!selectedPenaltyId || !activePenalties.some((penalty) => penalty.id === selectedPenaltyId)) {
      setSelectedPenaltyId(activePenalties[0]?.id ?? "");
    }
  }, [activePenalties, selectedPenaltyId]);

  function submitManualPenalty() {
    setError(null);
    setStatus(null);

    const amountKopecks = Math.max(0, Math.round(Number(manualAmountRubles || "0") * 100));
    if (amountKopecks <= 0) {
      setError("Укажите сумму штрафа больше нуля.");
      return;
    }

    if (!manualReason.trim()) {
      setError("Нужно указать причину штрафа.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.rentalId}/penalties/manual`, {
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

        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }

        setStatus("Ручной штраф начислен. Обновляю карточку...");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось начислить ручной штраф.");
      }
    });
  }

  function submitAutoPenaltyRun() {
    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.rentalId}/penalties/auto-run`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            comment: "Auto penalty run from CRM card"
          })
        });

        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }

        setStatus("Автоштрафы пересчитаны. Обновляю карточку...");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось выполнить автоначисление.");
      }
    });
  }

  function submitPenaltyPayment() {
    // Penalty payment is intentionally separate from accrual: the active penalty is closed through its own money fact.
    setPaymentError(null);
    setPaymentStatus(null);

    if (!selectedPenalty) {
      setPaymentError("Нет активного штрафа для оплаты.");
      return;
    }

    if (paymentMethod === "BANK" && !props.bankId) {
      setPaymentError("Для банковской оплаты штрафа сначала выберите банк в сделке.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.rentalId}/penalties/${selectedPenalty.id}/pay`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            paymentMethod,
            ...(paymentMethod === "BANK" && props.bankId ? { bankId: props.bankId } : {}),
            ...(paymentDate ? { happenedAt: paymentDate } : {}),
            ...(paymentComment.trim() ? { comment: paymentComment.trim() } : {})
          })
        });

        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }

        setPaymentComment("");
        setPaymentStatus(`Штраф оплачен: ${formatMoney(selectedPenalty.amountKopecks)}. Обновляю карточку...`);
        router.refresh();
      } catch (requestError) {
        setPaymentError(requestError instanceof Error ? requestError.message : "Не удалось провести оплату штрафа.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Штраф</div>
      <h3>Штрафы по аренде</h3>
      <div className="record-tags">
        <span className="tag-chip">просрочка: {props.overdueDays} дн.</span>
        <span className="tag-chip">автоштраф: {props.autoPenaltyEnabled ? "вкл" : "выкл"}</span>
        <span className="tag-chip">в день: {formatMoney(props.autoPenaltyDailyKopecks)}</span>
        <span className="tag-chip is-neutral">активных штрафов: {activePenalties.length}</span>
      </div>

      <div className="penalty-payment-block">
        <div className="penalty-payment-head">
          <strong>Оплата штрафа</strong>
          <span>Отдельный денежный факт. Начисление и оплата больше не смешиваются.</span>
        </div>

        {activePenalties.length > 0 ? (
          <>
            <div className="penalty-payment-grid">
              <label className="action-field penalty-payment-full">
                <span>Активный штраф</span>
                <select
                  className="action-input"
                  value={selectedPenaltyId}
                  onChange={(event) => setSelectedPenaltyId(event.target.value)}
                  disabled={isPending}
                >
                  {activePenalties.map((penalty) => (
                    <option key={penalty.id} value={penalty.id}>
                      {formatMoney(penalty.amountKopecks)} · {penalty.reason}
                    </option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Способ</span>
                <select
                  className="action-input"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
                  disabled={isPending}
                >
                  <option value="BANK">Банк</option>
                  <option value="CASH">Наличные</option>
                </select>
              </label>

              <label className="action-field">
                <span>Дата оплаты</span>
                <input
                  className="action-input"
                  type="date"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                  disabled={isPending}
                />
              </label>

              <label className="action-field penalty-payment-full">
                <span>Комментарий</span>
                <textarea
                  className="action-input action-textarea"
                  rows={2}
                  value={paymentComment}
                  onChange={(event) => setPaymentComment(event.target.value)}
                  placeholder="Например: клиент оплатил штраф переводом"
                  disabled={isPending}
                />
              </label>
            </div>

            {selectedPenalty ? (
              <div className="penalty-payment-summary">
                <span className="tag-chip">к оплате: {formatMoney(selectedPenalty.amountKopecks)}</span>
                <span className="tag-chip is-neutral">причина: {selectedPenalty.reason}</span>
                <span className="tag-chip is-neutral">
                  {paymentMethod === "BANK" ? `банк: ${props.bankName ?? "не выбран"}` : "наличные"}
                </span>
              </div>
            ) : null}

            {paymentError ? <p className="action-status is-error">{paymentError}</p> : null}
            {paymentStatus ? <p className="action-status is-success">{paymentStatus}</p> : null}
            {!canPayPenalty ? <p className="route-card-note">Недостаточно прав для фиксации оплаты штрафа аренды.</p> : null}

            <div className="record-actions">
              <button
                className="action-button"
                type="button"
                disabled={!canPayPenalty || isPending || !selectedPenalty || (paymentMethod === "BANK" && !props.bankId)}
                onClick={submitPenaltyPayment}
              >
                {isPending ? "Провожу..." : "Провести оплату штрафа"}
              </button>
            </div>
          </>
        ) : (
          <p className="route-card-note">Активных штрафов для оплаты пока нет. Сначала должен существовать начисленный штраф.</p>
        )}
      </div>

      <div className="action-field-grid">
        <label className="action-field">
          <span>Сумма ручного штрафа, руб.</span>
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
            maxLength={240}
            type="text"
            value={manualReason}
            onChange={(event) => setManualReason(event.target.value)}
          />
        </label>
      </div>

      <label className="action-field">
        <span>Комментарий</span>
        <textarea
          className="action-input action-textarea"
          placeholder="Например: менеджер подтвердил штраф за 2 дня просрочки"
          rows={3}
          value={manualComment}
          onChange={(event) => setManualComment(event.target.value)}
        />
      </label>

      <div className="record-actions action-buttons-row">
        <button className="action-button" disabled={!canManualPenalty || isPending} type="button" onClick={submitManualPenalty}>
          {isPending ? "Обрабатываю..." : "Начислить вручную"}
        </button>
        <button className="action-button is-secondary" disabled={!canRunAutoPenalty || isPending || !props.autoPenaltyEnabled || props.overdueDays <= 0} type="button" onClick={submitAutoPenaltyRun}>
          {isPending ? "Обрабатываю..." : "Запустить автоначисление"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canManualPenalty || !canRunAutoPenalty ? (
        <p className="route-card-note">
          {!canManualPenalty && !canRunAutoPenalty
            ? "Недостаточно прав для начисления штрафов аренды."
            : !canManualPenalty
              ? "Недостаточно прав для ручного штрафа."
              : "Недостаточно прав для автоначисления."}
        </p>
      ) : null}
    </article>
  );
}
