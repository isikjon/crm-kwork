"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

export function RepairCompleteAction(props: {
  repairId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const canEditRepairs = useHasPermission("repairs.edit");
  const tenantSlug = useTenantSlug();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/repairs/${props.repairId}/complete`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Ремонт завершен. Велосипед снова свободен.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось завершить ремонт.");
      }
    });
  }

  return (
    <article className="surface-card repair-complete-card">
      <div className="surface-kicker">Завершение</div>
      <h3>Починили</h3>
      <p className="route-card-note">
        После завершения велосипед снова станет свободным в парке.
      </p>

      <div className="record-actions">
        <button className="action-button" disabled={!canEditRepairs || isPending || props.disabled} type="button" onClick={submit}>
          {isPending ? "Сохраняю..." : "Починили"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canEditRepairs ? <p className="route-card-note">Недостаточно прав для завершения ремонта.</p> : null}
    </article>
  );
}
