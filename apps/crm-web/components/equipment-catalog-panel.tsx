"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { EquipmentCatalogData, EquipmentCatalogType } from "../lib/equipment-api";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatTypeLabel(type: EquipmentCatalogType) {
  switch (type) {
    case "BATTERY":
      return "АКБ";
    case "CHARGER":
      return "Зарядка";
    case "HELMET":
      return "Шлем";
    case "CHAIN_LOCK":
      return "Цепной замок";
    default:
      return "Прочее";
  }
}

export function EquipmentCatalogPanel(props: {
  catalog: EquipmentCatalogData;
}) {
  const router = useRouter();
  const canManageEquipment = useHasPermission("equipment.manage");
  const [isPending, startTransition] = useTransition();
  const [type, setType] = useState<EquipmentCatalogType>("OTHER");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRows = props.catalog.rows.filter((item) => item.isActive);
  const archivedRows = props.catalog.rows.filter((item) => !item.isActive);

  function createItem() {
    setError(null);
    setStatus(null);

    if (!label.trim()) {
      setError("Укажите название позиции.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/equipment/catalog`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug: "prokolesa",
            type,
            label: label.trim(),
            note: note.trim() || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setLabel("");
        setNote("");
        setType("OTHER");
        setStatus("Позиция добавлена.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось добавить позицию.");
      }
    });
  }

  function deleteItem(itemId: string) {
    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/equipment/catalog/${itemId}?tenantSlug=prokolesa`, {
          method: "DELETE",
          credentials: "include"
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(payload?.archived ? "Позиция скрыта из новых заказов." : "Позиция удалена.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось удалить позицию.");
      }
    });
  }

  return (
    <section className="surface-card equipment-panel">
      <div className="surface-kicker">Комплекты / доп. оборудование</div>
      <div className="equipment-panel-head">
        <div>
          <h3>Справочник позиций</h3>
          <p className="route-card-note">
            Эти позиции выбирают в заказе. Они не живут в велосипеде по умолчанию.
          </p>
        </div>

        <div className="record-tags">
          <span className="tag-chip">Активных: {activeRows.length}</span>
          {archivedRows.length > 0 ? <span className="tag-chip">Скрытых: {archivedRows.length}</span> : null}
        </div>
      </div>

      <div className="tariff-kind-switcher equipment-quick-buttons equipment-type-switcher">
        {(["BATTERY", "CHARGER", "HELMET", "CHAIN_LOCK", "OTHER"] as EquipmentCatalogType[]).map((itemType) => (
          <button
            className={["tariff-kind-button", type === itemType ? "is-active" : ""].join(" ")}
            key={itemType}
            type="button"
            onClick={() => setType(itemType)}
          >
            {formatTypeLabel(itemType)}
          </button>
        ))}
      </div>

      <div className="equipment-create-grid is-compact">
        <label className="action-field">
          <span>Тип</span>
          <input className="action-input" readOnly type="text" value={formatTypeLabel(type)} />
        </label>

        <label className="action-field">
          <span>Название</span>
          <input
            className="action-input"
            placeholder={type === "OTHER" ? "Например, держатель телефона" : formatTypeLabel(type)}
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>

        <label className="action-field action-field-wide">
          <span>Комментарий</span>
          <input className="action-input" placeholder="Необязательно" type="text" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>

      <div className="record-actions">
        <button className="action-button" disabled={!canManageEquipment || isPending} type="button" onClick={createItem}>
          {isPending ? "Сохраняю..." : "Добавить позицию"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canManageEquipment ? <p className="route-card-note">Недостаточно прав для изменения справочника комплектов.</p> : null}

      <div className="equipment-list">
        {activeRows.map((item) => (
          <div className="equipment-list-row" key={item.id}>
            <div className="equipment-list-main">
              <strong>{item.label}</strong>
              <span>{formatTypeLabel(item.type)}</span>
              {item.note ? <span>{item.note}</span> : null}
            </div>

            <div className="equipment-list-side">
              {(item._count?.dealItems ?? 0) > 0 ? <span className="tag-chip">выдач: {item._count?.dealItems ?? 0}</span> : null}
              <button className="detail-link" disabled={!canManageEquipment || isPending} type="button" onClick={() => deleteItem(item.id)}>
                {(item._count?.dealItems ?? 0) > 0 ? "Скрыть" : "Удалить"}
              </button>
            </div>
          </div>
        ))}

        {activeRows.length === 0 ? (
          <div className="clients-list-empty">Пока нет ни одной позиции.</div>
        ) : null}
      </div>

      {archivedRows.length > 0 ? (
        <details className="orders-compact-disclosure">
          <summary className="orders-compact-disclosure-summary">
            <strong>Скрытые позиции</strong>
            <span>{archivedRows.length}</span>
          </summary>
          <div className="orders-compact-disclosure-body">
            <div className="equipment-list">
              {archivedRows.map((item) => (
                <div className="equipment-list-row is-archived" key={item.id}>
                  <div className="equipment-list-main">
                    <strong>{item.label}</strong>
                    <span>{formatTypeLabel(item.type)}</span>
                  </div>
                  <div className="equipment-list-side">
                    <span className="tag-chip">в истории</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}
