"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { GpsWorkspaceData } from "../lib/gps-api";
import { useHasPermission } from "./auth-actor-context";

const DISPLAY_TIME_ZONE = "Europe/Moscow";
type TrackerRecord = GpsWorkspaceData["trackers"][number];
type BikeOptionRecord = GpsWorkspaceData["bikes"][number];
type FilterQuickValue = GpsWorkspaceData["filters"]["quick"];
type FilterBindingValue = GpsWorkspaceData["filters"]["binding"];
type FilterMatchValue = GpsWorkspaceData["filters"]["match"];
type FilterNetworkValue = GpsWorkspaceData["filters"]["network"];
type FilterSyncValue = GpsWorkspaceData["filters"]["sync"];
type FilterReviewValue = GpsWorkspaceData["filters"]["review"];

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "еще не обновлялось";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE
  }).format(new Date(value));
}

function formatBikeStatus(value: string) {
  switch (value) {
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
      return value;
  }
}

function formatDealStatus(value: string) {
  switch (value) {
    case "NEW":
      return "Новая";
    case "ACTIVE":
      return "Активна";
    case "OVERDUE":
      return "Просрочка";
    case "HOLD":
      return "На удержании";
    case "RETURN_PREP":
      return "Готовится возврат";
    case "COMPLETED":
      return "Завершена";
    case "CANCELED":
      return "Отменена";
    case "CLOSED":
      return "Закрыт";
    case "TERMINATED":
      return "Расторгнута";
    default:
      return value;
  }
}

function getTrackerStatusLabel(status: TrackerRecord["status"]) {
  switch (status) {
    case "ONLINE":
      return "В сети";
    case "OFFLINE":
      return "Не в сети";
    case "ERROR":
      return "Ошибка";
    default:
      return "Нет данных";
  }
}

function getTrackerStatusClass(status: TrackerRecord["status"]) {
  switch (status) {
    case "ONLINE":
      return "is-online";
    case "OFFLINE":
      return "is-offline";
    default:
      return "is-setup";
  }
}

function getConnectionChipClass(connection: GpsWorkspaceData["connection"]) {
  if (connection.status === "CONNECTED") {
    return "";
  }

  if (connection.status === "ERROR") {
    return "is-danger";
  }

  return "is-neutral";
}

function getConnectionBannerClass(connection: GpsWorkspaceData["connection"]) {
  if (connection.lastErrorText || connection.status === "ERROR") {
    return "is-error";
  }

  if (connection.status === "CONNECTED") {
    return "is-success";
  }

  return "is-muted";
}

function getConnectionBannerTitle(connection: GpsWorkspaceData["connection"]) {
  if (connection.lastErrorText || connection.status === "ERROR") {
    return "Подключение требует внимания";
  }

  if (connection.status === "CONNECTED") {
    return "StarLine подключен";
  }

  return "GPS пока не подключен";
}

function getConnectionBannerText(connection: GpsWorkspaceData["connection"]) {
  if (connection.lastErrorText || connection.status === "ERROR") {
    return connection.lastErrorText ?? "Последняя попытка подключения завершилась с ошибкой.";
  }

  if (connection.status === "CONNECTED") {
    return "CRM хранит актуальный снимок устройств и позволяет синхронизировать GPS, пересчитывать автосопоставление и вручную управлять привязкой.";
  }

  return "Сначала сохраните API-настройки и проверьте подключение. После этого можно запустить синхронизацию GPS, подтянуть устройства и связать их с велосипедами.";
}

function formatTrackerBikeLabel(bike: {
  title: string;
  article: string | null;
  branch?: { name: string } | null;
}) {
  const label = bike.article ? `${bike.title} · ${bike.article}` : bike.title;
  return bike.branch?.name ? `${label} · ${bike.branch.name}` : label;
}

function getCurrentBikeId(tracker: TrackerRecord) {
  return tracker.bike?.id ?? "";
}

function getBindingActionLabel(tracker: TrackerRecord, draftBikeId: string) {
  const currentBikeId = getCurrentBikeId(tracker);

  if (currentBikeId && !draftBikeId) {
    return "Отвязать";
  }

  if (!currentBikeId && draftBikeId) {
    return "Привязать";
  }

  if (currentBikeId && draftBikeId && draftBikeId !== currentBikeId) {
    return "Перепривязать";
  }

  if (currentBikeId) {
    return "Привязка актуальна";
  }

  return "Выберите велосипед";
}

function canSubmitBinding(tracker: TrackerRecord, draftBikeId: string) {
  return draftBikeId !== getCurrentBikeId(tracker);
}

function getTrackerSignalLabel(tracker: TrackerRecord) {
  if (tracker.signalState === "SYNC_ERROR") {
    return "Ошибка sync";
  }

  if (tracker.signalState === "SYNC_NEEDED") {
    return "Нужен sync";
  }

  if (tracker.signalState === "OFFLINE") {
    return "Трекер офлайн";
  }

  if (tracker.signalState === "ONLINE") {
    return "Сигнал в норме";
  }

  return "Нет актуального сигнала";
}

