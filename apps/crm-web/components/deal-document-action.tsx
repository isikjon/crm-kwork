"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";
import type { DocumentRegistryRow } from "../lib/documents-api";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function getPublicApiBase() {
  return getApiBase().replace(/\/api\/v1$/, "");
}

function buildDocumentActionHref(downloadHref: string, disposition: "attachment" | "inline") {
  const separator = downloadHref.includes("?") ? "&" : "?";
  return `${getPublicApiBase()}${downloadHref}${separator}disposition=${disposition}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(new Date(value));
}

function formatKindLabel(kind: string) {
  switch (kind) {
    case "CONTRACT":
      return "Договор";
    case "ISSUE_ACT":
      return "Акт выдачи";
    case "RETURN_ACT":
      return "Акт возврата";
    case "BUYOUT_CONTRACT":
      return "Договор выкупа";
    case "ADDENDUM":
      return "Допсоглашение";
    default:
      return kind;
  }
}

function formatTemplateDisplayName(input: {
  name: string | null | undefined;
  kind?: string | null;
  sourceEntityType?: "RENTAL" | "BUYOUT" | null;
}) {
  const trimmed = input.name?.trim() ?? "";
  if (!trimmed) {
    return formatKindLabel(input.kind ?? "");
  }

  if (!/[A-Za-z]/.test(trimmed)) {
    return trimmed;
  }

  if (/review owner/i.test(trimmed)) {
    return "Владелец tenant";
  }

  if (/review|contract|buyout|rental|issue act|return act|template/i.test(trimmed) || /^[A-Za-z0-9 _-]+$/.test(trimmed)) {
    if (input.kind === "CONTRACT" && input.sourceEntityType === "RENTAL") {
      return "Договор аренды";
    }

    if (input.kind === "BUYOUT_CONTRACT") {
      return "Договор выкупа";
    }

    return formatKindLabel(input.kind ?? "");
  }

  return trimmed;
}

function formatActorDisplayName(fullName: string | null | undefined) {
  const trimmed = fullName?.trim() ?? "";
  if (!trimmed) {
    return "автор не указан";
  }

  if (/^review owner$/i.test(trimmed)) {
    return "Владелец tenant";
  }

  return trimmed;
}

function formatTemplatesCount(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${count} шаблон`;
  }

  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `${count} шаблона`;
  }

  return `${count} шаблонов`;
}

function formatPreviewSourceLabel(sourceLabel: string) {
  return `Заказ: ${sourceLabel}`;
}

function formatHydrationMessage(status: string) {
  switch (status) {
    case "UPDATED":
      return "Часть полей добрана из архивных данных CRM.";
    case "ALREADY_HYDRATED":
      return "Данных сделки достаточно для выпуска документа.";
    case "SKIPPED_NO_REFERENCE":
      return "Документ собран по текущим данным сделки.";
    case "SKIPPED_NO_CONNECTION":
      return "Архив сейчас недоступен. Документ собран по текущим данным системы.";
    case "FAILED":
      return "Проверьте документ перед выпуском: часть данных могла не подтянуться автоматически.";
    default:
      return "Проверьте документ перед выпуском.";
  }
}

function formatPreviewWarning(warning: string) {
  const normalized = warning.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  if (/stable legacyReference|legacy hydration|legacy MoySklad/i.test(normalized)) {
    return null;
  }

  const emptyMatch = normalized.match(/пустые значения:\s*(\d+)/i);
  if (emptyMatch) {
    return `Есть пустые поля: ${emptyMatch[1]}. Перед выпуском проверьте документ.`;
  }

  const missingMatch = normalized.match(/не относящиеся к текущему deal context:\s*(\d+)/i);
  if (missingMatch) {
    return `В шаблоне есть поля вне текущего контекста сделки: ${missingMatch[1]}.`;
  }

  const unknownMatch = normalized.match(/неизвестные CRM placeholders:\s*(\d+)/i);
  if (unknownMatch) {
      return `В шаблоне есть неподдерживаемые поля: ${unknownMatch[1]}. Проверьте шаблон.`;
  }

  if (/неизвестные коды:/i.test(normalized)) {
    return "В шаблоне есть неподдерживаемые поля. Проверьте шаблон перед выпуском.";
  }

  if (/DOCX может содержать placeholders/i.test(normalized)) {
    return "Шаблон DOCX требует ручной проверки перед выпуском.";
  }

  return normalized;
}

