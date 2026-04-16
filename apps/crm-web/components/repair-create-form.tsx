"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { RepairsWorkspaceData } from "../lib/repairs-api";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

type BikeSearchRow = {
  id: string;
  title: string;
  article: string | null;
  internalCode: string;
  status: string;
};

const repairableStatuses = new Set(["AVAILABLE", "RETURN_PENDING"]);

export function RepairCreateForm(props: {
  banks: RepairsWorkspaceData["banks"];
}) {
  const router = useRouter();
  const canEditRepairs = useHasPermission("repairs.edit");
  const tenantSlug = useTenantSlug();
  const [bikeQuery, setBikeQuery] = useState("");
  const [bikeResults, setBikeResults] = useState<BikeSearchRow[]>([]);
  const [selectedBike, setSelectedBike] = useState<BikeSearchRow | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amountRub, setAmountRub] = useState("");
  const [bankId, setBankId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (bikeQuery.trim().length < 2 || selectedBike?.title === bikeQuery.trim()) {
      setBikeResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${getApiBase()}/bikes?tenantSlug=${encodeURIComponent(tenantSlug)}&q=${encodeURIComponent(bikeQuery.trim())}&limit=8`, {
          credentials: "include",
          signal: controller.signal
        });
        if (!response.ok) {
          return;
        }
        const payload = await response.json() as { rows: BikeSearchRow[] };
        setBikeResults((payload.rows ?? []).filter((bike) => repairableStatuses.has(bike.status)));
      } catch {
        // ignore transient search failures in the picker
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bikeQuery, selectedBike, tenantSlug]);

  function selectBike(bike: BikeSearchRow) {
    setSelectedBike(bike);
    setBikeQuery(bike.title);
    setBikeResults([]);
  }

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        if (!selectedBike) {
          throw new Error("Сначала выберите велосипед.");
        }

        const amountKopecks = Math.max(0, Math.round(Number(amountRub || 0) * 100));

        const response = await fetch(`${getApiBase()}/repairs`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            bikeId: selectedBike.id,
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            initialAmountKopecks: amountKopecks || undefined,
            bankId: amountKopecks > 0 ? bankId || undefined : undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Ремонт ${payload?.repair?.title ?? "создан"}.`);
        setBikeQuery("");
        setSelectedBike(null);
        setTitle("");
        setDescription("");
        setAmountRub("");
        setBankId("");
        setBikeResults([]);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось оформить ремонт.");
      }
    });
  }

  return (
    <article className="surface-card repair-create-card">
      <div className="surface-kicker">Новый ремонт</div>
      <h3>Оформить ремонт</h3>
      <p className="route-card-note">
        Можно сразу списать сумму с банка или просто открыть ремонт, а позиции добавить позже.
      </p>
      <p className="route-card-note">
        При открытии ремонта велосипед перейдет в статус <strong>В ремонте</strong>. После завершения он вернется в <strong>Свободен</strong>.
      </p>

      <label className="action-field repair-bike-field">
        <span>Велосипед</span>
        <input
          className="action-input"
          placeholder="Поиск по артикулу, названию, коду"
          value={bikeQuery}
          onChange={(event) => {
            setSelectedBike(null);
            setBikeQuery(event.target.value);
          }}
        />
      </label>

      {bikeResults.length > 0 ? (
        <div className="record-grid repair-search-grid">
          {bikeResults.map((bike) => (
            <button className="record-card repair-search-card" key={bike.id} type="button" onClick={() => selectBike(bike)}>
              <div className="record-title">{bike.title}</div>
              <div className="record-meta">
                {bike.article ?? "без артикула"} · {bike.internalCode} · {bike.status}
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {selectedBike ? (
        <div className="record-tags repair-selected-tags">
          <span className="tag-chip">Выбран: {selectedBike.title}</span>
          <span className="tag-chip">{selectedBike.article ?? selectedBike.internalCode}</span>
        </div>
      ) : null}

      <div className="action-field-grid repair-create-grid">
        <label className="action-field">
          <span>Что делаем</span>
          <input
            className="action-input"
            maxLength={160}
            placeholder="Например, замена тормоза"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="action-field">
          <span>Сумма, руб.</span>
          <input
            className="action-input"
            inputMode="numeric"
            placeholder="Можно позже"
            value={amountRub}
            onChange={(event) => setAmountRub(event.target.value)}
          />
        </label>
      </div>

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

      <label className="action-field">
        <span>Комментарий</span>
        <textarea
          className="action-input action-textarea"
          maxLength={4000}
          placeholder="Можно оставить пустым и добавить позиции позже"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <div className="record-actions repair-create-actions">
        <button className="action-button" disabled={!canEditRepairs || isPending || !selectedBike} type="button" onClick={submit}>
          {isPending ? "Сохраняю..." : "Оформить ремонт"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canEditRepairs ? <p className="route-card-note">Недостаточно прав для оформления ремонта.</p> : null}
    </article>
  );
}
