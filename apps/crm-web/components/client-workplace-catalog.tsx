"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

type WorkplaceRow = {
  id: string;
  label: string;
  usageCount: number;
};

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

export function ClientWorkplaceCatalog(props: {
  rows: WorkplaceRow[];
}) {
  const router = useRouter();
  const canEditClient = useHasPermission("clients.edit");
  const [isPending, startTransition] = useTransition();
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    if (!search) {
      return props.rows;
    }

    return props.rows.filter((row) => row.label.toLocaleLowerCase().includes(search));
  }, [props.rows, query]);

  function submit() {
    setStatus(null);
    setError(null);

    if (label.trim().length < 2) {
      setError("Введите название места работы.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/workplaces`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            label: label.trim()
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setLabel("");
        setStatus(payload?.created ? "Значение добавлено." : "Такое значение уже есть.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось добавить значение.");
      }
    });
  }

  function remove(workplaceId: string) {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/workplaces/${workplaceId}?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
          method: "DELETE",
          credentials: "include"
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Значение "${payload?.workplace?.label ?? ""}" удалено.`);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось удалить значение.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Места работы</div>
      <h3>Справочник</h3>

      <div className="action-field-grid">
        <label className="action-field action-field-wide">
          <span>Новое значение</span>
          <input
            className="action-input"
            placeholder="Например, Яндекс Доставка"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
      </div>

      <div className="action-field-grid">
        <label className="action-field action-field-wide">
          <span>Поиск по справочнику</span>
          <input
            className="action-input"
            placeholder="Найти место работы"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="inline-actions">
        <button className="action-button" type="button" disabled={!canEditClient || isPending} onClick={submit}>
          {isPending ? "Сохраняю..." : "Добавить"}
        </button>
      </div>

      {rows.length > 0 ? (
        <div className="lookup-list">
          {rows.map((row) => (
            <div className="lookup-list-row" key={row.id}>
              <span className="lookup-list-marker" aria-hidden="true" />
              <div className="lookup-list-label">{row.label}</div>
              <span className="lookup-list-count">{row.usageCount}</span>
              <button
                className="lookup-list-delete"
                type="button"
                disabled={!canEditClient || isPending}
                onClick={() => remove(row.id)}
              >
                Удалить
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="route-card-note">Пока значений нет. Добавьте список, и он появится у клиентов в выпадающем выборе.</p>
      )}

      {status ? <p className="action-status is-success">{status}</p> : null}
      {error ? <p className="action-status is-error">{error}</p> : null}
      {!canEditClient ? <p className="route-card-note">Недостаточно прав для изменения справочника мест работы.</p> : null}
    </article>
  );
}
