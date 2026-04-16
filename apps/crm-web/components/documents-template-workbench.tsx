"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { DocumentsWorkspaceData } from "../lib/documents-api";

function formatTemplateKindLabel(kind: string, sourceEntityType?: string | null) {
  switch (kind) {
    case "CONTRACT":
      return sourceEntityType === "RENTAL" ? "Договор аренды" : "Договор";
    case "BUYOUT_CONTRACT":
      return "Договор выкупа";
    case "ISSUE_ACT":
      return "Акт выдачи";
    case "RETURN_ACT":
      return "Акт возврата";
    case "ADDENDUM":
      return sourceEntityType === "BUYOUT" ? "Допсоглашение к выкупу" : "Допсоглашение";
    default:
      return "Договор";
  }
}

function formatTemplateDisplayName(input: {
  name: string | null | undefined;
  kind?: string | null;
  sourceEntityType?: string | null;
}) {
  const trimmed = input.name?.trim() ?? "";
  if (!trimmed) {
    return formatTemplateKindLabel(input.kind ?? "", input.sourceEntityType);
  }

  if (!/[A-Za-z]/.test(trimmed)) {
    return trimmed;
  }

  if (/review|contract|buyout|rental|issue act|return act|template/i.test(trimmed) || /^[A-Za-z0-9 _-]+$/.test(trimmed)) {
    return formatTemplateKindLabel(input.kind ?? "", input.sourceEntityType);
  }

  return trimmed;
}

function formatFieldStatusLabel(value: string) {
  switch (value) {
    case "FILLED":
      return "Подставлено";
    case "EMPTY":
      return "Пусто";
    case "MISSING":
      return "Нет данных";
    case "UNKNOWN":
      return "Код не поддерживается";
    default:
      return value;
  }
}

function formatHydrationMessage(status: string) {
  switch (status) {
    case "UPDATED":
      return "Часть значений CRM подтянулась автоматически.";
    case "ALREADY_HYDRATED":
      return "Данных заказа достаточно для проверки договора.";
    case "SKIPPED_NO_REFERENCE":
      return "Предпросмотр собран по текущим данным заказа.";
    case "SKIPPED_NO_CONNECTION":
      return "Архив сейчас недоступен. Проверьте договор по текущим данным.";
    case "FAILED":
      return "Часть данных не удалось собрать автоматически. Проверьте договор.";
    default:
      return "Проверьте договор перед использованием.";
  }
}

function formatPreviewWarning(warning: string) {
  const normalized = warning.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const emptyMatch = normalized.match(/пустые значения:\s*(\d+)/i);
  if (emptyMatch) {
    return `Есть пустые поля: ${emptyMatch[1]}.`;
  }

  const missingMatch = normalized.match(/не относящиеся к текущему deal context:\s*(\d+)/i);
  if (missingMatch) {
    return `В шаблоне есть поля вне текущего заказа: ${missingMatch[1]}.`;
  }

  const unknownMatch = normalized.match(/неизвестные CRM placeholders:\s*(\d+)/i);
  if (unknownMatch) {
    return `В шаблоне есть неподдерживаемые коды: ${unknownMatch[1]}.`;
  }

  if (/legacy/i.test(normalized) || /DOCX может содержать/i.test(normalized)) {
    return null;
  }

  return normalized;
}

type TemplateRow = DocumentsWorkspaceData["templates"]["rows"][number];

export type TemplatePreviewRow = {
  code: string;
  label: string;
  entity: string | null;
  sourcePath: string | null;
  exampleValue: string | null;
  status: "FILLED" | "EMPTY" | "MISSING" | "UNKNOWN";
  origin: "CRM" | "LEGACY" | "NONE";
  value: string;
  issueText: string | null;
};

