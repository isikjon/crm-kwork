"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatRentalStatus(status: string) {
  switch (status) {
    case "NEW":
      return "Новая";
    case "ACTIVE":
      return "Активна";
    case "OVERDUE":
      return "Просрочена";
    case "HOLD":
      return "На паузе";
    case "RETURN_PREP":
      return "Готовится возврат";
    case "COMPLETED":
      return "Завершена";
    case "CANCELED":
      return "Отменена";
    default:
      return status;
  }
}

export function RentalLifecycleAction(props: {
  rentalId: string;
  status: string;
  debtKopecks: number;
  penaltyCount: number;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canChangeStatus = useHasPermission("rentals.change_status");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isClosed = props.status === "COMPLETED" || props.status === "CANCELED";

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.rentalId}/return`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            comment: comment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Аренда ${payload?.deal?.dealNumber ?? ""} завершена.`);
        setComment("");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось завершить аренду.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Завершение</div>
      <h3>Возврат велосипеда</h3>
      <p className="route-card-note">
        Велосипед вернется в парк. Закрытие доступно только без долга и активных штрафов.
      </p>

      <ul className="detail-list">
        <li>
          <span className="detail-list-label">Статус</span>
          <span className="detail-list-value">{formatRentalStatus(props.status)}</span>
        </li>
        <li>
          <span className="detail-list-label">Текущий долг / штрафы</span>
          <span className="detail-list-value">{Math.round(props.debtKopecks / 100)} руб. / {props.penaltyCount}</span>
        </li>
      </ul>

      <label className="action-field">
        <span>Комментарий</span>
        <textarea
          className="action-input action-textarea"
          maxLength={240}
          placeholder="Необязательно"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="record-actions">
        <button className="action-button" disabled={!canChangeStatus || isPending || isClosed} type="button" onClick={submit}>
          {isPending ? "Завершаю..." : "Вернуть велосипед"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canChangeStatus ? <p className="route-card-note">Недостаточно прав для изменения статуса аренды.</p> : null}
    </article>
  );
}