type DealTemplateSummary = {
  id: string;
  kind: string;
  name: string;
  nextDocumentNumber: string;
};

type StageConfig = {
  kind: string;
  title: string;
  description: string;
};

type TemplatePreviewData = {
  template: {
    id: string;
    name: string;
    kind: string;
    sourceEntityType: string;
    nextDocumentNumber: string;
  };
  preview: {
    sourceEntityType: string;
    sourceEntityId: string;
    sourceLabel: string;
    hydration: {
      status: string;
      message: string;
      legacyFilledCodes: string[];
    };
    summary: {
      totalRows: number;
      filledRows: number;
      emptyRows: number;
      missingRows: number;
      unknownRows: number;
      legacyRows: number;
    };
    warnings: string[];
  };
};

type IssuedDraft = {
  id: string;
  documentNumber: string | null;
  title: string;
  downloadHref: string;
};

type TemplatesResponse = {
  rows: DealTemplateSummary[];
};

type RegistryResponse = {
  rows: DocumentRegistryRow[];
};

function getStageConfigs(sourceEntityType: "RENTAL" | "BUYOUT"): StageConfig[] {
  if (sourceEntityType === "BUYOUT") {
    return [
      {
        kind: "BUYOUT_CONTRACT",
        title: "Договор выкупа",
        description: "Основной документ по сделке выкупа."
      },
      {
        kind: "ADDENDUM",
        title: "Допсоглашения",
        description: "Шаблонные изменения условий выкупа без ухода в свободный текстовый редактор."
      }
    ];
  }

  return [
    {
      kind: "CONTRACT",
      title: "Договор",
      description: "Основной договор аренды по текущему заказу."
    },
    {
      kind: "ISSUE_ACT",
      title: "Акт выдачи",
      description: "Фиксация выдачи велосипеда, банка и комплекта по сделке."
    },
    {
      kind: "RETURN_ACT",
      title: "Акт возврата",
      description: "Фиксация возврата техники и состояния комплекта."
    },
    {
      kind: "ADDENDUM",
      title: "Допсоглашения",
      description: "Шаблонные изменения условий аренды и дополнительные документы по текущей сделке."
    }
  ];
}

function formatIssuedDocumentLabel(document: DocumentRegistryRow) {
  return document.documentNumber
    ?? formatTemplateDisplayName({
      name: document.title,
      kind: document.template?.kind ?? null,
      sourceEntityType: document.sourceEntityType === "RENTAL" || document.sourceEntityType === "BUYOUT"
        ? document.sourceEntityType
        : null
    });
}

