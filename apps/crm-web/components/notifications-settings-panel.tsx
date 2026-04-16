"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { NotificationsWorkspaceData } from "../lib/notifications-api";
import {
  confirmTelegramQrConnectionPassword,
  getTelegramQrConnectionStatus,
  NotificationsApiError,
  resetTelegramConnection,
  saveNotificationScenario,
  startTelegramQrConnection
} from "../lib/notifications-api";
import { useHasPermission } from "./auth-actor-context";

const DISPLAY_TIME_ZONE = "Europe/Moscow";

const SCENARIO_PLACEHOLDERS: Record<
  NotificationsWorkspaceData["scenarios"]["rows"][number]["type"],
  Array<{ code: string; description: string }>
> = {
  DEAL_CREATED: [
    { code: "{{deal.number}}", description: "номер сделки" },
    { code: "{{bank.name}}", description: "название банка" },
    { code: "{{bank.instruction_type}}", description: "QR или реквизиты" },
    { code: "{{bank.instruction_body}}", description: "основной текст инструкций банка" },
    { code: "{{bank.phone}}", description: "телефон банка" },
    { code: "{{bank.comment}}", description: "комментарий банка" }
  ],
  PAYMENT_RECEIVED: [
    { code: "{{deal.number}}", description: "номер сделки" },
    { code: "{{deal.next_payment_date}}", description: "следующая дата оплаты или текст, что платеж не нужен" },
    { code: "{{deal.next_payment_amount_rub}}", description: "сумма следующего платежа" }
  ]
};