function getTrackerSignalClass(tracker: TrackerRecord) {
  if (tracker.signalState === "SYNC_ERROR") {
    return "is-danger";
  }

  if (tracker.signalState === "SYNC_NEEDED" || tracker.signalState === "OFFLINE") {
    return "is-warning";
  }

  if (tracker.signalState === "ONLINE") {
    return "";
  }

  return "is-neutral";
}

function getTrackerBindingStateLabel(tracker: TrackerRecord) {
  switch (tracker.bindingState) {
    case "BOUND_OK":
      return "Привязка актуальна";
    case "REVIEW_NEEDED":
      return "Нужна проверка";
    case "REBIND_CANDIDATE":
      return "К перепривязке";
    case "UNBOUND":
      return "Не привязан";
    case "UNBOUND_SUGGESTED":
      return "Есть подсказка";
    case "UNBOUND_AMBIGUOUS":
      return "Конфликт";
    default:
      return tracker.bindingState;
  }
}

function getTrackerBindingStateClass(tracker: TrackerRecord) {
  switch (tracker.bindingState) {
    case "BOUND_OK":
      return "";
    case "REVIEW_NEEDED":
    case "REBIND_CANDIDATE":
    case "UNBOUND_AMBIGUOUS":
      return "is-danger";
    case "UNBOUND":
      return "is-neutral";
    case "UNBOUND_SUGGESTED":
      return "is-warning";
    default:
      return "is-neutral";
  }
}

function getTrackerMatchStateLabel(tracker: TrackerRecord) {
  switch (tracker.matchState) {
    case "AUTO_MATCHED":
      return "Автопривязка";
    case "UNMATCHED":
      return "Не найден";
    case "AMBIGUOUS":
      return "Неоднозначно";
    case "REBIND_CANDIDATE":
      return "К перепривязке";
    case "MANUAL_BINDING":
      return "Ручная привязка";
    default:
      return tracker.matchState;
  }
}

function getTrackerMatchStateClass(tracker: TrackerRecord) {
  switch (tracker.matchState) {
    case "AUTO_MATCHED":
      return "";
    case "MANUAL_BINDING":
      return "is-neutral";
    case "UNMATCHED":
      return "is-warning";
    case "AMBIGUOUS":
    case "REBIND_CANDIDATE":
      return "is-danger";
    default:
      return "is-neutral";
  }
}

function getTrackerMatchStateNote(tracker: TrackerRecord) {
  switch (tracker.matchState) {
    case "AUTO_MATCHED":
      return "После синхронизации CRM сама нашла надежное точное совпадение артикула и привязала трекер без ручного шага.";
    case "MANUAL_BINDING":
      return "Текущая привязка была сохранена или исправлена вручную менеджером. Автопривязка этот трекер не меняет.";
    case "UNMATCHED":
      return tracker.suggestedBike
        ? `Надежного точного совпадения артикула нет. Есть только подсказка на ${formatTrackerBikeLabel(tracker.suggestedBike)}, поэтому решение остается за менеджером.`
        : "Надежное точное совпадение артикула не найдено. CRM ничего не меняет автоматически.";
    case "AMBIGUOUS":
      return tracker.reviewReason ?? "Найден конфликт или несколько кандидатов. CRM не делает автопривязку без ручной проверки.";
    case "REBIND_CANDIDATE":
      return "Трекер уже привязан, но новый артикул из StarLine указывает на другой велосипед. CRM сохраняет текущую привязку до ручного подтверждения.";
    default:
      return "Состояние автосопоставления пока не определено.";
  }
}

function getTrackerBindingStateNote(tracker: TrackerRecord) {
  if (tracker.bindingState === "BOUND_OK") {
    return "Текущая CRM-привязка подтверждена тем именем, которое пришло из StarLine.";
  }

  if (tracker.bindingState === "REBIND_CANDIDATE" && tracker.reviewCandidateBike) {
    return `StarLine теперь больше похож на ${formatTrackerBikeLabel(tracker.reviewCandidateBike)}. CRM ничего не перепривязывает автоматически и ждет ручного подтверждения.`;
  }

  if (tracker.bindingState === "UNBOUND_SUGGESTED" && tracker.suggestedBike) {
    return `Нашли подсказку на ${formatTrackerBikeLabel(tracker.suggestedBike)}. Проверьте велосипед перед привязкой.`;
  }

  return tracker.reviewReason ?? "Подсказки пока нет, выберите велосипед вручную.";
}

function getSuggestionQualityLabel(tracker: TrackerRecord) {
  if (tracker.suggestionMatchQuality === "EXACT") {
    return "Точное совпадение артикула";
  }

  if (tracker.suggestionMatchQuality === "PARTIAL") {
    return "Неполное совпадение";
  }

  return null;
}

