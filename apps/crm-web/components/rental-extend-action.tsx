"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

type RentalRate = {
  id: string;
  label: string;
  durationDays: number;
  amountKopecks: number;
};

export function RentalExtendAction(props: {
  rentalId: string;
  currentTariffLabel: string;
  currentDurationDays: number | null;
  rates: RentalRate[];
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canChangeStatus = useHasPermission("rentals.change_status");
  const [isPending, startTransition] = useTransition();
  const sortedRates = [...props.rates].sort((left, right) => left.durationDays - right.durationDays);
  const initialRate = sortedRates.find((rate) => rate.durationDays === props.currentDurationDays) ?? sortedRates[0] ?? null;
  const [durationDays, setDurationDays] = useState(initialRate?.durationDays ? String(initialRate.durationDays) : "");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sortedRates.some((rate) => String(rate.durationDays) === durationDays)) {
      setDurationDays(initialRate?.durationDays ? String(initialRate.durationDays) : "");
    }
  }, [durationDays, initialRate?.durationDays, sortedRates]);

  const selectedRate = sortedRates.find((rate) => String(rate.durationDays) === durationDays) ?? null;

  function submit() {
    setError(null);
    setStatus(null);

    if (!selectedRate) {
      setError("Для этой аренды нет доступных ставок продления.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.rentalId}/extend`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            durationDays: selectedRate.durationDays,
            comment: comment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Следующий цикл обновлен: ${payload?.deal?.tariffLabel ?? selectedRate.label}.`);
        setComment("");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось продлить аренду.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Продление</div>
      <h3>Следующий срок аренды</h3>
      <p className="route-card-note">
        Меняем только ставку из сохраненных условий этой аренды. Общий тариф для новых клиентов можно менять отдельно.
      </p>

      <div className="record-tags">
        <span className="tag-chip">сейчас: {props.currentTariffLabel}</span>
        {selectedRate ? (
          <span className="tag-chip">будет: {selectedRate.label} · {formatMoney(selectedRate.amountKopecks)}</span>
        ) : null}
      </div>

      <label className="action-field">
        <span>Продлить на</span>
        <select
          className="action-input"
          value={durationDays}
          onChange={(event) => setDurationDays(event.target.value)}
        >
          {sortedRates.map((rate) => (
            <option key={rate.id} value={rate.durationDays}>
              {rate.label} · {formatMoney(rate.amountKopecks)} руб.
            </option>
          ))}
        </select>
      </label>

      <label className="action-field">
        <span>Комментарий</span>
        <textarea
          className="action-input action-textarea"
          maxLength={240}
          placeholder="Необязательно"
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="record-actions">
        <button className="action-button" disabled={!canChangeStatus || isPending || !selectedRate} type="button" onClick={submit}>
          {isPending ? "Обновляю..." : "Продлить"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canChangeStatus ? <p className="route-card-note">Недостаточно прав для изменения срока аренды.</p> : null}
    </article>
  );
}
