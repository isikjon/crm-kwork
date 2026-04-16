"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

type DealKind = "RENTAL" | "BUYOUT";

export function DealProblemAction(props: {
  dealId: string;
  dealKind: DealKind;
  isProblem: boolean;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canChangeStatus = useHasPermission(props.dealKind === "RENTAL" ? "rentals.change_status" : "buyouts.change_status");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const routePrefix = props.dealKind === "RENTAL" ? "rentals" : "buyouts";
  const nextValue = !props.isProblem;

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/${routePrefix}/${props.dealId}/problem`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            isProblem: nextValue,
            comment: comment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(nextValue ? "Статус «Проблемы» включен." : "Статус «Проблемы» снят.");
        setComment("");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось обновить статус проблемы.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Статус</div>
      <h3>Проблемы</h3>
      <p className="route-card-note">
        Менеджер ставит этот статус вручную. Просрочка и штрафы сами его не включают.
      </p>

      <ul className="detail-list">
        <li>
          <span className="detail-list-label">Сейчас</span>
          <span className="detail-list-value">{props.isProblem ? "Проблемы" : "Без проблем"}</span>
        </li>
      </ul>

      <label className="action-field">
        <span>Комментарий</span>
        <textarea
          className="action-input action-textarea"
          maxLength={240}
          placeholder={props.isProblem ? "Почему снимаем статус" : "Почему ставим статус"}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="record-actions">
        <button className="action-button" disabled={!canChangeStatus || isPending} type="button" onClick={submit}>
          {isPending ? "Сохраняю..." : props.isProblem ? "Снять проблемы" : "Поставить проблемы"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canChangeStatus ? <p className="route-card-note">Недостаточно прав для изменения критичного статуса сделки.</p> : null}
    </article>
  );
}
