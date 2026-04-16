"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

type RelativeRow = {
  id: string;
  fullName: string;
  phone: string;
  comment: string | null;
};

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

export function ClientRelativesAction(props: {
  clientId: string;
  rows: RelativeRow[];
  compact?: boolean;
  openByDefault?: boolean;
}) {
  const router = useRouter();
  const canEditClient = useHasPermission("clients.edit");
  const [isPending, startTransition] = useTransition();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addRelative() {
    setStatus(null);
    setError(null);

    if (!fullName.trim() || !phone.trim()) {
      setError("Укажите имя и телефон родственника.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/${props.clientId}/relatives`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            fullName: fullName.trim(),
            phone: phone.trim(),
            comment: comment.trim() || null
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setFullName("");
        setPhone("");
        setComment("");
        setStatus("Родственник добавлен.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось добавить родственника.");
      }
    });
  }

  function removeRelative(relativeId: string) {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/${props.clientId}/relatives/${relativeId}?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
          method: "DELETE",
          credentials: "include"
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Удален: ${payload?.relative?.fullName ?? ""}`);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось удалить родственника.");
      }
    });
  }

  return (
    <div className={`action-card client-form-card${props.compact ? " is-compact" : ""}`}>
      <details className="client-editor-block" id="client-relatives-block" open={props.openByDefault}>
        <summary>Родственники</summary>
        <div className="client-editor-body">
          <div className="action-field-grid">
            <label className="action-field">
              <span>Кто это</span>
              <input className="action-input" value={fullName} onChange={(event) => setFullName(event.target.value)} />
            </label>

            <label className="action-field">
              <span>Телефон</span>
              <input className="action-input" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>

            <label className="action-field action-field-wide">
              <span>Комментарий</span>
              <textarea className="action-input action-textarea" rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
            </label>
          </div>

          <div className="inline-actions">
            <button className="action-button" type="button" disabled={!canEditClient || isPending} onClick={addRelative}>
              {isPending ? "Сохраняю..." : "Добавить родственника"}
            </button>
          </div>

          {props.rows.length > 0 ? (
            <div className="lookup-list client-relatives-list">
              {props.rows.map((row) => (
                <div className="lookup-list-row client-relative-row" key={row.id}>
                  <span className="lookup-list-marker" aria-hidden="true" />
                  <div className="lookup-list-label client-relative-copy">
                    <strong>{row.fullName}</strong>
                    <div className="client-relative-subline">{row.phone}</div>
                    {row.comment ? <div className="client-relative-comment">{row.comment}</div> : null}
                  </div>
                  <button className="lookup-list-delete" type="button" disabled={!canEditClient || isPending} onClick={() => removeRelative(row.id)}>
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="route-card-note">Пока родственники не добавлены.</p>
          )}
        </div>
      </details>

      {status ? <p className="action-status is-success">{status}</p> : null}
      {error ? <p className="action-status is-error">{error}</p> : null}
      {!canEditClient ? <p className="route-card-note">Недостаточно прав для изменения родственников клиента.</p> : null}
    </div>
  );
}
