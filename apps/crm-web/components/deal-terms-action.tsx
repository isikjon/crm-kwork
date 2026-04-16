"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission } from "./auth-actor-context";

type DealKind = "RENTAL" | "BUYOUT";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function toRublesString(kopecks: number) {
  return String(Math.max(0, Math.round(kopecks / 100)));
}

export function DealTermsAction(props: {
  dealKind: DealKind;
  dealId: string;
  depositTargetKopecks: number;
  autoPenaltyEnabled: boolean;
  autoPenaltyDailyKopecks: number;
  graceDays: number;
}) {
  const router = useRouter();
  const canEditTerms = useHasPermission(props.dealKind === "RENTAL" ? "rentals.edit_terms" : "buyouts.edit_terms");
  const [isPending, startTransition] = useTransition();
  const [depositTargetRubles, setDepositTargetRubles] = useState(toRublesString(props.depositTargetKopecks));
  const [autoPenaltyEnabled, setAutoPenaltyEnabled] = useState(props.autoPenaltyEnabled);
  const [autoPenaltyDailyRubles, setAutoPenaltyDailyRubles] = useState(toRublesString(props.autoPenaltyDailyKopecks));
  const [graceDays, setGraceDays] = useState(String(props.graceDays));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `${getApiBase()}/${props.dealKind === "RENTAL" ? "rentals" : "buyouts"}/${props.dealId}/terms`;

  function saveTerms() {
    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        const response = await fetch(endpoint, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug: "prokolesa",
            depositTargetKopecks: Math.max(0, Math.round(Number(depositTargetRubles || "0") * 100)),
            autoPenaltyEnabled,
            autoPenaltyDailyKopecks: Math.max(0, Math.round(Number(autoPenaltyDailyRubles || "0") * 100)),
            graceDays: Math.max(0, Math.trunc(Number(graceDays || "0"))),
            reason: "Updated from CRM detail card"
          })
        });

        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }

        setStatus("Условия сделки обновлены. Перечитываю карточку...");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось обновить условия сделки.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Deal terms</div>
      <h3>Настройки залога и штрафов</h3>
      <p className="route-card-note">
        Здесь задаются рабочие правила именно для этой сделки: сумма залога, автоштраф и льготный период.
      </p>

      <div className="action-field-grid">
        <label className="action-field">
          <span>Сумма залога, руб.</span>
          <input
            className="action-input"
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={depositTargetRubles}
            onChange={(event) => setDepositTargetRubles(event.target.value)}
          />
        </label>

        <label className="action-field">
          <span>Автоштраф за день, руб.</span>
          <input
            className="action-input"
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={autoPenaltyDailyRubles}
            onChange={(event) => setAutoPenaltyDailyRubles(event.target.value)}
          />
        </label>
      </div>

      <div className="action-field-grid">
        <label className="action-field">
          <span>Льготные дни</span>
          <input
            className="action-input"
            inputMode="numeric"
            min={0}
            step={1}
            type="number"
            value={graceDays}
            onChange={(event) => setGraceDays(event.target.value)}
          />
        </label>

        <div className="action-field">
          <span>Режимы</span>
          <label className="action-toggle">
            <input
              checked={autoPenaltyEnabled}
              type="checkbox"
              onChange={(event) => setAutoPenaltyEnabled(event.target.checked)}
            />
            <span>Автоштраф включен</span>
          </label>
        </div>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canEditTerms ? <p className="route-card-note">Недостаточно прав для изменения условий сделки.</p> : null}

      <div className="record-actions">
        <button className="action-button" disabled={!canEditTerms || isPending} type="button" onClick={saveTerms}>
          {isPending ? "Сохраняю..." : "Сохранить условия"}
        </button>
      </div>
    </article>
  );
}