async function fetchDealTemplates(sourceEntityType: "RENTAL" | "BUYOUT", tenantSlug: string) {
  const query = new URLSearchParams({
    tenantSlug,
    sourceEntityType
  });
  const response = await fetch(`${getApiBase()}/documents/templates?${query.toString()}`, {
    credentials: "include"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return (payload as TemplatesResponse).rows.filter((template) => Boolean(template.id));
}

async function fetchDealDocuments(params: {
  sourceEntityType: "RENTAL" | "BUYOUT";
  sourceEntityId: string;
  tenantSlug: string;
}) {
  const query = new URLSearchParams({
    tenantSlug: params.tenantSlug,
    sourceEntityType: params.sourceEntityType,
    sourceEntityId: params.sourceEntityId,
    limit: "12"
  });
  const response = await fetch(`${getApiBase()}/documents/registry?${query.toString()}`, {
    credentials: "include"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return (payload as RegistryResponse).rows;
}

function openDocumentWindow(url: string) {
  const openedWindow = window.open(url, "_blank");
  if (!openedWindow) {
    window.location.href = url;
    return null;
  }

  return openedWindow;
}

function printDocumentHref(downloadHref: string) {
  const inlineHref = buildDocumentActionHref(downloadHref, "inline");
  const printWindow = openDocumentWindow(inlineHref);
  if (!printWindow) {
    return;
  }

  const triggerPrint = () => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // If browser blocks scripted print for inline content, the document still opens in a printable tab.
    }
  };

  window.setTimeout(triggerPrint, 900);
}

function DocumentStageCard(props: {
  sourceEntityId: string;
  stage: StageConfig;
  templates: DealTemplateSummary[];
  issuedDocuments: DocumentRegistryRow[];
  compact?: boolean;
  onIssued?: () => void;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canGenerateDocuments = useHasPermission("documents.generate");
  const [templateId, setTemplateId] = useState(props.templates[0]?.id ?? "");
  const [preview, setPreview] = useState<TemplatePreviewData | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedDraft, setIssuedDraft] = useState<IssuedDraft | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedTemplate = props.templates.find((template) => template.id === templateId) ?? null;
  const recentDocuments = props.issuedDocuments.slice(0, 2);
  const previewWarnings = preview?.preview.warnings
    .map(formatPreviewWarning)
    .filter((warning): warning is string => Boolean(warning))
    .slice(0, 3) ?? [];

  useEffect(() => {
    setTemplateId(props.templates[0]?.id ?? "");
  }, [props.templates]);

  useEffect(() => {
    setIssuedDraft(null);
  }, [props.sourceEntityId, templateId]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview(templateIdValue: string) {
      setPreviewPending(true);
      setPreviewError(null);

      try {
        const query = new URLSearchParams({
          tenantSlug,
          sourceEntityId: props.sourceEntityId
        });

        const response = await fetch(`${getApiBase()}/documents/templates/${templateIdValue}/preview?${query.toString()}`, {
          credentials: "include"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        if (!cancelled) {
          setPreview(payload);
        }
      } catch (requestError) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(requestError instanceof Error ? requestError.message : "Не удалось построить предпросмотр.");
        }
      } finally {
        if (!cancelled) {
          setPreviewPending(false);
        }
      }
    }

    if (!canGenerateDocuments || !templateId) {
      setPreview(null);
      setPreviewError(canGenerateDocuments ? null : "Предпросмотр документа доступен только пользователям с правом генерации.");
      setPreviewPending(false);
      return () => {
        cancelled = true;
      };
    }

    void loadPreview(templateId);
    return () => {
      cancelled = true;
    };
  }, [canGenerateDocuments, templateId, props.sourceEntityId, tenantSlug]);

  function generate() {
    setStatus(null);
    setError(null);

    if (!templateId) {
      setError("Выберите шаблон.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/documents/templates/${templateId}/generate-draft`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            sourceEntityId: props.sourceEntityId,
            commit: true
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        const nextIssuedDraft = {
          id: payload?.draft?.document?.id ?? "",
          documentNumber: payload?.draft?.document?.documentNumber ?? null,
          title: payload?.draft?.document?.title ?? selectedTemplate?.name ?? "Документ",
          downloadHref: payload?.draft?.downloadHref ?? ""
        } satisfies IssuedDraft;

        setIssuedDraft(nextIssuedDraft);
        setStatus(`Документ ${nextIssuedDraft.documentNumber ?? nextIssuedDraft.title} выпущен.`);
        props.onIssued?.();
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось выпустить документ.");
      }
    });
  }

  function openIssuedDocument(downloadHref: string) {
    openDocumentWindow(buildDocumentActionHref(downloadHref, "inline"));
  }

  function downloadIssuedDocument(downloadHref: string) {
    window.location.href = buildDocumentActionHref(downloadHref, "attachment");
  }

  function printIssuedDocument(downloadHref: string) {
    printDocumentHref(downloadHref);
  }

  return (
    <article className={`surface-card action-card documents-deal-stage${props.compact ? " documents-deal-stage-compact" : ""}`}>
      {!props.compact ? <div className="surface-kicker">{formatKindLabel(props.stage.kind)}</div> : null}
      {!props.compact ? (
        <>
          <div className="status-line">
            <h3>{props.stage.title}</h3>
            <span>{formatTemplatesCount(props.templates.length)}</span>
          </div>
          <p className="route-card-note">{props.stage.description}</p>
        </>
      ) : null}

      {props.templates.length > 0 ? (
        <>
          {props.compact ? (
            <div className="documents-stage-compact-bar">
              <label className="action-field documents-stage-template-field">
                <span>Документ</span>
                <select className="action-input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                  {props.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {formatTemplateDisplayName({ name: template.name, kind: template.kind })} · {template.nextDocumentNumber}
                    </option>
                  ))}
                </select>
              </label>

              {selectedTemplate ? (
                <div className="documents-stage-next-number">
                  <span>Следующий номер</span>
                  <strong>{selectedTemplate.nextDocumentNumber}</strong>
                </div>
              ) : null}

              <div className="documents-stage-compact-actions">
                <button className="action-button" type="button" onClick={generate} disabled={!canGenerateDocuments || isPending || previewPending || !templateId}>
                  {isPending ? "Выпускаю..." : "Выпустить"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label className="action-field">
                <span>Выбрать шаблон</span>
                <select className="action-input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                  {props.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {formatTemplateDisplayName({ name: template.name, kind: template.kind })} · {template.nextDocumentNumber}
                    </option>
                  ))}
                </select>
              </label>

              {selectedTemplate ? (
                <p className="route-card-note">
                  Следующий номер: <strong>{selectedTemplate.nextDocumentNumber}</strong>
                </p>
              ) : null}
            </>
          )}

          {previewPending ? (
            <p className="route-card-note">Проверяю шаблон и данные сделки для этого документа...</p>
          ) : null}

          {issuedDraft ? (
            <div className="documents-stage-issued-now">
              <p className="route-card-note">
                Документ <strong>{issuedDraft.documentNumber ?? issuedDraft.title}</strong> выпущен. Дальше можно сразу открыть, скачать или распечатать его.
              </p>
              <div className="documents-issued-actions">
                <button className="ghost-button" type="button" onClick={() => openIssuedDocument(issuedDraft.downloadHref)}>
                  Открыть
                </button>
                <button className="ghost-button" type="button" onClick={() => downloadIssuedDocument(issuedDraft.downloadHref)}>
                  Скачать
                </button>
                <button className="ghost-button" type="button" onClick={() => printIssuedDocument(issuedDraft.downloadHref)}>
                  Печать
                </button>
              </div>
            </div>
          ) : null}

          {preview ? (
            <details className="documents-stage-preview-toggle">
              <summary>
                <strong>Проверка данных</strong>
                <span>{selectedTemplate ? selectedTemplate.nextDocumentNumber : "черновик"} · {formatPreviewSourceLabel(preview.preview.sourceLabel)}</span>
              </summary>

              <div className={`documents-stage-preview${props.compact ? " is-compact" : ""}`}>
                <p className="route-card-note">
                  <strong>{formatPreviewSourceLabel(preview.preview.sourceLabel)}</strong>
                </p>
                <p className="route-card-note">
                  Подстановка полей: {formatHydrationMessage(preview.preview.hydration.status)}
                </p>
                <ul className="surface-list compact-list">
                  <li>Подставлено: {preview.preview.summary.filledRows}</li>
                  <li>Пусто: {preview.preview.summary.emptyRows}</li>
                  <li>Нет данных: {preview.preview.summary.missingRows}</li>
                  {preview.preview.summary.unknownRows > 0 ? <li>Неподдерживаемых кодов: {preview.preview.summary.unknownRows}</li> : null}
                  {preview.preview.summary.legacyRows > 0 ? <li>Подтянуто из архива: {preview.preview.summary.legacyRows}</li> : null}
                </ul>
                {previewWarnings.length > 0 ? (
                  <ul className="surface-list compact-list">
                    {previewWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="route-card-note">Критичных замечаний по шаблону нет.</p>
                )}
              </div>
            </details>
          ) : null}

          {previewError ? <p className="action-status is-error">{previewError}</p> : null}

          {!props.compact ? (
            <div className="inline-actions">
              <button className="action-button" type="button" onClick={generate} disabled={!canGenerateDocuments || isPending || previewPending || !templateId}>
                {isPending ? "Выпускаю..." : "Выпустить"}
              </button>
            </div>
          ) : null}

          {recentDocuments.length > 0 && !props.compact ? (
            <div className="documents-stage-issued-list">
              <p className="route-card-note">
                Свежие {props.stage.kind === "ADDENDUM" ? "допсоглашения" : "документы"} по этому этапу:
              </p>
              {recentDocuments.map((document) => (
                <div className="documents-stage-issued-row" key={document.id}>
                  <div>
                    <strong>{formatIssuedDocumentLabel(document)}</strong>
                    <p className="route-card-note">
                      {formatDate(document.createdAt)} · {formatActorDisplayName(document.createdBy?.fullName)}
                    </p>
                  </div>
                  <div className="documents-issued-actions">
                    <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "inline")} target="_blank" rel="noreferrer">
                      Открыть
                    </a>
                    <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "attachment")}>
                      Скачать
                    </a>
                    <button className="ghost-button" type="button" onClick={() => printDocumentHref(document.downloadHref)}>
                      Печать
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="route-card-note">
          Для этого этапа сделки еще нет активного шаблона.
        </p>
      )}

      {status ? <p className="action-status is-success">{status}</p> : null}
      {error ? <p className="action-status is-error">{error}</p> : null}
      {!canGenerateDocuments ? <p className="route-card-note">Недостаточно прав для генерации документов.</p> : null}
    </article>
  );
}

