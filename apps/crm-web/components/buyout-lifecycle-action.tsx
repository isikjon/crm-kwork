"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
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

export function BuyoutLifecycleAction(props: {
  buyoutId: string;
  status: string;
  residualDebtKopecks: number;
  penaltyCount: number;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canChangeStatus = useHasPermission("buyouts.change_status");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isClosed = props.status === "CLOSED" || props.status === "TERMINATED";

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/buyouts/${props.buyoutId}/close`, {
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

        setStatus(`Выкуп ${payload?.deal?.dealNumber ?? ""} закрыт.`);
        setComment("");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось закрыть выкуп.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Завершение</div>
      <h3>Закрыть выкуп</h3>
      <p className="route-card-note">
        Закрываем только после полной оплаты и без активных штрафов. Велосипед уйдет из парка.
      </p>

      <ul className="detail-list">
        <li>
          <span className="detail-list-label">Статус</span>
          <span className="detail-list-value">{formatBuyoutStatus(props.status)}</span>
        </li>
        <li>
          <span className="detail-list-label">Остаток / штрафы</span>
          <span className="detail-list-value">{Math.round(props.residualDebtKopecks / 100)} руб. / {props.penaltyCount}</span>
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
          {isPending ? "Закрываю..." : "Закрыть выкуп"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canChangeStatus ? <p className="route-card-note">Недостаточно прав для изменения статуса выкупа.</p> : null}
    </article>
  );
}
