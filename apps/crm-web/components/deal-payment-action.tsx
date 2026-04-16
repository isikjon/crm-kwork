"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

type DealKind = "RENTAL" | "BUYOUT";
type PaymentMethod = "BANK" | "CASH";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

export function DealPaymentAction(props: {
  dealKind: DealKind;
  dealId: string;
  defaultAmountKopecks: number;
  bankId: string | null;
  bankName: string | null;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canPostPayment = useHasPermission(props.dealKind === "RENTAL" ? "rentals.post_payment" : "buyouts.post_payment");
  const [isPending, startTransition] = useTransition();
  const [amountRubles, setAmountRubles] = useState(String(Math.max(0, Math.round(props.defaultAmountKopecks / 100))));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(props.bankId ? "BANK" : "CASH");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountKopecks = Math.max(0, Math.round(Number(amountRubles || "0") * 100));
  // Deal card captures operator intent only; backend owns payment posting, schedule updates and finance side effects.
  const endpoint = `${getApiBase()}/${props.dealKind === "RENTAL" ? "rentals" : "buyouts"}/${props.dealId}/payments`;
  const bankRequiredButMissing = paymentMethod === "BANK" && !props.bankId;

  async function submitPayment() {
    setError(null);
    setStatus(null);

    if (amountKopecks <= 0) {
      setError("Укажите сумму оплаты больше нуля.");
      return;
    }

    if (bankRequiredButMissing) {
      setError("Для банковской оплаты сначала выберите банк в сделке.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            amountKopecks,
            paymentMethod,
            bankId: paymentMethod === "BANK" ? props.bankId : undefined,
            comment: comment.trim() || undefined
          })
        });

        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }

        setStatus(`Платеж проведен: ${formatMoney(amountKopecks)}. Обновляю карточку...`);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось провести платеж.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Оплата</div>
      <h3>Провести оплату</h3>

      <div className="action-field-grid">
        <label className="action-field">
          <span>Сумма, руб.</span>
          <input
            className="action-input"
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={amountRubles}
            onChange={(event) => setAmountRubles(event.target.value)}
          />
        </label>

        <label className="action-field">
          <span>Способ</span>
          <select
            className="action-input"
            value={paymentMethod}
            onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
          >
            <option value="BANK">Банк</option>
            <option value="CASH">Наличные</option>
          </select>
        </label>
      </div>

      <label className="action-field">
        <span>Комментарий</span>
        <textarea
          className="action-input action-textarea"
          placeholder="Например: клиент оплатил переводом в Telegram"
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="record-tags">
        <span className="tag-chip">по умолчанию: {formatMoney(props.defaultAmountKopecks)}</span>
        <span className="tag-chip">
          {paymentMethod === "BANK"
            ? `банк: ${props.bankName ?? "не выбран"}`
            : "наличные"}
        </span>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canPostPayment ? <p className="route-card-note">Недостаточно прав для проведения оплаты.</p> : null}

      <div className="record-actions">
        <button
          className="action-button"
          disabled={!canPostPayment || isPending || amountKopecks <= 0 || bankRequiredButMissing}
          type="button"
          onClick={submitPayment}
        >
          {isPending ? "Провожу..." : "Провести оплату"}
        </button>
      </div>
    </article>
  );
}
