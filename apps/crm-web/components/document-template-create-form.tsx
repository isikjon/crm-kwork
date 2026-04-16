"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

async function readFileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

type TemplateSummary = {
  id: string;
  kind: string;
  name: string;
  templateCode: string | null;
  sourceEntityType: string | null;
  numberPrefix: string | null;
  nextDocumentNumber: string;
  isActive: boolean;
  manifest: {
    foundCodes: number;
    sourceKnownCodes: number;
    unknownCodes: number;
    contextMismatchCodes: number;
    warnings: string[];
  } | null;
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
    manifest: {
      warnings: string[];
      rows: Array<{
        code: string;
        known: boolean;
        allowedForSource: boolean;
        label: string;
        description: string;
        entity: string | null;
        sourcePath: string | null;
        exampleValue: string | null;
      }>;
    };
    rows: Array<{
      code: string;
      label: string;
      entity: string | null;
      sourcePath: string | null;
      exampleValue: string | null;
      status: "FILLED" | "EMPTY" | "MISSING" | "UNKNOWN";
      origin: "CRM" | "LEGACY" | "NONE";
      value: string;
      issueText: string | null;
    }>;
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

function formatStatusLabel(value: string) {
  switch (value) {
    case "FILLED":
      return "filled";
    case "EMPTY":
      return "empty";
    case "MISSING":
      return "missing";
    case "UNKNOWN":
      return "unknown";
    default:
      return value.toLowerCase();
  }
}

function formatOriginLabel(value: string) {
  switch (value) {
    case "CRM":
      return "crm";
    case "LEGACY":
      return "legacy";
    default:
      return "none";
  }
}

export function DocumentTemplateCreateForm(props: {
  templates: TemplateSummary[];
}) {
  const router = useRouter();
  const canManageTemplates = useHasPermission("documents.manage_templates");
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [sourceEntityType, setSourceEntityType] = useState<"RENTAL" | "BUYOUT">("RENTAL");
  const [kind, setKind] = useState<"CONTRACT" | "ISSUE_ACT" | "RETURN_ACT" | "BUYOUT_CONTRACT" | "ADDENDUM">("CONTRACT");
  const [templateCode, setTemplateCode] = useState("");
  const [numberPrefix, setNumberPrefix] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedTemplateId, setSelectedTemplateId] = useState(props.templates[0]?.id ?? "");
  const selectedTemplate = props.templates.find((template) => template.id === selectedTemplateId) ?? null;
  const [editorName, setEditorName] = useState(selectedTemplate?.name ?? "");
  const [editorTemplateCode, setEditorTemplateCode] = useState(selectedTemplate?.templateCode ?? "");
  const [editorNumberPrefix, setEditorNumberPrefix] = useState(selectedTemplate?.numberPrefix ?? "");
  const [editorIsActive, setEditorIsActive] = useState(selectedTemplate?.isActive ?? true);
  const [sourceEntityId, setSourceEntityId] = useState("");
  const [previewData, setPreviewData] = useState<TemplatePreviewData | null>(null);
  const [previewStatus, setPreviewStatus] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTemplate && props.templates[0]) {
      setSelectedTemplateId(props.templates[0].id);
      return;
    }

    if (!selectedTemplate) {
      return;
    }

    setEditorName(selectedTemplate.name);
    setEditorTemplateCode(selectedTemplate.templateCode ?? "");
    setEditorNumberPrefix(selectedTemplate.numberPrefix ?? "");
    setEditorIsActive(selectedTemplate.isActive);
    setPreviewData(null);
    setPreviewStatus(null);
    setPreviewError(null);
  }, [selectedTemplateId, selectedTemplate, props.templates]);

  function handleSourceChange(next: "RENTAL" | "BUYOUT") {
    setSourceEntityType(next);
    setKind(next === "RENTAL" ? "CONTRACT" : "BUYOUT_CONTRACT");
  }

  function submit() {
    setError(null);
    setStatus(null);

    if (!name.trim()) {
      setError("Введите название шаблона.");
      return;
    }

    if (!file) {
      setError("Загрузите файл шаблона.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const fileBase64 = await readFileAsDataUrl(file);
        const response = await fetch(`${getApiBase()}/documents/templates`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            name: name.trim(),
            kind,
            sourceEntityType,
            templateCode: templateCode.trim() || undefined,
            numberPrefix: numberPrefix.trim() || undefined,
            fileName: file.name,
            fileBase64
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Шаблон ${payload?.template?.name ?? ""} добавлен.`);
        setName("");
        setTemplateCode("");
        setNumberPrefix("");
        setFile(null);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить шаблон.");
      }
    });
  }

  function saveTemplateMeta() {
    if (!selectedTemplate) {
      setPreviewError("Сначала выберите шаблон.");
      return;
    }

    setPreviewError(null);
    setPreviewStatus(null);
    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/documents/templates/${selectedTemplate.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            name: editorName.trim(),
            templateCode: editorTemplateCode.trim() || null,
            numberPrefix: editorNumberPrefix.trim() || null,
            isActive: editorIsActive
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setPreviewStatus(`Метаданные шаблона ${payload?.template?.name ?? ""} обновлены.`);
        router.refresh();
      } catch (requestError) {
        setPreviewError(requestError instanceof Error ? requestError.message : "Не удалось обновить шаблон.");
      }
    });
  }

  function loadPreview() {
    if (!selectedTemplate) {
      setPreviewError("Сначала выберите шаблон.");
      setPreviewStatus(null);
      return;
    }

    if (!sourceEntityId.trim()) {
      setPreviewError("Укажите ID сделки или клиента для preview.");
      setPreviewStatus(null);
      return;
    }

    setPreviewError(null);
    setPreviewStatus(null);
    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const query = new URLSearchParams({
          tenantSlug,
          sourceEntityId: sourceEntityId.trim()
        });
        const response = await fetch(`${getApiBase()}/documents/templates/${selectedTemplate.id}/preview?${query.toString()}`, {
          method: "GET",
          credentials: "include"
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setPreviewData(payload);
        setPreviewStatus("Manifest и preview значений обновлены.");
      } catch (requestError) {
        setPreviewData(null);
        setPreviewError(requestError instanceof Error ? requestError.message : "Не удалось собрать preview.");
      }
    });
  }

  return (
    <div className="section-stack">
      <article className="surface-card">
        <div className="surface-kicker">Новый шаблон</div>
        <h3>Загрузить документ</h3>
        <div className="action-field-grid">
          <label className="action-field">
            <span>Для чего</span>
            <select
              className="action-input"
              value={sourceEntityType}
              onChange={(event) => handleSourceChange(event.target.value as "RENTAL" | "BUYOUT")}
            >
              <option value="RENTAL">Аренда</option>
              <option value="BUYOUT">Выкуп</option>
            </select>
          </label>

          <label className="action-field">
            <span>Тип документа</span>
            <select className="action-input" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              {sourceEntityType === "RENTAL" ? (
                <>
                  <option value="CONTRACT">Договор</option>
                  <option value="ISSUE_ACT">Акт выдачи</option>
                  <option value="RETURN_ACT">Акт возврата</option>
                  <option value="ADDENDUM">Допсоглашение</option>
                </>
              ) : (
                <>
                  <option value="BUYOUT_CONTRACT">Договор выкупа</option>
                  <option value="ADDENDUM">Допсоглашение</option>
                </>
              )}
            </select>
          </label>

          <label className="action-field">
            <span>Название</span>
            <input className="action-input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="action-field">
            <span>Код шаблона</span>
            <input
              className="action-input"
              placeholder="RENT-CONTRACT"
              value={templateCode}
              onChange={(event) => setTemplateCode(event.target.value)}
            />
          </label>

          <label className="action-field">
            <span>Префикс номера</span>
            <input
              className="action-input"
              placeholder={sourceEntityType === "RENTAL" ? "DOG" : "VIK"}
              value={numberPrefix}
              onChange={(event) => setNumberPrefix(event.target.value)}
            />
          </label>

          <label className="action-field action-field-wide">
            <span>Файл</span>
            <input
              className="action-input"
              type="file"
              accept=".docx,.txt"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <div className="inline-actions">
          <button className="action-button" type="button" onClick={submit} disabled={!canManageTemplates || isPending}>
            {isPending ? "Сохраняю..." : "Загрузить шаблон"}
          </button>
        </div>

        {status ? <p className="action-status is-success">{status}</p> : null}
        {error ? <p className="action-status is-error">{error}</p> : null}
        {!canManageTemplates ? <p className="route-card-note">Недостаточно прав для изменения шаблонов документов.</p> : null}
      </article>

      <article className="surface-card">
        <div className="surface-kicker">Template review</div>
        <h3>Manifest и preview перед генерацией</h3>
        <p className="route-card-note">
          Здесь менеджер видит, какие коды реально используются в шаблоне, какие из них пустые, какие неизвестны CRM и что именно пришло из CRM или было добранo из legacy.
        </p>

        {props.templates.length > 0 ? (
          <>
            <div className="action-field-grid">
              <label className="action-field">
                <span>Шаблон</span>
                <select className="action-input" value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
                  {props.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} · {template.nextDocumentNumber}
                    </option>
                  ))}
                </select>
              </label>

              <label className="action-field">
                <span>Название</span>
                <input className="action-input" value={editorName} onChange={(event) => setEditorName(event.target.value)} />
              </label>

              <label className="action-field">
                <span>Код шаблона</span>
                <input className="action-input" value={editorTemplateCode} onChange={(event) => setEditorTemplateCode(event.target.value)} />
              </label>

              <label className="action-field">
                <span>Префикс номера</span>
                <input className="action-input" value={editorNumberPrefix} onChange={(event) => setEditorNumberPrefix(event.target.value)} />
              </label>

              <label className="action-field">
                <span>Статус</span>
                <select className="action-input" value={editorIsActive ? "ACTIVE" : "DISABLED"} onChange={(event) => setEditorIsActive(event.target.value === "ACTIVE")}>
                  <option value="ACTIVE">Активен</option>
                  <option value="DISABLED">Выключен</option>
                </select>
              </label>

              <label className="action-field action-field-wide">
                <span>Source entity ID для preview</span>
                <input
                  className="action-input"
                  placeholder={selectedTemplate?.sourceEntityType === "CLIENT" ? "ID клиента" : "ID сделки"}
                  value={sourceEntityId}
                  onChange={(event) => setSourceEntityId(event.target.value)}
                />
              </label>
            </div>

            <div className="inline-actions">
              <button className="action-button is-secondary" type="button" onClick={saveTemplateMeta} disabled={!canManageTemplates || isPending || !selectedTemplate}>
                Сохранить метаданные
              </button>
              <button className="action-button" type="button" onClick={loadPreview} disabled={isPending || !selectedTemplate}>
                {isPending ? "Проверяю..." : "Проверить manifest и данные"}
              </button>
            </div>

            {selectedTemplate ? (
              <div className="documents-template-health">
                <span className="tag-chip">{selectedTemplate.sourceEntityType ?? "без source"}</span>
                <span className="tag-chip">{selectedTemplate.kind}</span>
                <span className={`tag-chip${selectedTemplate.isActive ? "" : " is-warning"}`}>
                  {selectedTemplate.isActive ? "ACTIVE" : "DISABLED"}
                </span>
                {selectedTemplate.manifest ? (
                  <>
                    <span className="tag-chip">codes {selectedTemplate.manifest.foundCodes}</span>
                    <span className={`tag-chip${selectedTemplate.manifest.unknownCodes > 0 ? " is-warning" : ""}`}>
                      unknown {selectedTemplate.manifest.unknownCodes}
                    </span>
                    <span className={`tag-chip${selectedTemplate.manifest.contextMismatchCodes > 0 ? " is-warning" : ""}`}>
                      mismatch {selectedTemplate.manifest.contextMismatchCodes}
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="route-card-note">Сначала загрузите хотя бы один шаблон, чтобы проверить manifest и preview.</p>
        )}

        {previewStatus ? <p className="action-status is-success">{previewStatus}</p> : null}
        {previewError ? <p className="action-status is-error">{previewError}</p> : null}

        {previewData ? (
          <div className="section-stack">
            <section className="documents-preview-summary">
              <div className="status-line">
                <strong>{previewData.template.name}</strong>
                <span>{previewData.preview.sourceLabel}</span>
              </div>
              <div className="tag-cloud">
                <span className="tag-chip">filled {previewData.preview.summary.filledRows}</span>
                <span className={`tag-chip${previewData.preview.summary.emptyRows > 0 ? " is-warning" : ""}`}>empty {previewData.preview.summary.emptyRows}</span>
                <span className={`tag-chip${previewData.preview.summary.missingRows > 0 ? " is-warning" : ""}`}>missing {previewData.preview.summary.missingRows}</span>
                <span className={`tag-chip${previewData.preview.summary.unknownRows > 0 ? " is-warning" : ""}`}>unknown {previewData.preview.summary.unknownRows}</span>
                <span className={`tag-chip${previewData.preview.summary.legacyRows > 0 ? " is-neutral" : ""}`}>legacy {previewData.preview.summary.legacyRows}</span>
              </div>
              <p className="route-card-note">
                Hydration: {previewData.preview.hydration.status} · {previewData.preview.hydration.message}
              </p>
              {previewData.preview.hydration.legacyFilledCodes.length > 0 ? (
                <p className="route-card-note">
                  Добрано из legacy: {previewData.preview.hydration.legacyFilledCodes.join(", ")}
                </p>
              ) : null}
            </section>

            {previewData.preview.warnings.length > 0 ? (
              <section className="documents-warning-panel">
                <div className="surface-kicker">Warnings</div>
                <ul className="surface-list compact-list">
                  {previewData.preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="documents-preview-grid">
              {previewData.preview.rows.map((row) => (
                <article className="documents-preview-row" key={row.code}>
                  <div className="status-line">
                    <strong>{row.code}</strong>
                    <span className={`tag-chip${row.status === "FILLED" ? "" : row.status === "UNKNOWN" ? " is-danger" : " is-warning"}`}>
                      {formatStatusLabel(row.status)}
                    </span>
                  </div>
                  <p className="route-card-note">{row.label} · {row.entity ?? "unknown entity"}</p>
                  <p className="route-card-note">Источник: {row.sourcePath ?? "неизвестно"} · origin: {formatOriginLabel(row.origin)}</p>
                  <p className="route-card-note">Пример: {row.exampleValue ?? "—"}</p>
                  <p className="documents-preview-value">{row.value || "—"}</p>
                  {row.issueText ? <p className="route-card-note">{row.issueText}</p> : null}
                </article>
              ))}
            </section>
          </div>
        ) : null}
      </article>
    </div>
  );
}
