import type { GpsSnapshotRecord } from "../lib/orders-api";

type SummaryItem = {
  label: string;
  value: string;
  tone?: "accent" | "warning" | "neutral";
};

type OverviewRow = {
  label: string;
  value: string;
};

type EquipmentItem = {
  id: string;
  type: "BATTERY" | "CHARGER" | "HELMET" | "CHAIN_LOCK" | "OTHER";
  label: string;
  quantity: number;
  comment: string | null;
};

type BankContext = {
  name: string;
  phone: string | null;
  comment: string | null;
  instructionType: string;
  requisitesTitle: string | null;
  requisitesText: string | null;
} | null;

function formatDateTime(value: string | null) {
  if (!value) {
    return "не задано";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(new Date(value));
}

function getGpsStatusLabel(status: NonNullable<GpsSnapshotRecord>["status"]) {
  switch (status) {
    case "ONLINE":
      return "GPS в сети";
    case "OFFLINE":
      return "GPS не в сети";
    case "ERROR":
      return "Ошибка GPS";
    default:
      return "GPS не подключен";
  }
}

function getGpsStatusClass(status: NonNullable<GpsSnapshotRecord>["status"]) {
  switch (status) {
    case "ONLINE":
      return "is-online";
    case "OFFLINE":
      return "is-offline";
    case "ERROR":
      return "is-error";
    default:
      return "is-setup";
  }
}

function getGpsSyncClass(syncState: NonNullable<GpsSnapshotRecord>["syncState"]) {
  switch (syncState) {
    case "FRESH":
      return "is-live";
    case "WARNING":
      return "is-warning";
    case "STALE":
    case "ERROR":
      return "is-stale";
    default:
      return "";
  }
}

function getGpsSyncText(gps: NonNullable<GpsSnapshotRecord>) {
  if (gps.lastSyncError) {
    return `Показан последний сохраненный снимок. Последняя синхронизация завершилась ошибкой: ${gps.lastSyncError}`;
  }

  if (gps.syncState === "STALE") {
    return "Показан сохраненный снимок. Данные GPS давно не обновлялись.";
  }

  if (gps.syncState === "WARNING") {
    return "Показан сохраненный снимок. Данные GPS стоит обновить.";
  }

  if (gps.syncState === "ERROR") {
    return "Показан сохраненный снимок. Есть проблема синхронизации GPS.";
  }

  return "Снимок GPS актуален.";
}

function trimMultilineText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeGpsDeviceLabel(value: string | null | undefined) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (/[ÐÑÃÂ�]/.test(normalized)) {
    return null;
  }

  return normalized;
}