function getTrackerCurrentVisibilityText(tracker: TrackerRecord) {
  if (!tracker.bike) {
    return "Сейчас трекер не отображается ни в карточке велосипеда, ни в сделке. Сначала нужна привязка.";
  }

  const base = `GPS уже виден в карточке велосипеда ${formatTrackerBikeLabel(tracker.bike)}.`;
  if (!tracker.bike.activeDeal) {
    return `${base} Активной сделки по этому велосипеду сейчас нет.`;
  }

  const kindLabel = tracker.bike.activeDeal.kind === "RENTAL" ? "аренды" : "выкупа";
  return `${base} В активной сделке ${kindLabel} ${tracker.bike.activeDeal.dealNumber} клиента ${tracker.bike.activeDeal.clientName} тоже виден GPS-блок.`;
}

function getTrackerPlannedVisibilityText(tracker: TrackerRecord, draftBike: BikeOptionRecord | null) {
  const currentBike = tracker.bike;

  if (currentBike && !draftBike) {
    return "После отвязки GPS исчезнет из карточки велосипеда и из активной сделки по нему, если она есть.";
  }

  if (!currentBike && draftBike) {
    return `После привязки GPS появится в карточке велосипеда ${formatTrackerBikeLabel(draftBike)}. Если по нему есть активная сделка, GPS появится и там.`;
  }

  if (currentBike && draftBike && draftBike.id !== currentBike.id) {
    return `После ручной перепривязки GPS уйдет с ${formatTrackerBikeLabel(currentBike)} и появится у ${formatTrackerBikeLabel(draftBike)}.`;
  }

  if (currentBike) {
    return "Текущая привязка уже сохранена. CRM не меняет ее автоматически даже при новом переименовании в StarLine.";
  }

  return "Выберите велосипед, чтобы GPS появился в карточке велосипеда и, при наличии активной сделки, в ее GPS-блоке.";
}

function getWorkspaceEmptyState(workspace: GpsWorkspaceData) {
  if (!workspace.connection.configured) {
    return {
      title: "Сначала подключите StarLine API",
      text: "Сохраните appId, appSecret, логин и пароль, затем проверьте подключение. После этого CRM сможет подтянуть устройства."
    };
  }

  if (workspace.connection.status === "CONNECTED") {
    return {
      title: "Подключение есть, устройств пока нет",
      text: "Запустите синхронизацию GPS. Если устройства не появились, проверьте аккаунт StarLine и права доступа."
    };
  }

  return {
    title: "Устройства пока недоступны",
    text: "Проверьте настройки API и повторите синхронизацию. Пока CRM не получила список трекеров."
  };
}

function getBikeCellText(tracker: TrackerRecord) {
  if (tracker.bike) {
    return formatTrackerBikeLabel(tracker.bike);
  }

  if (tracker.suggestedBike) {
    return `Подсказка: ${formatTrackerBikeLabel(tracker.suggestedBike)}`;
  }

  return "Не привязан";
}

function getRegistryProblemText(tracker: TrackerRecord) {
  if (tracker.bindingState === "REBIND_CANDIDATE" && tracker.reviewCandidateBike) {
    return `Кандидат: ${formatTrackerBikeLabel(tracker.reviewCandidateBike)}`;
  }

  if (tracker.bindingState === "REVIEW_NEEDED" || tracker.bindingState === "UNBOUND_AMBIGUOUS") {
    return tracker.reviewReason ?? "Нужна ручная проверка.";
  }

  if (tracker.bindingState === "UNBOUND_SUGGESTED" && tracker.suggestedBike) {
    return `${getSuggestionQualityLabel(tracker) ?? "Подсказка"}: ${formatTrackerBikeLabel(tracker.suggestedBike)}`;
  }

  if (tracker.matchState === "UNMATCHED") {
    return "Надежное точное совпадение артикула не найдено.";
  }

  if (tracker.signalState === "SYNC_ERROR" || tracker.signalState === "SYNC_NEEDED") {
    return tracker.lastSyncError ?? "Нужна повторная синхронизация снимка.";
  }

  if (tracker.signalState === "OFFLINE") {
    return tracker.offlineAgeLabel ? `Оффлайн: ${tracker.offlineAgeLabel}` : "Трекер сейчас не в сети.";
  }

  return "Критичных проблем нет.";
}

function getQuickChipLabel(value: FilterQuickValue) {
  switch (value) {
    case "all":
      return "Все";
    case "problems":
      return "Проблемные";
    case "unbound":
      return "Без привязки";
    case "rebind":
      return "К перепривязке";
    default:
      return value;
  }
}

const QUICK_CHIPS: FilterQuickValue[] = ["all", "problems", "unbound", "rebind"];

