"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RepairsWorkspaceData } from "../lib/repairs-api";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

export function RepairLineItemAction(props: {
  repairId: string;
  banks: RepairsWorkspaceData["banks"];
}) {
  const router = useRouter();
  const canEditRepairs = useHasPermission("repairs.edit");
  const tenantSlug = useTenantSlug();
  const [title, setTitle] = useState("");
  const [amountRub, setAmountRub] = useState("");
  const [bankId, setBankId] = useState("");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const amountKopecks = Math.max(0, Math.round(Number(amountRub || 0) * 100));

        const response = await fetch(`${getApiBase()}/repairs/${props.repairId}/items`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            title: title.trim(),
            amountKopecks,
            bankId: amountKopecks > 0 ? bankId || undefined : undefined,
            comment: comment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Позиция добавлена.");
        setTitle("");
        setAmountRub("");
        setBankId("");
        setComment("");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось добавить позицию.");
      }
    });
  }

  return (
    <details className="surface-card detail-collapsible repair-item-card">
      <summary className="detail-collapsible-summary">
        <div>
          <div className="surface-kicker">Позиция</div>
          <h3>Добавить в ремонт</h3>
        </div>
        <span className="detail-collapsible-hint" />
      </summary>

      <div className="detail-collapsible-body">
        <p className="route-card-note">
          Здесь можно добавлять и работы, и запчасти. Если указываем сумму, она сразу уйдет в расходы по выбранному банку.
        </p>

        <label className="action-field">
          <span>Что добавляем</span>
          <input
            className="action-input"
            maxLength={160}
            placeholder="Работа или запчасть"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <div className="action-field-grid repair-item-grid">
          <label className="action-field">
            <span>Сумма, руб.</span>
            <input
              className="action-input"
              inputMode="numeric"
              placeholder="0, если пока без списания"
              value={amountRub}
              onChange={(event) => setAmountRub(event.target.value)}
            />
          </label>

        <label className="action-field">
          <span>Банк списания</span>
          <select className="action-input" value={bankId} onChange={(event) => setBankId(event.target.value)}>
            <option value="">Не выбран</option>
            {props.banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.branch?.name ? `${bank.name} · ${bank.branch.name}` : bank.name}
              </option>
            ))}
          </select>
        </label>
        </div>

        <label className="action-field">
          <span>Комментарий</span>
          <textarea
            className="action-input action-textarea"
            maxLength={2000}
            placeholder="Необязательно"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>

        <div className="record-actions">
          <button className="action-button" disabled={!canEditRepairs || isPending || title.trim().length < 2} type="button" onClick={submit}>
            {isPending ? "Сохраняю..." : "Добавить позицию"}
          </button>
        </div>

        {error ? <p className="action-status is-error">{error}</p> : null}
        {status ? <p className="action-status is-success">{status}</p> : null}
        {!canEditRepairs ? <p className="route-card-note">Недостаточно прав для изменения ремонта.</p> : null}
      </div>
    </details>
  );
}
