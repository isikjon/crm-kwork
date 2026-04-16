"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BikeDetailData, BikeWorkspaceData } from "../lib/fleet-api";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

type BikeFormMode = "create" | "edit";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatStatusLabel(status: string) {
  switch (status) {
    case "AVAILABLE":
      return "Свободен";
    case "RESERVED":
      return "Забронирован";
    case "RENTED":
      return "В аренде";
    case "BUYOUT":
      return "В выкупе";
    case "RETURN_PENDING":
      return "Ожидает возврата";
    case "REPAIR":
      return "В ремонте";
    case "WRITTEN_OFF":
      return "Списан";
    default:
      return status;
  }
}

function formatRubles(kopecks: number | null | undefined) {
  return String(Math.max(0, Math.round((kopecks ?? 0) / 100)));
}

export function BikeForm(props: {
  mode: BikeFormMode;
  workspace: BikeWorkspaceData;
  bike?: BikeDetailData["bike"] | null;
}) {
  const router = useRouter();
  const canEditFleet = useHasPermission("fleet.edit");
  const tenantSlug = useTenantSlug();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState(props.bike?.title ?? "");
  const [bikeModelName, setBikeModelName] = useState(props.bike?.bikeModel?.name ?? "");
  const [article, setArticle] = useState(props.bike?.article ?? "");
  const [serialNumber, setSerialNumber] = useState(props.bike?.serialNumber ?? "");
  const [odometerKm, setOdometerKm] = useState(String(props.bike?.odometerKm ?? 0));
  const [purchaseCostRubles, setPurchaseCostRubles] = useState(formatRubles(props.bike?.purchaseCostKopecks));
  const [salePriceRubles, setSalePriceRubles] = useState(formatRubles(props.bike?.salePriceKopecks));
  const [status, setStatus] = useState(props.bike?.status ?? "AVAILABLE");
  const [branchId, setBranchId] = useState(props.bike?.branch?.id ?? "");
  const [conditionNote, setConditionNote] = useState(props.bike?.conditionNote ?? "");
  const [comment, setComment] = useState(props.bike?.comment ?? "");
  const [error, setError] = useState<string | null>(null);

  const isDealManagedStatus = status === "RENTED" || status === "BUYOUT" || status === "RETURN_PENDING";

  function submit() {
    setError(null);

    if (!title.trim()) {
      setError("Укажите название велосипеда.");
      return;
    }

    if (!bikeModelName.trim()) {
      setError("Укажите модель.");
      return;
    }

    startTransition(async () => {
      try {
        const endpoint = props.mode === "create" ? "/bikes" : `/bikes/${props.bike?.id}`;
        const method = props.mode === "create" ? "POST" : "PATCH";
        const response = await fetch(`${getApiBase()}${endpoint}`, {
          method,
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            title: title.trim(),
            bikeModelName: bikeModelName.trim(),
            article: article.trim() || undefined,
            serialNumber: serialNumber.trim() || undefined,
            odometerKm: Number(odometerKm || "0"),
            purchaseCostRubles: Number(purchaseCostRubles || "0"),
            salePriceRubles: Number(salePriceRubles || "0"),
            status,
            branchId: branchId || undefined,
            conditionNote: conditionNote.trim() || undefined,
            comment: comment.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        const bikeId = payload?.bike?.id ?? props.bike?.id;
        router.push(bikeId ? `/bikes?focusBikeId=${encodeURIComponent(bikeId)}` : "/bikes");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить велосипед.");
      }
    });
  }

  return (
    <section className="surface-card bike-form-card">
      <div className="bike-form-head">
        <div>
          <div className="surface-kicker">{props.mode === "create" ? "Новый велосипед" : "Редактирование велосипеда"}</div>
          <h3>{props.mode === "create" ? "Добавить велосипед" : "Обновить карточку велосипеда"}</h3>
          <p className="route-card-note">
            Короткая карточка парка: только основные поля, без GPS, склада и документов.
          </p>
        </div>

        <a className="detail-back-link" href={props.mode === "edit" && props.bike ? `/bikes/${props.bike.id}` : "/bikes"}>
          Назад
        </a>
      </div>

      <div className="bike-form-grid">
        <label className="action-field action-field-wide">
          <span>Название</span>
          <input className="action-input" type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>

        <label className="action-field action-field-wide">
          <span>Модель</span>
          <input
            className="action-input"
            list="bike-model-options"
            type="text"
            value={bikeModelName}
            onChange={(event) => setBikeModelName(event.target.value)}
          />
          <datalist id="bike-model-options">
            {props.workspace.bikeModels.map((model) => (
              <option key={model.id} value={model.name} />
            ))}
          </datalist>
        </label>

        <label className="action-field">
          <span>Артикул</span>
          <input className="action-input" type="text" value={article} onChange={(event) => setArticle(event.target.value)} />
        </label>

        <label className="action-field">
          <span>Серийный номер</span>
          <input className="action-input" type="text" value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} />
        </label>

        <label className="action-field">
          <span>Пробег, км</span>
          <input className="action-input" min="0" type="number" value={odometerKm} onChange={(event) => setOdometerKm(event.target.value)} />
        </label>

        <label className="action-field">
          <span>Себестоимость, руб.</span>
          <input className="action-input" min="0" type="number" value={purchaseCostRubles} onChange={(event) => setPurchaseCostRubles(event.target.value)} />
        </label>

        <label className="action-field">
          <span>Цена продажи, руб.</span>
          <input className="action-input" min="0" type="number" value={salePriceRubles} onChange={(event) => setSalePriceRubles(event.target.value)} />
        </label>

        <label className="action-field">
          <span>Статус</span>
          <select
            className="action-input"
            disabled={isDealManagedStatus}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="AVAILABLE">Свободен</option>
            <option value="RESERVED">Забронирован</option>
            <option value="REPAIR">В ремонте</option>
            <option value="WRITTEN_OFF">Списан</option>
            {isDealManagedStatus ? <option value={status}>{formatStatusLabel(status)}</option> : null}
          </select>
        </label>

        <label className="action-field">
          <span>Точка</span>
          <select className="action-input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">Без точки</option>
            {props.workspace.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>

        <label className="action-field action-field-wide">
          <span>Состояние</span>
          <input className="action-input" type="text" value={conditionNote} onChange={(event) => setConditionNote(event.target.value)} />
        </label>

        <label className="action-field action-field-wide">
          <span>Комментарий</span>
          <textarea
            className="action-input action-textarea"
            maxLength={800}
            placeholder="Необязательно"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
      </div>

      {isDealManagedStatus ? (
        <p className="route-card-note">
          Этот статус сейчас управляется активной сделкой и не редактируется вручную.
        </p>
      ) : null}
      {!canEditFleet ? <p className="route-card-note">Недостаточно прав для создания и редактирования велосипедов.</p> : null}

      {error ? <p className="action-status is-error">{error}</p> : null}

      <div className="record-actions">
        <button className="action-button" disabled={!canEditFleet || isPending} type="button" onClick={submit}>
          {isPending
            ? (props.mode === "create" ? "Сохраняю..." : "Обновляю...")
            : (props.mode === "create" ? "Сохранить велосипед" : "Сохранить изменения")}
        </button>
      </div>
    </section>
  );
}