export function GpsSettingsPanel(props: {
  workspace: GpsWorkspaceData;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canManageSettings = useHasPermission("gps.manage_settings");
  const canManageBinding = useHasPermission("gps.manage_binding");
  const tenantSlug = props.workspace.tenant.slug;
  const [isPending, startTransition] = useTransition();
  const [appId, setAppId] = useState(props.workspace.connection.appId ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [userLogin, setUserLogin] = useState(props.workspace.connection.login ?? "");
  const [userPassword, setUserPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, string>>({});
  const [searchDraft, setSearchDraft] = useState(props.workspace.filters.q);
  const [expandedTrackerId, setExpandedTrackerId] = useState<string | null>(props.workspace.trackers[0]?.id ?? null);

  useEffect(() => {
    setSearchDraft(props.workspace.filters.q);
  }, [props.workspace.filters.q]);

  useEffect(() => {
    if (!expandedTrackerId || !props.workspace.trackers.some((tracker) => tracker.id === expandedTrackerId)) {
      setExpandedTrackerId(props.workspace.trackers[0]?.id ?? null);
    }
  }, [props.workspace.trackers, expandedTrackerId]);

  const bikeOptions = useMemo(
    () => props.workspace.bikes.map((bike) => ({
      value: bike.id,
      label: formatTrackerBikeLabel(bike)
    })),
    [props.workspace.bikes]
  );
  const bikesById = useMemo(
    () => new Map(props.workspace.bikes.map((bike) => [bike.id, bike])),
    [props.workspace.bikes]
  );
  const emptyState = getWorkspaceEmptyState(props.workspace);

  function setTrackerDraft(trackerId: string, bikeUnitId: string) {
    setBindingDrafts((current) => ({
      ...current,
      [trackerId]: bikeUnitId
    }));
  }

  function getDraftBikeId(tracker: TrackerRecord) {
    return bindingDrafts[tracker.id]
      ?? tracker.bike?.id
      ?? tracker.reviewCandidateBike?.id
      ?? tracker.suggestedBike?.id
      ?? "";
  }

  function getDraftBike(tracker: TrackerRecord) {
    const draftBikeId = getDraftBikeId(tracker);
    return draftBikeId ? bikesById.get(draftBikeId) ?? null : null;
  }

  function updateGpsQuery(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === "all") {
        next.delete(key);
        continue;
      }

      next.set(key, value);
    }

    const nextUrl = next.toString() ? `${pathname}?${next.toString()}` : pathname;
    startTransition(() => {
      router.replace(nextUrl, { scroll: false });
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateGpsQuery({
      gpsQ: searchDraft.trim() || null
    });
  }

  function handleResetFilters() {
    setSearchDraft("");
    updateGpsQuery({
      gpsQ: null,
      gpsQuick: null,
      gpsBinding: null,
      gpsMatch: null,
      gpsNetwork: null,
      gpsSync: null,
      gpsReview: null
    });
  }

  function runRequest(run: () => Promise<void>) {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        await run();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Операция не выполнена.");
      }
    });
  }

  async function readJsonError(response: Response) {
    const payload = await response.json().catch(() => null);
    return payload?.error?.message ?? `Request failed with ${response.status}`;
  }

  function handleTestConnection() {
    if (!appId.trim() || !appSecret.trim() || !userLogin.trim() || !userPassword.trim()) {
      setError("Для проверки заполните appId, appSecret, логин и пароль.");
      setStatus(null);
      return;
    }

    runRequest(async () => {
      const response = await fetch(`${getApiBase()}/gps/starline/test`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug,
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          userLogin: userLogin.trim(),
          userPassword: userPassword.trim()
        })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      const payload = await response.json();
      setStatus(`Подключение прошло. Найдено устройств: ${payload.deviceCount}.`);
    });
  }

  function handleConnect() {
    if (!appId.trim() || !appSecret.trim() || !userLogin.trim() || !userPassword.trim()) {
      setError("Для сохранения заполните appId, appSecret, логин и пароль.");
      setStatus(null);
      return;
    }

    runRequest(async () => {
      const response = await fetch(`${getApiBase()}/gps/starline/connect`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug,
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          userLogin: userLogin.trim(),
          userPassword: userPassword.trim()
        })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      const payload = await response.json();
      setStatus(`Настройки сохранены. Устройств в CRM: ${payload.deviceCount}.`);
      setUserPassword("");
      router.refresh();
    });
  }

  function handleSync() {
    runRequest(async () => {
      const response = await fetch(`${getApiBase()}/gps/starline/sync`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug
        })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      const payload = await response.json();
      const summary = payload.summary as {
        autoMatchedCount?: number;
        unmatchedCount?: number;
        ambiguousCount?: number;
        rebindCandidateCount?: number;
        manualBindingCount?: number;
      } | undefined;
      setStatus(
        `Синхронизация GPS завершена. Устройства из StarLine обновлены, снимок пересчитан и автосопоставление выполнено. Устройств: ${payload.deviceCount}. `
        + `Автопривязано: ${summary?.autoMatchedCount ?? 0}. `
        + `Не найдено: ${summary?.unmatchedCount ?? 0}. `
        + `Неоднозначно: ${summary?.ambiguousCount ?? 0}. `
        + `К перепривязке: ${summary?.rebindCandidateCount ?? 0}. `
        + `Ручных привязок: ${summary?.manualBindingCount ?? 0}.`
      );
      router.refresh();
    });
  }

  function handleBind(tracker: TrackerRecord) {
    const bikeUnitId = getDraftBikeId(tracker) || null;

    runRequest(async () => {
      const response = await fetch(`${getApiBase()}/gps/trackers/${tracker.id}/binding`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug,
          bikeUnitId
        })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      setBindingDrafts((current) => {
        const next = { ...current };
        delete next[tracker.id];
        return next;
      });
      setStatus(bikeUnitId ? "Трекер привязан к велосипеду." : "Привязка снята.");
      router.refresh();
    });
  }

  return (
    <section className="section-stack">
      <section className="surface-card gps-settings-card">
        <div className="surface-kicker">GPS / StarLine</div>
        <div className="gps-settings-head">
          <div>
            <h3>Подключение GPS API</h3>
            <p className="route-card-note">
              CRM работает через сохраненный снимок GPS: подключение, устройства, ручная привязка и статус синхронизации собраны в одном месте.
            </p>
          </div>

          <div className="record-tags">
            <span className={`tag-chip ${getConnectionChipClass(props.workspace.connection)}`}>
              {props.workspace.connection.status === "CONNECTED"
                ? "Подключено"
                : props.workspace.connection.status === "ERROR"
                  ? "Ошибка подключения"
                  : "Не подключено"}
            </span>
            {props.workspace.connection.legacyCompatibilityAvailable ? <span className="tag-chip">Резервный путь доступен</span> : null}
          </div>
        </div>

        <div className={`gps-connection-banner ${getConnectionBannerClass(props.workspace.connection)}`}>
          <div>
            <strong>{getConnectionBannerTitle(props.workspace.connection)}</strong>
            <p>{getConnectionBannerText(props.workspace.connection)}</p>
          </div>
          <div className="gps-connection-banner-side">
            <span>Статус CRM</span>
            <strong>{props.workspace.connection.label ?? (props.workspace.connection.status === "CONNECTED" ? "Подключение активно" : "Ожидает настройки")}</strong>
          </div>
        </div>

        <div className="gps-summary-grid">
          <article className="gps-summary-card">
            <span>Показано</span>
            <strong>{props.workspace.summary.trackersCount}</strong>
          </article>
          <article className="gps-summary-card">
            <span>Автопривязано</span>
            <strong>{props.workspace.summary.autoMatchedCount}</strong>
          </article>
          <article className="gps-summary-card">
            <span>Ручная привязка</span>
            <strong>{props.workspace.summary.manualBindingCount}</strong>
          </article>
          <article className="gps-summary-card">
            <span>Не найдено</span>
            <strong>{props.workspace.summary.unmatchedCount}</strong>
          </article>
          <article className="gps-summary-card">
            <span>Неоднозначно</span>
            <strong>{props.workspace.summary.ambiguousCount}</strong>
          </article>
          <article className="gps-summary-card">
            <span>К перепривязке</span>
            <strong>{props.workspace.summary.rebindCandidateCount}</strong>
          </article>
        </div>

        {error ? (
          <div className="gps-result-banner is-error">
            <strong>GPS-операция не выполнена</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {status ? (
          <div className="gps-result-banner is-success">
            <strong>Результат GPS-операции</strong>
            <span>{status}</span>
          </div>
        ) : null}

        <div className="gps-settings-layout">
          <section className="surface-card gps-settings-form-card">
            <div className="gps-registry-head">
              <div>
                <div className="surface-kicker">Реестр GPS</div>
                <h3>Компактный операторский список</h3>
                <p className="route-card-note">
                  Здесь видно текущую привязку, сигналы переименования из StarLine и проблемные трекеры. CRM не делает молчаливую перепривязку: любая перепривязка проходит только вручную.
                </p>
              </div>

              <div className="gps-registry-primary-action">
                <button
                  className="action-button"
                  disabled={!canManageSettings || isPending}
                  type="button"
                  onClick={handleSync}
                >
                  Синхронизировать GPS
                </button>
                <span>Получить устройства из StarLine, обновить снимок, пересчитать автосопоставление и безопасно привязать только надежные непривязанные трекеры. Если настройки еще не сохранены, CRM честно остановится без изменений.</span>
              </div>
            </div>

            <div className="gps-registry-toolbar">
              <form className="gps-registry-search" onSubmit={handleSearchSubmit}>
                <input
                  className="orders-simple-search"
                  placeholder="Поиск по артикулу, имени трекера, ID устройства или названию велосипеда"
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
                <button className="action-button is-secondary" disabled={isPending} type="submit">Найти</button>
                <button className="detail-link" disabled={isPending} type="button" onClick={handleResetFilters}>Сбросить</button>
              </form>

              <div className="gps-quick-chips">
                {QUICK_CHIPS.map((chip) => (
                  <button
                    className={`tag-chip gps-filter-chip${props.workspace.filters.quick === chip ? " is-active" : ""}`}
                    key={chip}
                    type="button"
                    onClick={() => updateGpsQuery({ gpsQuick: chip === "all" ? null : chip })}
                  >
                    {getQuickChipLabel(chip)}
                  </button>
                ))}
              </div>

              <div className="gps-filter-grid">
                <label className="action-field">
                  <span>Привязка</span>
                  <select
                    className="action-input"
                    value={props.workspace.filters.binding}
                    onChange={(event) => updateGpsQuery({ gpsBinding: event.target.value })}
                  >
                    <option value="all">Все</option>
                    <option value="bound">Привязан</option>
                    <option value="unbound">Не привязан</option>
                    <option value="suggested">Есть подсказка</option>
                  </select>
                </label>

                <label className="action-field">
                  <span>Сеть</span>
                  <select
                    className="action-input"
                    value={props.workspace.filters.network}
                    onChange={(event) => updateGpsQuery({ gpsNetwork: event.target.value })}
                  >
                    <option value="all">Все</option>
                    <option value="online">В сети</option>
                    <option value="offline">Не в сети</option>
                  </select>
                </label>

                <label className="action-field">
                  <span>Автосопоставление</span>
                  <select
                    className="action-input"
                    value={props.workspace.filters.match}
                    onChange={(event) => updateGpsQuery({ gpsMatch: event.target.value })}
                  >
                    <option value="all">Все</option>
                    <option value="auto_matched">Автопривязано</option>
                    <option value="manual_binding">Ручная привязка</option>
                    <option value="unmatched">Не найдено</option>
                    <option value="ambiguous">Неоднозначно</option>
                    <option value="rebind_candidate">К перепривязке</option>
                  </select>
                </label>

                <label className="action-field">
                  <span>Синхронизация</span>
                  <select
                    className="action-input"
                    value={props.workspace.filters.sync}
                    onChange={(event) => updateGpsQuery({ gpsSync: event.target.value })}
                  >
                    <option value="all">Все</option>
                    <option value="needs_sync">Нужна синхронизация</option>
                  </select>
                </label>

                <label className="action-field">
                  <span>Проверка привязки</span>
                  <select
                    className="action-input"
                    value={props.workspace.filters.review}
                    onChange={(event) => updateGpsQuery({ gpsReview: event.target.value })}
                  >
                    <option value="all">Все</option>
                    <option value="review_needed">Конфликт / нужна проверка</option>
                    <option value="rebind_candidate">Кандидат на перепривязку</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="gps-tracker-toolbar">
              <span>{props.workspace.summary.trackersCount > 0 ? `Показано: ${props.workspace.summary.trackersCount} из ${props.workspace.summary.totalTrackersCount}` : "Совпадений по фильтрам пока нет"}</span>
              <span>{props.workspace.summary.autoMatchedCount > 0 ? `Автопривязано: ${props.workspace.summary.autoMatchedCount}` : "Автопривязок пока нет"}</span>
              <span>{props.workspace.summary.manualBindingCount > 0 ? `Ручных привязок: ${props.workspace.summary.manualBindingCount}` : "Ручных привязок пока нет"}</span>
              <span>{props.workspace.summary.unmatchedCount > 0 ? `Не найдено: ${props.workspace.summary.unmatchedCount}` : "Все трекеры либо нашли точное совпадение, либо уже привязаны"}</span>
              <span>{props.workspace.summary.ambiguousCount > 0 ? `Неоднозначно: ${props.workspace.summary.ambiguousCount}` : "Конфликтных кейсов автосопоставления нет"}</span>
            </div>

            {props.workspace.trackers.length > 0 ? (
              <div className="gps-registry-table">
                <div className="gps-registry-header">
                  <span>Трекер</span>
                  <span>Велосипед</span>
                  <span>Сеть</span>
                  <span>Синхронизация</span>
                  <span>Автосопоставление / проблема</span>
                  <span>Действие</span>
                </div>

                {props.workspace.trackers.map((tracker) => {
                  const draftBikeId = getDraftBikeId(tracker);
                  const draftBike = getDraftBike(tracker);
                  const bindingActionLabel = getBindingActionLabel(tracker, draftBikeId);
                  const canSubmit = canSubmitBinding(tracker, draftBikeId);
                  const isExpanded = expandedTrackerId === tracker.id;
                  const suggestionQualityLabel = getSuggestionQualityLabel(tracker);

                  return (
                    <article className={`gps-registry-record${isExpanded ? " is-expanded" : ""}`} key={tracker.id}>
                      <div className="gps-registry-row">
                        <div className="gps-registry-cell gps-registry-main">
                          <strong>{tracker.deviceAlias || tracker.deviceName}</strong>
                          <span>ID устройства: {tracker.externalDeviceId}</span>
                          {tracker.deviceAlias && tracker.deviceAlias !== tracker.deviceName ? <span>Внешнее имя: {tracker.deviceName}</span> : null}
                          {tracker.bike?.activeDeal ? (
                            <span>
                              {tracker.bike.activeDeal.kind === "RENTAL" ? "Аренда" : "Выкуп"} {tracker.bike.activeDeal.dealNumber}
                            </span>
                          ) : null}
                        </div>

                        <div className="gps-registry-cell">
                          <strong>{getBikeCellText(tracker)}</strong>
                          <span>{tracker.bike ? formatBikeStatus(tracker.bike.status) : "Ожидает привязки"}</span>
                          {tracker.reviewCandidateBike ? <span>Кандидат: {formatTrackerBikeLabel(tracker.reviewCandidateBike)}</span> : null}
                        </div>

                        <div className="gps-registry-cell">
                          <span className={`gps-chip ${getTrackerStatusClass(tracker.status)}`}>
                            <span className="gps-chip-dot" />
                            {getTrackerStatusLabel(tracker.status)}
                          </span>
                          <span>Последний сигнал: {tracker.lastSeenLabel ?? "нет данных"}</span>
                          {tracker.offlineAgeLabel ? <span>Оффлайн: {tracker.offlineAgeLabel}</span> : null}
                        </div>

                        <div className="gps-registry-cell">
                          <span className={`tag-chip ${getTrackerSignalClass(tracker)}`}>{getTrackerSignalLabel(tracker)}</span>
                          <span>Синхронизация: {formatDateTime(tracker.lastSyncAt)}</span>
                          {tracker.syncAgeLabel ? <span>{tracker.syncAgeLabel}</span> : null}
                        </div>

                        <div className="gps-registry-cell">
                          <span className={`tag-chip ${getTrackerMatchStateClass(tracker)}`}>{getTrackerMatchStateLabel(tracker)}</span>
                          <span className={`tag-chip ${getTrackerBindingStateClass(tracker)}`}>{getTrackerBindingStateLabel(tracker)}</span>
                          {suggestionQualityLabel ? <span>{suggestionQualityLabel}</span> : null}
                          <span>{getRegistryProblemText(tracker)}</span>
                        </div>

                        <div className="gps-registry-cell gps-registry-actions">
                          <button
                            className="action-button is-secondary"
                            type="button"
                            onClick={() => setExpandedTrackerId(isExpanded ? null : tracker.id)}
                          >
                            {isExpanded ? "Скрыть" : "Открыть"}
                          </button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="gps-registry-details">
                          <div className="gps-registry-details-grid">
                          <div className="gps-registry-detail-card">
                              <strong>Автосопоставление / состояние привязки</strong>
                              <p>{getTrackerMatchStateNote(tracker)}</p>
                              <p>{getTrackerBindingStateNote(tracker)}</p>
                              {tracker.bike?.activeDeal ? (
                                <div className="gps-tracker-deal-note">
                                  <strong>Сделка по велосипеду</strong>
                                  <span>
                                    {tracker.bike.activeDeal.kind === "RENTAL" ? "Аренда" : "Выкуп"} {tracker.bike.activeDeal.dealNumber}
                                    {" · "}
                                    {formatDealStatus(tracker.bike.activeDeal.status)}
                                    {" · "}
                                    {tracker.bike.activeDeal.clientName}
                                  </span>
                                </div>
                              ) : null}
                            </div>

                            <div className="gps-tracker-visibility-grid">
                              <div className="gps-tracker-visibility-card">
                                <strong>Сейчас в CRM</strong>
                                <span>{getTrackerCurrentVisibilityText(tracker)}</span>
                              </div>
                              <div className="gps-tracker-visibility-card is-muted">
                                <strong>После сохранения</strong>
                                <span>{getTrackerPlannedVisibilityText(tracker, draftBike)}</span>
                              </div>
                            </div>

                            <div className="gps-tracker-bind gps-tracker-bind--compact">
                              <div className="gps-tracker-bind-header">
                                <strong>Привязка / перепривязка / отвязка</strong>
                                <span>
                                  {tracker.bike
                                    ? `Сейчас привязан к ${formatTrackerBikeLabel(tracker.bike)}`
                                    : "Можно принять подсказку или выбрать велосипед вручную"}
                                </span>
                              </div>

                              <div className="gps-tracker-bind-controls">
                                <label className="action-field">
                                  <span>Велосипед</span>
                                  <select
                                    className="action-input"
                                    disabled={!canManageBinding}
                                    value={draftBikeId}
                                    onChange={(event) => setTrackerDraft(tracker.id, event.target.value)}
                                  >
                                    <option value="">Не выбран</option>
                                    {bikeOptions.map((bike) => (
                                      <option key={bike.value} value={bike.value}>{bike.label}</option>
                                    ))}
                                  </select>
                                </label>

                                <button
                                  className="action-button"
                                  disabled={!canManageBinding || isPending || !canSubmit}
                                  type="button"
                                  onClick={() => handleBind(tracker)}
                                >
                                  {bindingActionLabel}
                                </button>
                              </div>

                              {!canManageBinding ? <p className="route-card-note">Недостаточно прав для привязки трекеров.</p> : null}

                              <div className="gps-tracker-bind-note">
                                {tracker.bike ? (
                                  <span>Сейчас: {formatTrackerBikeLabel(tracker.bike)} · {formatBikeStatus(tracker.bike.status)}</span>
                                ) : tracker.reviewCandidateBike ? (
                                  <span>Сигнал к перепривязке: {formatTrackerBikeLabel(tracker.reviewCandidateBike)}. CRM пока держит текущую привязку до ручного подтверждения.</span>
                                ) : tracker.suggestedBike ? (
                                  <span>Подсказка: {formatTrackerBikeLabel(tracker.suggestedBike)} · {formatBikeStatus(tracker.suggestedBike.status)}</span>
                                ) : tracker.hasAmbiguousSuggestion ? (
                                  <span>Подсказка неоднозначна, выберите велосипед вручную.</span>
                                ) : (
                                  <span>Подсказки нет, выберите велосипед вручную.</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="gps-empty-state gps-empty-state--filtered">
                <strong>{emptyState.title}</strong>
                <p>{props.workspace.summary.totalTrackersCount > 0 ? "По текущему поиску и фильтрам ничего не найдено. Ослабьте условия и повторите поиск." : emptyState.text}</p>
              </div>
            )}
          </section>

          <section className="surface-card gps-settings-form-card">
            <div className="surface-kicker">Настройки API</div>
            <h3>Сохранить креды и проверить подключение</h3>
            <p className="route-card-note gps-card-caption">
              Здесь сохраняется доступ к StarLine и запускается безопасная проверка подключения без изменения текущего UI в заказах.
            </p>

            <div className="action-field-grid">
              <label className="action-field">
                <span>StarLine appId</span>
                <input className="action-input" type="text" value={appId} onChange={(event) => setAppId(event.target.value)} />
              </label>

              <label className="action-field">
                <span>StarLine appSecret</span>
                <input className="action-input" placeholder="Введите заново при подключении" type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} />
              </label>

              <label className="action-field">
                <span>Логин</span>
                <input className="action-input" type="text" value={userLogin} onChange={(event) => setUserLogin(event.target.value)} />
              </label>

              <label className="action-field">
                <span>Пароль</span>
                <input className="action-input" placeholder="Введите заново при подключении" type="password" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} />
              </label>
            </div>

            <div className="record-actions">
              <button className="action-button is-secondary" disabled={!canManageSettings || isPending} type="button" onClick={handleTestConnection}>
                Проверить подключение
              </button>
              <button className="action-button" disabled={!canManageSettings || isPending} type="button" onClick={handleConnect}>
                Сохранить и подключить
              </button>
            </div>
            <p className="route-card-note gps-card-caption">
              Главную синхронизацию устройств и автосопоставление запускайте кнопкой <strong>«Синхронизировать GPS»</strong> в левом рабочем блоке.
            </p>
            {!canManageSettings ? <p className="route-card-note">Недостаточно прав для изменения настроек GPS.</p> : null}

            <div className="gps-connection-meta">
              <div className="gps-connection-row">
                <strong>Статус</strong>
                <span>
                  {props.workspace.connection.status === "CONNECTED"
                    ? "Подключение активно"
                    : props.workspace.connection.configured
                      ? "Нужна повторная проверка"
                      : "Креды еще не сохранены"}
                </span>
              </div>
              <div className="gps-connection-row">
                <strong>Аккаунт</strong>
                <span>{props.workspace.connection.login ?? "не сохранен"}</span>
              </div>
              <div className="gps-connection-row">
                <strong>Последняя проверка</strong>
                <span>{formatDateTime(props.workspace.connection.lastCheckedAt)}</span>
              </div>
              <div className="gps-connection-row">
                <strong>API</strong>
                <span>{props.workspace.connection.baseUrl}</span>
              </div>
              {props.workspace.connection.lastErrorText ? (
                <div className="gps-connection-row is-error">
                  <strong>Последняя ошибка</strong>
                  <span>{props.workspace.connection.lastErrorText}</span>
                </div>
              ) : null}
            </div>

          </section>
        </div>
      </section>
    </section>
  );
}
