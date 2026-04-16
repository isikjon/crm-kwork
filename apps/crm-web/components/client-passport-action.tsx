"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function toDateInputValue(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

export function ClientPassportAction(props: {
  clientId: string;
  identityData: {
    passportSeries: string | null;
    passportNumber: string | null;
    issuedBy: string | null;
    issuedAt: string | null;
    departmentCode: string | null;
    birthDate: string | null;
  } | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const canEditIdentity = useHasPermission("clients.identity.edit");
  const [isPending, startTransition] = useTransition();
  const [passportSeries, setPassportSeries] = useState(props.identityData?.passportSeries ?? "");
  const [passportNumber, setPassportNumber] = useState(props.identityData?.passportNumber ?? "");
  const [issuedBy, setIssuedBy] = useState(props.identityData?.issuedBy ?? "");
  const [issuedAt, setIssuedAt] = useState(toDateInputValue(props.identityData?.issuedAt));
  const [departmentCode, setDepartmentCode] = useState(props.identityData?.departmentCode ?? "");
  const [birthDate, setBirthDate] = useState(toDateInputValue(props.identityData?.birthDate));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/${props.clientId}/profile`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            passportSeries,
            passportNumber,
            issuedBy,
            issuedAt,
            departmentCode,
            birthDate
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Паспорт сохранен.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить паспорт.");
      }
    });
  }

  return (
    <div className={`action-card client-form-card${props.compact ? " is-compact" : ""}`}>
      <details className="client-editor-block" open>
        <summary>Паспорт</summary>
        <div className="client-editor-body">
          <div className="action-field-grid">
            <label className="action-field">
              <span>Дата рождения</span>
              <input className="action-input" type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} />
            </label>

            <label className="action-field">
              <span>Серия</span>
              <input className="action-input" value={passportSeries} onChange={(event) => setPassportSeries(event.target.value)} />
            </label>

            <label className="action-field">
              <span>№</span>
              <input className="action-input" value={passportNumber} onChange={(event) => setPassportNumber(event.target.value)} />
            </label>

            <label className="action-field action-field-wide">
              <span>Где выдан</span>
              <input className="action-input" value={issuedBy} onChange={(event) => setIssuedBy(event.target.value)} />
            </label>

            <label className="action-field">
              <span>Дата выдачи</span>
              <input className="action-input" type="date" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} />
            </label>

            <label className="action-field">
              <span>Код подразделения</span>
              <input className="action-input" value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)} />
            </label>
          </div>

          <div className="inline-actions">
            <button className="action-button" type="button" disabled={!canEditIdentity || isPending} onClick={save}>
              {isPending ? "Сохраняю..." : "Сохранить паспорт"}
            </button>
          </div>
        </div>
      </details>

      {status ? <p className="action-status is-success">{status}</p> : null}
      {error ? <p className="action-status is-error">{error}</p> : null}
      {!canEditIdentity ? <p className="route-card-note">Недостаточно прав для редактирования паспортных данных.</p> : null}
    </div>
  );
}