export function DealContextPanel(props: {
  kicker: string;
  title: string;
  status: string;
  isProblem: boolean;
  summaryItems: SummaryItem[];
  overviewRows: OverviewRow[];
  gps: GpsSnapshotRecord | null;
  bank: BankContext;
  equipment: EquipmentItem[];
}) {
  const gps = props.gps;
  const gpsChipClass = gps ? getGpsStatusClass(gps.status) : "is-setup";
  const gpsAgeClass = gps?.status === "ONLINE" ? "is-live" : gps ? getGpsSyncClass(gps.syncState) || "is-warning" : "";
  const gpsNoteClass = gps ? getGpsSyncClass(gps.syncState) : "";
  const requisitesPreview = props.bank?.requisitesText ? trimMultilineText(props.bank.requisitesText, 220) : null;
  const gpsDeviceLabel = gps ? (normalizeGpsDeviceLabel(gps.deviceAlias) ?? normalizeGpsDeviceLabel(gps.deviceName)) : null;

  return (
    <div className="deal-center-side-stack">
      <article className="surface-card deal-center-context-card">
        <div className="surface-kicker">{props.kicker}</div>
        <div className="status-line">
          <h3>{props.title}</h3>
          <div className="orders-simple-statuses">
            {props.isProblem ? <span className="orders-simple-badge is-problem">Проблемы</span> : null}
            <span className="tag-chip">{props.status}</span>
          </div>
        </div>

        <div className="deal-center-summary-grid">
          {props.summaryItems.map((item) => (
            <div className={`deal-center-summary-item${item.tone ? ` is-${item.tone}` : ""}`} key={`${item.label}-${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

        <div className="deal-center-inline-list">
          {props.overviewRows.map((row) => (
            <div className="deal-center-inline-row" key={`${row.label}-${row.value}`}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      </article>

      <article className="surface-card deal-center-context-card">
        <div className="surface-kicker">GPS</div>
        <h3>Статус трекера</h3>
        {gps ? (
          <>
            <div className="gps-panel-shell">
              <div className="gps-panel-topline">
                <span className={["gps-chip", gpsChipClass].join(" ").trim()}>
                  <span className="gps-chip-dot" aria-hidden="true" />
                  <span>{getGpsStatusLabel(gps.status)}</span>
                </span>
                {gps.offlineAgeLabel ? (
                  <span className={["gps-age", gpsAgeClass].join(" ").trim()}>{gps.offlineAgeLabel}</span>
                ) : null}
                {gpsDeviceLabel ? (
                  <span className="gps-device-pill">{gpsDeviceLabel}</span>
                ) : null}
              </div>

              <div className="gps-meta-grid">
                <div className="gps-meta-item">
                  <span>Последний сигнал</span>
                  <strong>{gps.lastSeenLabel ?? "нет данных"}</strong>
                </div>
                <div className="gps-meta-item">
                  <span>Последняя синхронизация</span>
                  <strong>
                    {formatDateTime(gps.lastSyncAt)}
                    {gps.syncAgeLabel ? ` · ${gps.syncAgeLabel}` : ""}
                  </strong>
                </div>
                {gps.externalDeviceId ? (
                  <div className="gps-meta-item">
                    <span>ID устройства</span>
                    <strong>{gps.externalDeviceId}</strong>
                  </div>
                ) : null}
              </div>
            </div>

            {gps.syncState !== "FRESH" || gps.lastSyncError ? (
              <p className={["route-card-note", "gps-sync-note", gpsNoteClass].join(" ").trim()}>
                {getGpsSyncText(gps)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="route-card-note">Трекер к этой сделке пока не привязан.</p>
        )}
      </article>

      <article className="surface-card deal-center-context-card">
        <div className="surface-kicker">Банк</div>
        <h3>Реквизитный контекст</h3>
        {props.bank ? (
          <>
            <div className="deal-center-inline-list">
              <div className="deal-center-inline-row">
                <span>Банк</span>
                <strong>{props.bank.name}</strong>
              </div>
              <div className="deal-center-inline-row">
                <span>Режим</span>
                <strong>{props.bank.instructionType === "QR" ? "QR-код" : "Реквизиты"}</strong>
              </div>
              <div className="deal-center-inline-row">
                <span>Телефон</span>
                <strong>{props.bank.phone ?? "не заполнен"}</strong>
              </div>
              {props.bank.comment ? (
                <div className="deal-center-inline-row is-multiline">
                  <span>Комментарий</span>
                  <strong>{props.bank.comment}</strong>
                </div>
              ) : null}
            </div>

            {props.bank.requisitesTitle || requisitesPreview ? (
              <div className="deal-bank-requisites-card">
                <strong>{props.bank.requisitesTitle ?? "Основные реквизиты"}</strong>
                <p>{requisitesPreview ?? "Текст реквизитов пока не заполнен."}</p>
              </div>
            ) : (
              <p className="route-card-note">
                У банка пока нет основных реквизитов. Предпросмотр документа честно покажет пустое поле и предупреждение.
              </p>
            )}
          </>
        ) : (
          <p className="route-card-note">Банк в сделке пока не выбран.</p>
        )}
      </article>

      <article className="surface-card deal-center-context-card">
        <div className="surface-kicker">Комплект</div>
        <h3>Выданное оборудование</h3>
        {props.equipment.length > 0 ? (
          <div className="deal-center-chip-list">
            {props.equipment.map((item) => (
              <span className="tag-chip" key={item.id} title={item.comment ? `${item.label} (${item.comment})` : item.label}>
                {item.label}{item.quantity > 1 ? ` ×${item.quantity}` : ""}
              </span>
            ))}
          </div>
        ) : (
          <p className="route-card-note">Комплект по сделке не заполнен.</p>
        )}
      </article>
    </div>
  );
}