export function DealDocumentAction(props: {
  sourceEntityType: "RENTAL" | "BUYOUT";
  sourceEntityId: string;
  templates?: DealTemplateSummary[];
  issuedDocuments?: DocumentRegistryRow[];
  compact?: boolean;
  onCompleted?: () => void;
}) {
  // Deal card is the issuing side of documents; template authoring and code management live on /documents.
  const tenantSlug = useTenantSlug();
  const [templates, setTemplates] = useState<DealTemplateSummary[]>(props.templates ?? []);
  const [issuedDocuments, setIssuedDocuments] = useState<DocumentRegistryRow[]>(props.issuedDocuments ?? []);
  const [activeStageKind, setActiveStageKind] = useState("");
  const [autoloadPending, setAutoloadPending] = useState(false);
  const [autoloadError, setAutoloadError] = useState<string | null>(null);
  const shouldAutoload = props.templates == null || props.issuedDocuments == null;
  const stages = getStageConfigs(props.sourceEntityType).filter((stage) => {
    if (stage.kind !== "ADDENDUM") {
      return true;
    }

    return templates.some((template) => template.kind === "ADDENDUM")
      || issuedDocuments.some((document) => document.template?.kind === "ADDENDUM");
  });
  const recentDocuments = issuedDocuments.slice(0, 3);

  useEffect(() => {
    if (props.templates) {
      setTemplates(props.templates);
    }
  }, [props.templates]);

  useEffect(() => {
    if (props.issuedDocuments) {
      setIssuedDocuments(props.issuedDocuments);
    }
  }, [props.issuedDocuments]);

  useEffect(() => {
    if (stages.length === 0) {
      setActiveStageKind("");
      return;
    }

    setActiveStageKind((current) => (
      stages.some((stage) => stage.kind === current)
        ? current
        : stages[0]?.kind ?? ""
    ));
  }, [stages]);

  useEffect(() => {
    let cancelled = false;

    async function loadDocumentsWorkspace() {
      // Autoload here is scoped to the current deal and should not be treated as a replacement for the full /documents workspace.
      if (!shouldAutoload) {
        return;
      }

      setAutoloadPending(true);
      setAutoloadError(null);

      try {
        const [nextTemplates, nextDocuments] = await Promise.all([
          fetchDealTemplates(props.sourceEntityType, tenantSlug),
          fetchDealDocuments({
            sourceEntityType: props.sourceEntityType,
            sourceEntityId: props.sourceEntityId,
            tenantSlug
          })
        ]);

        if (!cancelled) {
          setTemplates(nextTemplates);
          setIssuedDocuments(nextDocuments);
        }
      } catch (requestError) {
        if (!cancelled) {
          setAutoloadError(requestError instanceof Error ? requestError.message : "Не удалось загрузить документы по сделке.");
        }
      } finally {
        if (!cancelled) {
          setAutoloadPending(false);
        }
      }
    }

    void loadDocumentsWorkspace();

    return () => {
      cancelled = true;
    };
  }, [props.sourceEntityId, props.sourceEntityType, shouldAutoload, tenantSlug]);

  function handleDocumentsUpdated() {
    props.onCompleted?.();

    if (!shouldAutoload) {
      return;
    }

    setAutoloadPending(true);
    setAutoloadError(null);

    void Promise.all([
      fetchDealTemplates(props.sourceEntityType, tenantSlug),
      fetchDealDocuments({
        sourceEntityType: props.sourceEntityType,
        sourceEntityId: props.sourceEntityId,
        tenantSlug
      })
    ]).then(([nextTemplates, nextDocuments]) => {
      setTemplates(nextTemplates);
      setIssuedDocuments(nextDocuments);
    }).catch((requestError) => {
      setAutoloadError(requestError instanceof Error ? requestError.message : "Не удалось обновить документы по сделке.");
    }).finally(() => {
      setAutoloadPending(false);
    });
  }

  if (props.compact) {
    const activeStage = stages.find((stage) => stage.kind === activeStageKind) ?? stages[0] ?? null;
    const compactTemplates = activeStage ? templates.filter((template) => template.kind === activeStage.kind) : [];
    const compactStageDocuments = activeStage ? issuedDocuments.filter((document) => document.template?.kind === activeStage.kind) : [];

    return (
      <div className="detail-grid-full documents-deal-flow-stack is-compact">
        {autoloadError ? <p className="action-status is-error">{autoloadError}</p> : null}
        {autoloadPending ? <p className="route-card-note">Обновляю документы по сделке...</p> : null}

        <div className="documents-compact-toolbar">
          <label className="action-field documents-compact-kind-field">
            <span>Раздел</span>
            <select className="action-input" value={activeStageKind} onChange={(event) => setActiveStageKind(event.target.value)}>
              {stages.map((stage) => (
                <option key={stage.kind} value={stage.kind}>
                  {stage.title}
                </option>
              ))}
            </select>
          </label>

          <div className="documents-compact-toolbar-meta">
            <span>{issuedDocuments.length > 0 ? `${issuedDocuments.length} выпущено` : "документов пока нет"}</span>
            {activeStage ? <strong>{formatKindLabel(activeStage.kind)}</strong> : null}
          </div>
        </div>

        {activeStage ? (
          <DocumentStageCard
            compact
            key={`compact-${props.sourceEntityType}-${activeStage.kind}`}
            sourceEntityId={props.sourceEntityId}
            stage={activeStage}
            templates={compactTemplates}
            issuedDocuments={compactStageDocuments}
            onIssued={handleDocumentsUpdated}
          />
        ) : null}

        {recentDocuments.length > 0 ? (
          <div className="documents-compact-latest">
            <div className="documents-compact-latest-head">
              <strong>Свежие документы</strong>
              <span>{recentDocuments.length}</span>
            </div>
            <div className="documents-quick-access-list">
              {recentDocuments.map((document) => (
                <div className="documents-quick-access-row" key={document.id}>
                  <div>
                    <div className="status-line">
                      <strong>{formatIssuedDocumentLabel(document)}</strong>
                      <span>{document.template ? formatKindLabel(document.template.kind) : "Документ"}</span>
                    </div>
                    <p className="route-card-note">
                      {formatDate(document.createdAt)} · {formatActorDisplayName(document.createdBy?.fullName)}
                    </p>
                  </div>
                  <div className="documents-issued-actions">
                    <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "inline")} target="_blank" rel="noreferrer">
                      Открыть
                    </a>
                    <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "attachment")}>
                      Скачать
                    </a>
                    <button className="ghost-button" type="button" onClick={() => printDocumentHref(document.downloadHref)}>
                      Печать
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {issuedDocuments.length > recentDocuments.length ? (
          <details className="documents-compact-registry">
            <summary>
              <strong>Все выпущенные документы</strong>
              <span>{issuedDocuments.length}</span>
            </summary>
            <div className="documents-issued-list">
              {issuedDocuments.map((document) => (
                <div className="documents-issued-row" key={document.id}>
                  <div>
                    <div className="status-line">
                      <strong>{formatIssuedDocumentLabel(document)}</strong>
                      <span>{document.template ? formatKindLabel(document.template.kind) : "Документ"}</span>
                    </div>
                    <p className="route-card-note">
                      {document.documentNumber ?? "без номера"} · {formatDate(document.createdAt)}
                    </p>
                  </div>
                  <div className="documents-issued-actions">
                    <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "inline")} target="_blank" rel="noreferrer">
                      Открыть
                    </a>
                    <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "attachment")}>
                      Скачать
                    </a>
                    <button className="ghost-button" type="button" onClick={() => printDocumentHref(document.downloadHref)}>
                      Печать
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div className="detail-grid-full documents-deal-flow-stack">
      {autoloadError ? <p className="action-status is-error">{autoloadError}</p> : null}
      {autoloadPending ? <p className="route-card-note">Обновляю документы по сделке...</p> : null}
      {recentDocuments.length > 0 ? (
        <article className="surface-card documents-quick-access-card">
          <div className="surface-kicker">Быстрый доступ</div>
          <h3>Свежие документы по сделке</h3>
          <div className="documents-quick-access-list">
            {recentDocuments.map((document) => (
              <div className="documents-quick-access-row" key={document.id}>
                <div>
                  <div className="status-line">
                    <strong>{formatIssuedDocumentLabel(document)}</strong>
                    <span>{document.template ? formatKindLabel(document.template.kind) : "Документ"}</span>
                  </div>
                  <p className="route-card-note">
                    {formatDate(document.createdAt)} · {formatActorDisplayName(document.createdBy?.fullName)}
                  </p>
                </div>
                <div className="documents-issued-actions">
                  <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "inline")} target="_blank" rel="noreferrer">
                    Открыть
                  </a>
                  <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "attachment")}>
                    Скачать
                  </a>
                  <button className="ghost-button" type="button" onClick={() => printDocumentHref(document.downloadHref)}>
                    Печать
                  </button>
                </div>
              </div>
            ))}
          </div>
        </article>
      ) : null}

      <section className="documents-deal-flow-grid">
        {stages.map((stage) => {
          const stageTemplates = templates.filter((template) => template.kind === stage.kind);
          const stageDocuments = issuedDocuments.filter((document) => document.template?.kind === stage.kind);

          return (
            <DocumentStageCard
              key={`${props.sourceEntityType}-${stage.kind}`}
              sourceEntityId={props.sourceEntityId}
              stage={stage}
              templates={stageTemplates}
              issuedDocuments={stageDocuments}
              onIssued={handleDocumentsUpdated}
            />
          );
        })}
      </section>

      <article className="surface-card documents-issued-card">
        <div className="surface-kicker">Выпущенные документы</div>
        <h3>Реестр документов по сделке</h3>
        {issuedDocuments.length > 0 ? (
          <div className="documents-issued-list">
            {issuedDocuments.map((document) => (
              <div className="documents-issued-row" key={document.id}>
                <div>
                  <div className="status-line">
                    <strong>{formatIssuedDocumentLabel(document)}</strong>
                    <span>{document.template ? formatKindLabel(document.template.kind) : "Документ"}</span>
                  </div>
                  <p className="route-card-note">
                    {document.documentNumber ?? "без номера"} · {document.client?.fullName ?? "без клиента"} · {document.sourceLabel}
                  </p>
                  <p className="route-card-note">
                    {formatDate(document.createdAt)} · создал {formatActorDisplayName(document.createdBy?.fullName)}
                  </p>
                </div>
                <div className="documents-issued-actions">
                  <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "inline")} target="_blank" rel="noreferrer">
                    Открыть
                  </a>
                  <a className="ghost-button" href={buildDocumentActionHref(document.downloadHref, "attachment")}>
                    Скачать
                  </a>
                  <button className="ghost-button" type="button" onClick={() => printDocumentHref(document.downloadHref)}>
                    Печать
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <ul className="surface-list">
            <li>По этой сделке еще нет выпущенных документов.</li>
            <li>После выпуска тут появятся номер, клиент, сделка и автор документа.</li>
          </ul>
        )}
      </article>
    </div>
  );
}