function formatDateTime(value: string | null) {
  if (!value) {
    return "еще не отправлялось";
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

function formatQrRemaining(value: string) {
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) {
    return "—";
  }

  const diff = expiresAt - Date.now();
  if (diff <= 0) {
    return "истек";
  }

  const seconds = Math.ceil(diff / 1000);
  if (seconds < 60) {
    return `${seconds} сек`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function getScenarioLabel(type: NotificationsWorkspaceData["scenarios"]["rows"][number]["type"]) {
  return type === "DEAL_CREATED" ? "Сделка создана" : "Оплата подтверждена";
}

function getStatusLabel(status: NotificationsWorkspaceData["journal"]["rows"][number]["status"]) {
  switch (status) {
    case "QUEUED":
      return "В очереди";
    case "SENT":
      return "Отправлено";
    case "FAILED":
      return "Ошибка";
    case "SKIPPED":
      return "Пропущено";
    default:
      return status;
  }
}

function getStatusChipClass(status: NotificationsWorkspaceData["journal"]["rows"][number]["status"]) {
  switch (status) {
    case "SENT":
      return "";
    case "FAILED":
      return "is-danger";
    case "SKIPPED":
      return "is-warning";
    default:
      return "is-neutral";
  }
}

function getDealLabel(deal: NotificationsWorkspaceData["journal"]["rows"][number]["deal"]) {
  if (!deal) {
    return "Без привязки к сделке";
  }

  return `${deal.kind === "RENTAL" ? "Аренда" : "Выкуп"} · ${deal.dealNumber}`;
}

function getConnectionStatusLabel(connection: NotificationsWorkspaceData["connection"]) {
  if (connection.status === "CONNECTED") {
    return "Подключено";
  }

  if (connection.status === "ERROR") {
    return "Ошибка";
  }

  if (connection.configured) {
    return "Настроено, не подключено";
  }

  return "Не настроено";
}

function getConnectionStatusChipClass(connection: NotificationsWorkspaceData["connection"]) {
  if (connection.status === "CONNECTED") {
    return "";
  }

  if (connection.status === "ERROR") {
    return "is-danger";
  }

  return "is-neutral";
}

function getConnectionBannerClass(connection: NotificationsWorkspaceData["connection"]) {
  if (connection.status === "CONNECTED") {
    return "is-success";
  }

  if (connection.status === "ERROR" || connection.lastErrorText) {
    return "is-error";
  }

  return "is-muted";
}

function getConnectionBannerText(connection: NotificationsWorkspaceData["connection"]) {
  if (connection.status === "CONNECTED") {
    return "Telegram-сессия сохранена, а новые `QUEUED` записи уходят в реальную отправку без второго transport contour.";
  }

  if (connection.status === "ERROR" || connection.lastErrorText) {
    return connection.lastErrorText ?? "Последняя попытка Telegram-подключения завершилась ошибкой.";
  }

  if (connection.configured) {
    return "API ID уже сохранен. Можно получить новый QR и переподключить Telegram без старого dashboard.";
  }

  return "Укажите Telegram API ID и API Hash, затем получите QR-код. После подтверждения CRM начнет обрабатывать `QUEUED` уведомления.";
}

export function NotificationsSettingsPanel(props: {
  workspace: NotificationsWorkspaceData;
}) {
  const router = useRouter();
  const canEdit = useHasPermission("notifications.edit");
  const [isScenarioPending, startScenarioTransition] = useTransition();
  const [isConnectionPending, startConnectionTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { isEnabled: boolean; templateText: string }>>({});
  const [connection, setConnection] = useState(props.workspace.connection);
  const [apiId, setApiId] = useState(props.workspace.connection.apiId ?? "");
  const [apiHash, setApiHash] = useState("");
  const [qrFlowId, setQrFlowId] = useState("");
  const [qrUrl, setQrUrl] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState("");
  const [qrNeedsPassword, setQrNeedsPassword] = useState(false);
  const [qrPassword, setQrPassword] = useState("");

  useEffect(() => {
    const nextDrafts = Object.fromEntries(
      props.workspace.scenarios.rows.map((scenario) => [
        scenario.id,
        {
          isEnabled: scenario.isEnabled,
          templateText: scenario.templateText
        }
      ])
    );

    setDrafts(nextDrafts);
  }, [props.workspace]);

  useEffect(() => {
    setConnection(props.workspace.connection);
    setApiId(props.workspace.connection.apiId ?? "");
  }, [props.workspace.connection]);

  const journalRows = useMemo(
    () => props.workspace.journal.rows,
    [props.workspace.journal.rows]
  );
  const qrImageSrc = useMemo(() => {
    if (!qrUrl) {
      return "";
    }

    return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrUrl)}`;
  }, [qrUrl]);

  function setScenarioDraft(scenarioId: string, patch: Partial<{ isEnabled: boolean; templateText: string }>) {
    setDrafts((current) => ({
      ...current,
      [scenarioId]: {
        ...current[scenarioId],
        ...patch
      }
    }));
  }

  function saveScenario(scenarioId: string) {
    const draft = drafts[scenarioId];
    if (!draft) {
      return;
    }

    setError(null);
    setStatus(null);

    startScenarioTransition(async () => {
      try {
        const payload = await saveNotificationScenario({
          scenarioId,
          isEnabled: draft.isEnabled,
          templateText: draft.templateText
        });

        setScenarioDraft(scenarioId, {
          isEnabled: payload.scenario.isEnabled,
          templateText: payload.scenario.templateText
        });
        setStatus(`Сценарий «${payload.scenario.name}» сохранен.`);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить сценарий.");
      }
    });
  }

  function resetQrState() {
    setQrFlowId("");
    setQrUrl("");
    setQrExpiresAt("");
    setQrNeedsPassword(false);
    setQrPassword("");
  }

  function startQrConnection() {
    if (!canEdit) {
      return;
    }

    if (!connection.configured && !apiId.trim()) {
      setError("Укажите Telegram API ID перед получением QR.");
      setStatus(null);
      return;
    }

    if (!connection.configured && !apiHash.trim()) {
      setError("Укажите Telegram API Hash перед получением QR.");
      setStatus(null);
      return;
    }

    setError(null);
    setStatus(null);
    resetQrState();

    startConnectionTransition(async () => {
      try {
        const payload = await startTelegramQrConnection({
          apiId: apiId.trim() || undefined,
          apiHash: apiHash.trim() || undefined
        });

        setConnection(payload.connection);
        setApiId(payload.connection.apiId ?? apiId);

        if (payload.connected) {
          setStatus("Telegram уже подключен. Новые queued-уведомления можно отправлять сразу.");
          setApiHash("");
          router.refresh();
          return;
        }

        setQrFlowId(payload.qr?.flowId ?? "");
        setQrUrl(payload.qr?.tgUrl ?? "");
        setQrExpiresAt(payload.qr?.expiresAt ?? "");
        setStatus("QR готов. Откройте Telegram на телефоне и отсканируйте код.");
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось получить QR.");
      }
    });
  }

  function resetConnection() {
    if (!canEdit) {
      return;
    }

    setError(null);
    setStatus(null);

    startConnectionTransition(async () => {
      try {
        const payload = await resetTelegramConnection();
        setConnection(payload.connection);
        setApiId(payload.connection.apiId ?? "");
        setApiHash("");
        resetQrState();
        setStatus("Telegram-подключение сброшено. Можно получить новый QR.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сбросить Telegram-подключение.");
      }
    });
  }

  function confirmQrPassword() {
    if (!canEdit) {
      return;
    }

    if (!qrFlowId.trim()) {
      setError("QR-сессия не активна. Получите новый QR.");
      setStatus(null);
      return;
    }

    if (!qrPassword.trim()) {
      setError("Введите пароль 2FA Telegram.");
      setStatus(null);
      return;
    }

    setError(null);
    setStatus(null);

    startConnectionTransition(async () => {
      try {
        const payload = await confirmTelegramQrConnectionPassword({
          flowId: qrFlowId.trim(),
          password: qrPassword
        });
        setConnection(payload.connection);
        resetQrState();
        setApiHash("");
        setStatus("Telegram подключен через QR + 2FA.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось подтвердить пароль 2FA.");
      }
    });
  }

  useEffect(() => {
    if (!qrFlowId || !canEdit) {
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      let shouldContinue = true;

      try {
        const payload = await getTelegramQrConnectionStatus(qrFlowId);
        if (cancelled) {
          return;
        }

        setConnection(payload.connection);

        if (payload.status === "ok") {
          setStatus("Telegram подключен через QR.");
          setApiHash("");
          resetQrState();
          router.refresh();
          return;
        }

        if (payload.qr?.tgUrl) {
          setQrUrl(payload.qr.tgUrl);
        }

        if (payload.qr?.expiresAt) {
          setQrExpiresAt(payload.qr.expiresAt);
        }
      } catch (requestError) {
        if (cancelled) {
          return;
        }

        if (requestError instanceof NotificationsApiError && requestError.statusCode === 409) {
          setQrNeedsPassword(true);
          setStatus("Telegram просит пароль 2FA для входа по QR. Введите пароль ниже.");
          shouldContinue = false;
        } else if (requestError instanceof NotificationsApiError && requestError.statusCode === 410) {
          setError("QR-код истек. Получите новый QR.");
          resetQrState();
          shouldContinue = false;
        } else {
          setError(requestError instanceof Error ? requestError.message : "Не удалось проверить QR-сессию.");
        }
      } finally {
        if (!cancelled && qrFlowId && shouldContinue) {
          timer = setTimeout(() => {
            void poll();
          }, 2500);
        }
      }
    };

    timer = setTimeout(() => {
      void poll();
    }, 1200);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [canEdit, qrFlowId, router]);

  return (
    <section className="section-stack">
      <section className="surface-card notifications-settings-summary">
        <div className="surface-kicker">Уведомления / Telegram</div>
        <div className="orders-create-title-row">
          <div>
            <h3>Operator workspace уведомлений</h3>
            <p className="route-card-note">
              Tenant: {props.workspace.tenant.name} · live scenarios: {props.workspace.scenarios.total} · journal rows: {props.workspace.journal.total}.
            </p>
          </div>
          <div className="record-tags">
            <span className="tag-chip">DEAL_CREATED</span>
            <span className="tag-chip">PAYMENT_RECEIVED</span>
          </div>
        </div>
        {!canEdit ? (
          <p className="route-card-note">
            У вас есть только `notifications.view`: сценарии и журнал доступны для чтения, но изменения отключены.
          </p>
        ) : (
          <p className="route-card-note">
            `notifications.edit` позволяет включать сценарии и менять шаблон текста для новых уведомлений.
          </p>
        )}
        {status ? <div className="surface-banner is-success">{status}</div> : null}
        {error ? <div className="surface-banner is-error">{error}</div> : null}
      </section>

      <section className="surface-card notifications-telegram-card">
        <div className="notifications-telegram-head">
          <div>
            <div className="surface-kicker">Telegram transport</div>
            <h3>Connect / status</h3>
            <p className="route-card-note">
              Реальная доставка работает поверх уже существующих `NotificationScenario` и `Notification`, без второго journal или queue contour.
            </p>
          </div>
          <div className="record-tags">
            <span className={`tag-chip ${getConnectionStatusChipClass(connection)}`}>{getConnectionStatusLabel(connection)}</span>
            <span className="tag-chip is-neutral">{connection.label ?? "Telegram"}</span>
          </div>
        </div>

        <div className={`surface-banner ${getConnectionBannerClass(connection)}`}>
          {getConnectionBannerText(connection)}
        </div>

        <div className="notifications-telegram-meta">
          <div><strong>Аккаунт:</strong> {connection.label ?? "еще не подключен"}</div>
          <div><strong>Проверяли:</strong> {formatDateTime(connection.lastCheckedAt)}</div>
          <div><strong>API ID:</strong> {connection.apiId ?? "не сохранен"}</div>
        </div>

        {canEdit ? (
          <div className="notifications-telegram-setup">
            <div className="notifications-telegram-fields">
              <label className="action-field">
                <span>Telegram API ID</span>
                <input
                  className="action-input"
                  value={apiId}
                  inputMode="numeric"
                  placeholder="например 33379243"
                  disabled={isConnectionPending}
                  onChange={(event) => setApiId(event.target.value)}
                />
              </label>
              <label className="action-field">
                <span>Telegram API Hash</span>
                <input
                  className="action-input"
                  type="password"
                  value={apiHash}
                  placeholder={connection.configured ? "можно оставить пустым и использовать сохраненный Hash" : "введите API Hash"}
                  disabled={isConnectionPending}
                  onChange={(event) => setApiHash(event.target.value)}
                />
              </label>
            </div>

            <div className="action-row">
              <button
                type="button"
                className="action-button"
                disabled={isConnectionPending}
                onClick={startQrConnection}
              >
                {isConnectionPending ? "Готовим..." : connection.connected ? "Переподключить через QR" : "Получить QR"}
              </button>
              <button
                type="button"
                className="action-button ghost"
                disabled={isConnectionPending || (!connection.connected && !connection.configured)}
                onClick={resetConnection}
              >
                Сбросить подключение
              </button>
            </div>
          </div>
        ) : (
          <p className="route-card-note">
            У роли только `notifications.view`: статус Telegram виден, но подключение и сброс недоступны.
          </p>
        )}

        {qrUrl ? (
          <div className="notifications-qr-card">
            <div className="notifications-qr-image-wrap">
              {qrImageSrc ? (
                <img
                  src={qrImageSrc}
                  alt="QR для авторизации Telegram"
                  className="notifications-qr-image"
                />
              ) : null}
            </div>
            <div className="notifications-qr-copy">
              <div className="surface-kicker">QR авторизация</div>
              <div className="notifications-qr-steps">
                <div>1. Откройте Telegram на телефоне.</div>
                <div>2. Сканируйте QR-код.</div>
                <div>3. Подтвердите вход в приложении Telegram.</div>
              </div>
              <div className="route-card-note">
                Срок QR: <strong>{qrExpiresAt ? formatQrRemaining(qrExpiresAt) : "—"}</strong>
              </div>
              <a className="inline-link" href={qrUrl} target="_blank" rel="noreferrer">
                Открыть ссылку входа
              </a>
            </div>
          </div>
        ) : null}

        {qrNeedsPassword && canEdit ? (
          <div className="notifications-qr-password">
            <label className="action-field">
              <span>Пароль 2FA Telegram</span>
              <input
                className="action-input"
                type="password"
                value={qrPassword}
                placeholder="Введите пароль Telegram"
                disabled={isConnectionPending}
                onChange={(event) => setQrPassword(event.target.value)}
              />
            </label>

            <div className="action-row">
              <button
                type="button"
                className="action-button"
                disabled={isConnectionPending || !qrPassword.trim()}
                onClick={confirmQrPassword}
              >
                {isConnectionPending ? "Проверяем..." : "Подтвердить 2FA"}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="notifications-settings-grid">
        {props.workspace.scenarios.rows.map((scenario) => {
          const draft = drafts[scenario.id] ?? {
            isEnabled: scenario.isEnabled,
            templateText: scenario.templateText
          };
          const placeholders = SCENARIO_PLACEHOLDERS[scenario.type];

          return (
            <article className="surface-card notifications-scenario-card" key={scenario.id}>
              <div className="notifications-scenario-head">
                <div>
                  <div className="surface-kicker">{getScenarioLabel(scenario.type)}</div>
                  <h3>{scenario.name}</h3>
                </div>
                <div className="record-tags">
                  <span className={`tag-chip ${draft.isEnabled ? "" : "is-warning"}`}>{draft.isEnabled ? "Включен" : "Отключен"}</span>
                  <span className="tag-chip is-neutral">{scenario.channel}</span>
                </div>
              </div>

              <label className="notifications-toggle-row">
                <input
                  type="checkbox"
                  checked={draft.isEnabled}
                  disabled={!canEdit || isScenarioPending}
                  onChange={(event) => setScenarioDraft(scenario.id, { isEnabled: event.target.checked })}
                />
                <span>Создавать новые уведомления по live hook этого сценария</span>
              </label>

              <label className="action-field notifications-scenario-field">
                <span>Template text</span>
                <textarea
                  className="action-input notifications-scenario-textarea"
                  value={draft.templateText}
                  disabled={!canEdit || isScenarioPending}
                  onChange={(event) => setScenarioDraft(scenario.id, { templateText: event.target.value })}
                />
              </label>

              <div className="route-card-note">
                Обновлен: {formatDateTime(scenario.updatedAt)}
              </div>

              <div className="notifications-placeholder-grid">
                {placeholders.map((placeholder) => (
                  <div className="notifications-placeholder-row" key={placeholder.code}>
                    <code>{placeholder.code}</code>
                    <span>{placeholder.description}</span>
                  </div>
                ))}
              </div>

              <div className="action-row">
                <button
                  type="button"
                  className="action-button"
                  disabled={!canEdit || isScenarioPending}
                  onClick={() => saveScenario(scenario.id)}
                >
                  {isScenarioPending ? "Сохраняем..." : "Сохранить"}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="surface-card">
        <div className="orders-create-title-row">
          <div>
            <div className="surface-kicker">Notification journal</div>
            <h3>Последние уведомления</h3>
          </div>
          <span className="orders-expand-muted">Источник только один: таблица `Notification`</span>
        </div>

        <div className="notifications-journal-list">
          {journalRows.length > 0 ? journalRows.map((row) => (
            <article className="notifications-journal-row" key={row.id}>
              <div className="notifications-journal-main">
                <div className="status-line">
                  <div className="record-title">{row.scenario?.name ?? "Сценарий удален"}</div>
                  <div className="record-tags">
                    <span className={`tag-chip ${getStatusChipClass(row.status)}`}>{getStatusLabel(row.status)}</span>
                    <span className="tag-chip is-neutral">{getDealLabel(row.deal)}</span>
                  </div>
                </div>
                <div className="record-meta">
                  {row.client?.fullName ?? "Клиент не найден"} · получатель: {row.recipient}
                </div>
                <pre className="notifications-journal-message">{row.messageText}</pre>
                {row.reason ? <div className="notifications-journal-reason">Причина: {row.reason}</div> : null}
              </div>

              <div className="notifications-journal-side">
                <div><strong>Создано:</strong> {formatDateTime(row.createdAt)}</div>
                <div><strong>Отправлено:</strong> {formatDateTime(row.sentAt)}</div>
                <div><strong>Тип:</strong> {row.scenario ? getScenarioLabel(row.scenario.type) : "—"}</div>
              </div>
            </article>
          )) : (
            <div className="route-card-note">
              Журнал пока пуст. Новые записи появятся после live hooks по созданию сделки и подтверждению оплаты.
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