export type TemplatePreviewData = {
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
    renderedText: string | null;
    rows: TemplatePreviewRow[];
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

export type OrderSearchRow = {
  id: string;
  kind: "RENTAL" | "BUYOUT";
  dealNumber: string;
  detailHref: string;
  client: {
    fullName: string;
  };
  bikeUnit: {
    title: string;
  };
};

export function DocumentsTemplateWorkbench(props: {
  template: TemplateRow | null;
  sourceQuery: string;
  onSourceQueryChange: (value: string) => void;
  sourceResults: OrderSearchRow[];
  searchPending: boolean;
  selectedSource: OrderSearchRow | null;
  onChooseSource: (row: OrderSearchRow) => void;
  previewData: TemplatePreviewData | null;
  previewStatus: string | null;
  previewError: string | null;
  onPreviewTemplate: () => void;
  isBusy: boolean;
  previewRevealKey: number;
}) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const previewWarnings = props.previewData?.preview.warnings
    .map(formatPreviewWarning)
    .filter((warning): warning is string => Boolean(warning))
    .slice(0, 4) ?? [];

  const shownRows = props.previewData?.preview.rows.slice(0, 8) ?? [];
  const hiddenRowsCount = Math.max((props.previewData?.preview.rows.length ?? 0) - shownRows.length, 0);
  const currentDocumentNumber =
    props.previewData?.template.nextDocumentNumber ?? props.template?.nextDocumentNumber ?? "—";

  useEffect(() => {
    if (props.previewRevealKey <= 0) {
      return;
    }

    const previewRoot = document.getElementById("documents-contract-preview");
    previewRoot?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

    if (!props.selectedSource) {
      window.setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 120);
    }
  }, [props.previewRevealKey, props.selectedSource]);

  return (
    <section className="documents-contract-preview-zone" id="documents-contract-preview">
      <div className="documents-contract-preview-service">
        <label className="action-field documents-contract-preview-search">
          <span className="documents-contract-preview-search-label">Проверить на заказе</span>
          <input
            ref={searchInputRef}
            className="action-input"
            placeholder="Номер заказа, клиент или велосипед"
            value={props.sourceQuery}
            onChange={(event) => props.onSourceQueryChange(event.target.value)}
          />
          {props.searchPending ? <span className="route-card-note">Ищу заказ...</span> : null}
          {props.sourceResults.length > 0 ? (
            <div className="documents-source-search-results">
              {props.sourceResults.map((row) => (
                <button
                  className="documents-source-search-row"
                  key={row.id}
                  type="button"
                  onClick={() => props.onChooseSource(row)}
                >
                  <strong>{row.dealNumber}</strong>
                  <span>{row.client.fullName}</span>
                  <span>{row.bikeUnit.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </label>

        <button
          className="action-button is-secondary"
          type="button"
          onClick={props.onPreviewTemplate}
          disabled={!props.template || props.isBusy}
        >
          {props.isBusy ? "Собираю..." : "Предпросмотр"}
        </button>

        {props.selectedSource ? (
          <Link className="ghost-button" href={props.selectedSource.detailHref}>
            Открыть заказ
          </Link>
        ) : null}
      </div>

      {props.previewError ? <p className="documents-contract-preview-note is-error">{props.previewError}</p> : null}

      {props.previewData ? (
        <div className="documents-contract-preview-result">
          <div className="documents-contract-preview-quickline">
            <span>{props.selectedSource?.dealNumber ?? "Заказ не выбран"}</span>
            <span>{currentDocumentNumber}</span>
          </div>

          {props.previewData.preview.renderedText ? (
            <article className="documents-contract-sheet">
              <pre className="documents-contract-sheet-body">{props.previewData.preview.renderedText}</pre>
            </article>
          ) : (
            <p className="route-card-note documents-contract-docx-note">
              Для DOCX доступна короткая проверка на заказе.
            </p>
          )}

          <details className="documents-contract-diagnostics">
            <summary>Проверка данных</summary>
            <div className="documents-contract-diagnostics-body">
              <p className="route-card-note">{formatHydrationMessage(props.previewData.preview.hydration.status)}</p>

              {previewWarnings.length > 0 ? (
                <ul className="surface-list compact-list">
                  {previewWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}

              <div className="documents-contract-diagnostics-table">
                {shownRows.map((row) => (
                  <div className="documents-contract-diagnostics-row" key={row.code}>
                    <div>
                      <strong>{row.label}</strong>
                      <span>{row.code}</span>
                    </div>
                    <span>{formatFieldStatusLabel(row.status)}</span>
                    <p>{row.value || "Пустое значение"}</p>
                  </div>
                ))}
              </div>

              {hiddenRowsCount > 0 ? (
                <p className="route-card-note">Еще полей в проверке: {hiddenRowsCount}.</p>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
