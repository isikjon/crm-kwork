"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { DocumentRegistryRow, DocumentsWorkspaceData } from "../lib/documents-api";
import {
  DocumentsTemplateWorkbench,
  type OrderSearchRow,
  type TemplatePreviewData
} from "./documents-template-workbench";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
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

function formatSourceTypeLabel(value: string | null | undefined) {
  switch (value) {
    case "RENTAL":
      return "Аренда";
    case "BUYOUT":
      return "Выкуп";
    case "CLIENT":
      return "Клиент";
    default:
      return value ?? "Не указано";
  }
}

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

function formatRegistryPurposeLabel(document: DocumentRegistryRow) {
  if (document.sourceEntityType === "RENTAL") {
    return "Аренда";
  }

  if (document.sourceEntityType === "BUYOUT") {
    return "Выкуп";
  }

  return "Документ";
}

function formatRegistryTemplateLabel(document: DocumentRegistryRow) {
  return formatTemplateDisplayName({
    name: document.template?.name ?? null,
    kind: document.template?.kind ?? null,
    sourceEntityType: document.sourceEntityType
  });
}

function buildDocumentActionHref(publicApiBase: string, downloadHref: string, disposition: "attachment" | "inline") {
  const separator = downloadHref.includes("?") ? "&" : "?";
  return `${publicApiBase}${downloadHref}${separator}disposition=${disposition}`;
}

function buildTemplateFileHref(params: {
  publicApiBase: string;
  tenantSlug: string;
  templateId: string;
  disposition?: "attachment" | "inline";
}) {
  const query = new URLSearchParams({
    tenantSlug: params.tenantSlug,
    disposition: params.disposition ?? "inline"
  });

  return `${params.publicApiBase}/api/v1/documents/templates/${params.templateId}/file?${query.toString()}`;
}

function printDocumentHref(publicApiBase: string, downloadHref: string) {
  const inlineHref = buildDocumentActionHref(publicApiBase, downloadHref, "inline");
  const printWindow = window.open(inlineHref, "_blank");
  if (!printWindow) {
    window.location.href = inlineHref;
    return;
  }

  window.setTimeout(() => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // Printable tab still opens.
    }
  }, 900);
}

async function readFileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

function scrollToAnchor(id: string) {
  const target = document.getElementById(id);
  if (!target) {
    return;
  }

  target.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function getFileNameFromPath(filePath: string) {
  return filePath.split("/").pop() ?? filePath;
}

function isTextTemplate(templatePath: string) {
  return templatePath.toLowerCase().endsWith(".txt");
}

function buildPlainTextDataUrl(content: string) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return `data:text/plain;base64,${window.btoa(binary)}`;
}

type TemplateRow = DocumentsWorkspaceData["templates"]["rows"][number];
type PlaceholderRow = DocumentsWorkspaceData["placeholders"]["rows"][number]["placeholders"][number];
type TemplateSourceType = "RENTAL" | "BUYOUT";
type TemplateCreateMode = "UPLOAD" | "BLANK";

type OrdersSearchResponse = {
  rows: OrderSearchRow[];
};

type TemplateContentResponse = {
  content: string;
};

type CodeGroupDefinition = {
  key: string;
  title: string;
  match: (placeholder: PlaceholderRow) => boolean;
};

const CONTRACT_TEMPLATE_KINDS = new Set(["CONTRACT", "BUYOUT_CONTRACT"]);

const CODE_GROUPS: CodeGroupDefinition[] = [
  {
    key: "document",
    title: "Документ",
    match: (placeholder) => placeholder.entity === "document"
  },
  {
    key: "client",
    title: "Клиент",
    match: (placeholder) => placeholder.entity === "client"
  },
  {
    key: "deal",
    title: "Заказ",
    match: (placeholder) => placeholder.entity === "deal" && !/payment|deposit|penalt/i.test(placeholder.code)
  },
  {
    key: "payment",
    title: "Платежи",
    match: (placeholder) => placeholder.entity === "payment" || /payment/i.test(placeholder.code)
  },
  {
    key: "penalty",
    title: "Штрафы",
    match: (placeholder) => placeholder.entity === "penalty" || /penalt/i.test(placeholder.code)
  },
  {
    key: "deposit",
    title: "Залог",
    match: (placeholder) => placeholder.entity === "deposit" || /deposit/i.test(placeholder.code)
  },
  {
    key: "bike",
    title: "Велосипед",
    match: (placeholder) => placeholder.entity === "bike"
  },
  {
    key: "bank",
    title: "Банк",
    match: (placeholder) => placeholder.entity === "bank"
  },
  {
    key: "company",
    title: "Компания / точка",
    match: (placeholder) => placeholder.entity === "company" || placeholder.entity === "branch"
  },
  {
    key: "equipment",
    title: "Комплект",
    match: (placeholder) => placeholder.entity === "equipment"
  }
];

function getHumanSourceLabel(placeholder: PlaceholderRow) {
  if (placeholder.entity === "document") {
    return "из самого документа";
  }

  if (placeholder.entity === "company" || placeholder.entity === "branch") {
    return "из настроек CRM";
  }

  if (/client/i.test(placeholder.sourcePath)) {
    return "из карточки клиента";
  }

  if (/bike/i.test(placeholder.sourcePath)) {
    return "из карточки велосипеда";
  }

  if (/bank/i.test(placeholder.sourcePath)) {
    return "из выбранного банка";
  }

  if (/deposit/i.test(placeholder.sourcePath)) {
    return "из состояния залога";
  }

  if (/penalt/i.test(placeholder.sourcePath)) {
    return "из штрафов по сделке";
  }

  if (/payment|nextPayment/i.test(placeholder.sourcePath)) {
    return "из графика сделки";
  }

  if (/tenant|company|branch/i.test(placeholder.sourcePath)) {
    return "из настроек CRM";
  }

  return "из заказа";
}

function getContractKind(sourceEntityType: TemplateSourceType) {
  return sourceEntityType === "RENTAL" ? "CONTRACT" : "BUYOUT_CONTRACT";
}

export function DocumentsWorkspaceClient(props: {
  workspace: DocumentsWorkspaceData;
  publicApiBase: string;
}) {
  const router = useRouter();
  const canManageTemplates = useHasPermission("documents.manage_templates");

  const contractTemplates = useMemo(
    () => props.workspace.templates.rows.filter((template) => CONTRACT_TEMPLATE_KINDS.has(template.kind)),
    [props.workspace.templates.rows]
  );

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(contractTemplates[0]?.id ?? null);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [templateSearch, setTemplateSearch] = useState("");
  const [codeSearch, setCodeSearch] = useState("");
  const [registryNumberSearch, setRegistryNumberSearch] = useState("");
  const [registryClientSearch, setRegistryClientSearch] = useState("");
  const [registryOrderSearch, setRegistryOrderSearch] = useState("");

  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [createMode, setCreateMode] = useState<TemplateCreateMode>("UPLOAD");
  const [uploadSourceType, setUploadSourceType] = useState<TemplateSourceType>("RENTAL");
  const [uploadName, setUploadName] = useState("");
  const [uploadNumberPrefix, setUploadNumberPrefix] = useState("");
  const [uploadNextNumber, setUploadNextNumber] = useState("1");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [draftTemplateText, setDraftTemplateText] = useState("");

  const [editorName, setEditorName] = useState("");
  const [editorNumberPrefix, setEditorNumberPrefix] = useState("");
  const [editorNextNumber, setEditorNextNumber] = useState("1");
  const [templateText, setTemplateText] = useState("");
  const [templateTextLoading, setTemplateTextLoading] = useState(false);
  const [templateTextError, setTemplateTextError] = useState<string | null>(null);
  const [isTextEditorEnabled, setIsTextEditorEnabled] = useState(false);

  const [templateStatus, setTemplateStatus] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceResults, setSourceResults] = useState<OrderSearchRow[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [selectedSource, setSelectedSource] = useState<OrderSearchRow | null>(null);
  const [previewData, setPreviewData] = useState<TemplatePreviewData | null>(null);
  const [previewStatus, setPreviewStatus] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRevealKey, setPreviewRevealKey] = useState(0);
  const isBlankCreateOpen = isUploadOpen && createMode === "BLANK";

  const selectedTemplate = contractTemplates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedTemplateFileHref = selectedTemplate
    ? buildTemplateFileHref({
        publicApiBase: props.publicApiBase,
        tenantSlug: props.workspace.tenant.slug,
        templateId: selectedTemplate.id
      })
    : null;

  useEffect(() => {
    if (pendingTemplateId && contractTemplates.some((template) => template.id === pendingTemplateId)) {
      setSelectedTemplateId(pendingTemplateId);
      setPendingTemplateId(null);
      return;
    }

    if (selectedTemplateId && contractTemplates.some((template) => template.id === selectedTemplateId)) {
      return;
    }

    setSelectedTemplateId(contractTemplates[0]?.id ?? null);
  }, [contractTemplates, pendingTemplateId, selectedTemplateId]);

  useEffect(() => {
    if (!selectedTemplate) {
      setEditorName("");
      setEditorNumberPrefix("");
      setEditorNextNumber("1");
      setTemplateText("");
      setTemplateTextError(null);
      setIsTextEditorEnabled(false);
      return;
    }

    setEditorName(selectedTemplate.name);
    setEditorNumberPrefix(selectedTemplate.numberPrefix ?? "");
    setEditorNextNumber(String(selectedTemplate.nextNumber));
    setTemplateText("");
    setTemplateTextError(null);
    setIsTextEditorEnabled(false);

    if (!isTextTemplate(selectedTemplate.filePath)) {
      setTemplateTextLoading(false);
      return;
    }

    let cancelled = false;
    setTemplateTextLoading(true);

    void (async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const query = new URLSearchParams({ tenantSlug });
        const response = await fetch(`${getApiBase()}/documents/templates/${selectedTemplate.id}/content?${query.toString()}`, {
          credentials: "include"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        if (!cancelled) {
          setTemplateText((payload as TemplateContentResponse).content ?? "");
          setIsTextEditorEnabled(true);
        }
      } catch (requestError) {
        if (!cancelled) {
          setTemplateText("");
          setTemplateTextError(requestError instanceof Error ? requestError.message : "Не удалось загрузить текст шаблона.");
          setIsTextEditorEnabled(false);
        }
      } finally {
        if (!cancelled) {
          setTemplateTextLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedTemplate]);

  useEffect(() => {
    setSourceQuery("");
    setSourceResults([]);
    setSelectedSource(null);
    setPreviewData(null);
    setPreviewStatus(null);
    setPreviewError(null);
  }, [selectedTemplateId]);

  useEffect(() => {
    const currentTemplateSourceType = selectedTemplate?.sourceEntityType;

    if (currentTemplateSourceType !== "RENTAL" && currentTemplateSourceType !== "BUYOUT") {
      setSourceResults([]);
      setSearchPending(false);
      return;
    }

    const normalizedQuery = sourceQuery.trim();
    if (normalizedQuery.length < 2) {
      setSourceResults([]);
      setSearchPending(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setSearchPending(true);

      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const query = new URLSearchParams({
          tenantSlug,
          q: normalizedQuery,
          kind: currentTemplateSourceType,
          limit: "8"
        });
        const response = await fetch(`${getApiBase()}/orders?${query.toString()}`, {
          credentials: "include"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        if (!cancelled) {
          setSourceResults((payload as OrdersSearchResponse).rows ?? []);
        }
      } catch {
        if (!cancelled) {
          setSourceResults([]);
        }
      } finally {
        if (!cancelled) {
          setSearchPending(false);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [selectedTemplate?.sourceEntityType, sourceQuery]);

  const filteredTemplates = useMemo(() => {
    const normalizedSearch = templateSearch.trim().toLowerCase();
    return contractTemplates.filter((template) => {
      if (!normalizedSearch) {
        return true;
      }

      return [
        template.name,
        formatTemplateDisplayName(template),
        template.nextDocumentNumber,
        formatSourceTypeLabel(template.sourceEntityType),
        getFileNameFromPath(template.filePath)
      ].some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [contractTemplates, templateSearch]);

  const filteredRegistry = useMemo(() => {
    const numberSearch = registryNumberSearch.trim().toLowerCase();
    const clientSearch = registryClientSearch.trim().toLowerCase();
    const orderSearch = registryOrderSearch.trim().toLowerCase();

    return props.workspace.registry.rows.filter((document) => {
      if (!CONTRACT_TEMPLATE_KINDS.has(document.template?.kind ?? "")) {
        return false;
      }

      if (numberSearch && ![
        document.documentNumber ?? "",
        document.title
      ].some((value) => value.toLowerCase().includes(numberSearch))) {
        return false;
      }

      if (clientSearch && !(document.client?.fullName ?? "").toLowerCase().includes(clientSearch)) {
        return false;
      }

      if (orderSearch && ![
        document.order?.dealNumber ?? "",
        document.sourceLabel
      ].some((value) => value.toLowerCase().includes(orderSearch))) {
        return false;
      }

      return true;
    });
  }, [props.workspace.registry.rows, registryClientSearch, registryNumberSearch, registryOrderSearch]);

  const visibleRegistry = useMemo(() => filteredRegistry.slice(0, 60), [filteredRegistry]);

  const codeGroups = useMemo(() => {
    const currentScope = selectedTemplate?.sourceEntityType;
    const rows = props.workspace.placeholders.rows.filter((row) => {
      if (currentScope !== "RENTAL" && currentScope !== "BUYOUT") {
        return true;
      }

      return row.sourceEntityType === currentScope;
    });

    const normalizedSearch = codeSearch.trim().toLowerCase();
    const uniquePlaceholders = Array.from(
      new Map(rows.flatMap((row) => row.placeholders).map((placeholder) => [placeholder.code, placeholder])).values()
    );

    const searchedPlaceholders = uniquePlaceholders.filter((placeholder) => {
      if (!normalizedSearch) {
        return true;
      }

      return [
        placeholder.code,
        placeholder.label,
        placeholder.exampleValue,
        getHumanSourceLabel(placeholder)
      ].some((value) => value.toLowerCase().includes(normalizedSearch));
    });

    return CODE_GROUPS.map((group) => ({
      key: group.key,
      title: group.title,
      rows: searchedPlaceholders.filter(group.match)
    })).filter((group) => group.rows.length > 0);
  }, [codeSearch, props.workspace.placeholders.rows, selectedTemplate?.sourceEntityType]);

  function resetUploadForm() {
    setCreateMode("UPLOAD");
    setUploadSourceType("RENTAL");
    setUploadName("");
    setUploadNumberPrefix("");
    setUploadNextNumber("1");
    setUploadFile(null);
    setDraftTemplateText("");
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      window.setTimeout(() => {
        setCopiedCode((current) => (current === code ? null : current));
      }, 1200);
    } catch {
      setCopiedCode(null);
    }
  }

  function useTemplate(templateId: string) {
    setIsUploadOpen(false);
    setSelectedTemplateId(templateId);
    window.setTimeout(() => {
      scrollToAnchor("documents-contract-editor");
    }, 40);
  }

  async function submitTemplateCreate() {
    setTemplateError(null);
    setTemplateStatus(null);

    if (!uploadName.trim()) {
      setTemplateError("Введите название шаблона.");
      return;
    }

    if (createMode === "UPLOAD" && !uploadFile) {
      setTemplateError("Выберите файл шаблона.");
      return;
    }

    setBusyAction("upload");

    try {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const normalizedName = uploadName.trim();
      const generatedFileName = `${normalizedName.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "contract-template"}.txt`;
      const response = await fetch(`${getApiBase()}/documents/templates`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug,
          name: normalizedName,
          kind: getContractKind(uploadSourceType),
          sourceEntityType: uploadSourceType,
          numberPrefix: uploadNumberPrefix.trim() || undefined,
          nextNumber: Number(uploadNextNumber) || 1,
          fileName: createMode === "UPLOAD" ? uploadFile?.name : generatedFileName,
          fileBase64: createMode === "UPLOAD" && uploadFile
            ? await readFileAsDataUrl(uploadFile)
            : buildPlainTextDataUrl(draftTemplateText)
        })
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }

      const createdTemplateId = payload?.template?.id;
      setTemplateStatus(`Шаблон ${payload?.template?.name ?? normalizedName} добавлен.`);
      if (typeof createdTemplateId === "string" && createdTemplateId) {
        setPendingTemplateId(createdTemplateId);
      }
      setIsUploadOpen(false);
      resetUploadForm();
      router.refresh();
    } catch (requestError) {
      setTemplateError(requestError instanceof Error ? requestError.message : "Не удалось сохранить шаблон.");
    } finally {
      setBusyAction(null);
    }
  }

  async function saveTemplate() {
    if (!selectedTemplate) {
      setTemplateError("Сначала выберите шаблон.");
      return;
    }

    setTemplateError(null);
    setTemplateStatus(null);
    setBusyAction("save");

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
          numberPrefix: editorNumberPrefix.trim() || null,
          nextNumber: Math.max(1, Number(editorNextNumber) || 1)
        })
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }

      if (isTextEditorEnabled) {
        const contentResponse = await fetch(`${getApiBase()}/documents/templates/${selectedTemplate.id}/content`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            content: templateText
          })
        });
        const contentPayload = await contentResponse.json().catch(() => null);
        if (!contentResponse.ok) {
          throw new Error(contentPayload?.error?.message ?? `Request failed with ${contentResponse.status}`);
        }
      }

      setTemplateStatus("Шаблон сохранен.");
      router.refresh();
    } catch (requestError) {
      setTemplateError(requestError instanceof Error ? requestError.message : "Не удалось сохранить шаблон.");
    } finally {
      setBusyAction(null);
    }
  }

  async function replaceTemplateFile(template: TemplateRow, file: File) {
    setTemplateError(null);
    setTemplateStatus(null);
    setBusyAction("replace");

    try {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const response = await fetch(`${getApiBase()}/documents/templates/${template.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug,
          fileName: file.name,
          fileBase64: await readFileAsDataUrl(file)
        })
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }

      setTemplateStatus(`Файл шаблона ${payload?.template?.name ?? template.name} заменен.`);
      setSelectedTemplateId(template.id);
      router.refresh();
    } catch (requestError) {
      setTemplateError(requestError instanceof Error ? requestError.message : "Не удалось заменить файл шаблона.");
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteTemplate(template: TemplateRow) {
    if (template._count.generations > 0) {
      setTemplateError("Шаблон уже использовался. Его можно заменить, но не удалить.");
      setTemplateStatus(null);
      return;
    }

    if (!window.confirm(`Удалить шаблон «${template.name}»?`)) {
      return;
    }

    setTemplateError(null);
    setTemplateStatus(null);
    setBusyAction("delete");

    try {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const query = new URLSearchParams({ tenantSlug });
      const response = await fetch(`${getApiBase()}/documents/templates/${template.id}?${query.toString()}`, {
        method: "DELETE",
        credentials: "include"
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }

      setTemplateStatus(`Шаблон ${template.name} удален.`);
      if (selectedTemplateId === template.id) {
        const nextTemplate = contractTemplates.find((row) => row.id !== template.id);
        setSelectedTemplateId(nextTemplate?.id ?? null);
      }
      router.refresh();
    } catch (requestError) {
      setTemplateError(requestError instanceof Error ? requestError.message : "Не удалось удалить шаблон.");
    } finally {
      setBusyAction(null);
    }
  }

  async function loadPreview(explicitSource?: OrderSearchRow) {
    if (!selectedTemplate) {
      setPreviewError("Сначала выберите шаблон.");
      setPreviewStatus(null);
      return;
    }

    const nextSource = explicitSource ?? selectedSource;
    if (!nextSource) {
      setPreviewError("Выберите заказ для предпросмотра.");
      setPreviewStatus(null);
      return;
    }

    setPreviewError(null);
    setPreviewStatus(null);
    setBusyAction("preview");

    try {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const query = new URLSearchParams({
        tenantSlug,
        sourceEntityId: nextSource.id
      });
      const response = await fetch(`${getApiBase()}/documents/templates/${selectedTemplate.id}/preview?${query.toString()}`, {
        credentials: "include"
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }

      setPreviewData(payload as TemplatePreviewData);
      setPreviewStatus(null);
    } catch (requestError) {
      setPreviewData(null);
      setPreviewError(requestError instanceof Error ? requestError.message : "Не удалось собрать предпросмотр.");
    } finally {
      setBusyAction(null);
    }
  }

  async function chooseSource(row: OrderSearchRow) {
    setSelectedSource(row);
    setSourceQuery(`${row.dealNumber} · ${row.client.fullName}`);
    setSourceResults([]);
    setPreviewData(null);
    setPreviewStatus(null);
    setPreviewError(null);
    await loadPreview(row);
    setPreviewRevealKey((current) => current + 1);
  }

  function openUploadFlow() {
    setTemplateError(null);
    setTemplateStatus(null);
    resetUploadForm();
    setCreateMode("UPLOAD");
    setIsUploadOpen(true);
  }

  function openBlankFlow() {
    setTemplateError(null);
    setTemplateStatus(null);
    resetUploadForm();
    setCreateMode("BLANK");
    setIsUploadOpen(true);
    window.setTimeout(() => {
      scrollToAnchor("documents-contract-editor");
    }, 40);
  }

  function handlePreviewReveal() {
    scrollToAnchor("documents-contract-preview");
    setPreviewRevealKey((current) => current + 1);
    void loadPreview();
  }

  return (
    <div className="section-stack documents-contracts-page">
      <section className="documents-contracts-shell">
        <aside className="surface-card documents-contracts-sidebar">
          <div className="documents-contracts-sidebar-head">
            <div>
              <div className="surface-kicker">Шаблоны</div>
              <h3>Шаблоны</h3>
            </div>
          </div>

          <label className="action-field action-field-wide">
            <span>Поиск по шаблонам</span>
            <input
              className="action-input"
              placeholder="Название или номер"
              value={templateSearch}
              onChange={(event) => setTemplateSearch(event.target.value)}
            />
          </label>

          <div className="documents-contracts-sidebar-actions">
            <button
              className="action-button documents-contracts-sidebar-trigger"
              type="button"
              onClick={() => {
                if (isUploadOpen && createMode === "UPLOAD") {
                  setIsUploadOpen(false);
                  resetUploadForm();
                  return;
                }

                openUploadFlow();
              }}
              disabled={!canManageTemplates || busyAction !== null}
            >
              Загрузить шаблон
            </button>
            <button
              className="action-button is-secondary documents-contracts-sidebar-trigger"
              type="button"
              onClick={openBlankFlow}
              disabled={!canManageTemplates || busyAction !== null}
            >
              Создать с нуля
            </button>
          </div>

          {isUploadOpen && createMode === "UPLOAD" ? (
            <div className="documents-contract-upload-inline">
              <div className="documents-contract-create-head">
                <strong>Загрузить шаблон</strong>
                <span>Файл, название, аренда или выкуп, номер.</span>
              </div>
              <div className="documents-contract-upload-grid">
                <label className="action-field">
                  <span>Название</span>
                  <input className="action-input" value={uploadName} onChange={(event) => setUploadName(event.target.value)} />
                </label>

                <label className="action-field">
                  <span>Где использовать</span>
                  <select
                    className="action-input"
                    value={uploadSourceType}
                    onChange={(event) => setUploadSourceType(event.target.value as TemplateSourceType)}
                  >
                    <option value="RENTAL">Аренда</option>
                    <option value="BUYOUT">Выкуп</option>
                  </select>
                </label>

                <label className="action-field">
                  <span>Префикс</span>
                  <input className="action-input" value={uploadNumberPrefix} onChange={(event) => setUploadNumberPrefix(event.target.value)} />
                </label>

                <label className="action-field">
                  <span>Следующий номер</span>
                  <input
                    className="action-input"
                    min="1"
                    type="number"
                    value={uploadNextNumber}
                    onChange={(event) => setUploadNextNumber(event.target.value)}
                  />
                </label>

                <label className="action-field action-field-wide">
                  <span>Файл шаблона</span>
                  <input
                    className="action-input"
                    type="file"
                    accept=".docx,.txt"
                    onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              <div className="inline-actions">
                <button className="action-button" type="button" onClick={submitTemplateCreate} disabled={!canManageTemplates || busyAction !== null}>
                  {busyAction === "upload" ? "Сохраняю..." : "Сохранить"}
                </button>
                <button
                  className="action-button is-secondary"
                  type="button"
                  onClick={() => {
                    setIsUploadOpen(false);
                    resetUploadForm();
                  }}
                  disabled={busyAction !== null}
                >
                  Свернуть
                </button>
              </div>
            </div>
          ) : null}

          {templateStatus ? <p className="action-status is-success">{templateStatus}</p> : null}
          {templateError ? <p className="action-status is-error">{templateError}</p> : null}
          {!canManageTemplates ? <p className="route-card-note">Недостаточно прав для изменения шаблонов.</p> : null}

          {filteredTemplates.length > 0 ? (
            <div className="documents-contract-template-list">
              {filteredTemplates.map((template) => {
                const templateFileHref = buildTemplateFileHref({
                  publicApiBase: props.publicApiBase,
                  tenantSlug: props.workspace.tenant.slug,
                  templateId: template.id
                });

                return (
                    <div
                      className={`documents-contract-template-row${template.id === selectedTemplateId && !isBlankCreateOpen ? " is-selected" : ""}`}
                      key={template.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => useTemplate(template.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        useTemplate(template.id);
                      }
                    }}
                  >
                    <div className="documents-contract-template-main">
                      <strong>{formatTemplateDisplayName(template)}</strong>
                      <div className="documents-contract-template-meta">
                        <span className="documents-contract-template-usage">{formatSourceTypeLabel(template.sourceEntityType)}</span>
                        <span>Следующий: {template.nextDocumentNumber}</span>
                        <span>{formatDate(template.updatedAt)}</span>
                      </div>
                    </div>

                    <div className="documents-contract-template-row-actions">
                      <div className="documents-contract-template-links">
                        <a
                          className="documents-contract-template-link"
                          href={templateFileHref}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                        >
                          Открыть
                        </a>
                        {canManageTemplates ? (
                          <label className="documents-contract-template-link documents-template-file-action" onClick={(event) => event.stopPropagation()}>
                            Заменить
                            <input
                              hidden
                              type="file"
                              accept=".docx,.txt"
                              onChange={(event) => {
                                const nextFile = event.target.files?.[0] ?? null;
                                if (nextFile) {
                                  void replaceTemplateFile(template, nextFile);
                                }
                                event.currentTarget.value = "";
                              }}
                            />
                          </label>
                        ) : null}
                        {canManageTemplates ? (
                          <button
                            className="documents-contract-template-link"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteTemplate(template);
                            }}
                            disabled={template._count.generations > 0 || busyAction !== null}
                            title={template._count.generations > 0 ? "Шаблон уже использовался в документах" : undefined}
                          >
                            Удалить
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="route-card-note">Шаблоны договоров не найдены.</p>
          )}
        </aside>

        <div className="documents-contracts-main">
          <div className="documents-contracts-editor-grid">
            <section className="surface-card documents-contract-editor" id="documents-contract-editor">
              <div className="documents-contract-editor-head">
                <div>
                  <div className="surface-kicker">Редактор договора</div>
                  <h3>{isBlankCreateOpen ? "Новый шаблон договора" : (selectedTemplate ? formatTemplateDisplayName(selectedTemplate) : "Выберите шаблон слева")}</h3>
                </div>
                <div className="inline-actions">
                  <button
                    className="action-button is-secondary"
                    type="button"
                    onClick={isBlankCreateOpen ? submitTemplateCreate : saveTemplate}
                    disabled={!canManageTemplates || (!isBlankCreateOpen && !selectedTemplate) || busyAction !== null}
                  >
                    {busyAction === "save" || busyAction === "upload" ? "Сохраняю..." : "Сохранить"}
                  </button>
                  <button
                    className="action-button is-secondary"
                    type="button"
                    onClick={handlePreviewReveal}
                    disabled={isBlankCreateOpen || !selectedTemplate || busyAction !== null}
                  >
                    Предпросмотр
                  </button>
                </div>
              </div>

              {isBlankCreateOpen ? (
                <>
                  <div className="documents-contract-create-inline">
                    <div className="documents-contract-create-head">
                      <strong>Создать с нуля</strong>
                      <span>Новый текстовый шаблон договора без загрузки файла.</span>
                    </div>

                    <div className="documents-contract-editor-meta">
                      <label className="action-field">
                        <span>Название</span>
                        <input className="action-input" value={uploadName} onChange={(event) => setUploadName(event.target.value)} />
                      </label>

                      <label className="action-field">
                        <span>Где использовать</span>
                        <select
                          className="action-input"
                          value={uploadSourceType}
                          onChange={(event) => setUploadSourceType(event.target.value as TemplateSourceType)}
                        >
                          <option value="RENTAL">Аренда</option>
                          <option value="BUYOUT">Выкуп</option>
                        </select>
                      </label>

                      <label className="action-field">
                        <span>Префикс</span>
                        <input className="action-input" value={uploadNumberPrefix} onChange={(event) => setUploadNumberPrefix(event.target.value)} />
                      </label>

                      <label className="action-field">
                        <span>Следующий номер</span>
                        <input
                          className="action-input"
                          min="1"
                          type="number"
                          value={uploadNextNumber}
                          onChange={(event) => setUploadNextNumber(event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="documents-contract-editor-body">
                      <textarea
                        className="documents-contract-textarea"
                        value={draftTemplateText}
                        onChange={(event) => setDraftTemplateText(event.target.value)}
                        spellCheck={false}
                        placeholder="Введите текст договора и вставляйте коды CRM из правой панели."
                      />
                    </div>

                    <div className="inline-actions">
                      <button className="action-button" type="button" onClick={submitTemplateCreate} disabled={!canManageTemplates || busyAction !== null}>
                        {busyAction === "upload" ? "Сохраняю..." : "Сохранить"}
                      </button>
                      <button
                        className="action-button is-secondary"
                        type="button"
                        onClick={() => {
                          setIsUploadOpen(false);
                          resetUploadForm();
                        }}
                        disabled={busyAction !== null}
                      >
                        Отменить
                      </button>
                    </div>
                  </div>
                </>
              ) : selectedTemplate ? (
                <>
                  <div className="documents-contract-editor-meta">
                    <label className="action-field">
                      <span>Название</span>
                      <input
                        className="action-input"
                        value={editorName}
                        onChange={(event) => setEditorName(event.target.value)}
                        disabled={!canManageTemplates}
                      />
                    </label>

                    <div className="action-field">
                      <span>Где использовать</span>
                      <div className="documents-contract-readonly">{formatSourceTypeLabel(selectedTemplate.sourceEntityType)}</div>
                    </div>

                    <label className="action-field">
                      <span>Префикс</span>
                      <input
                        className="action-input"
                        value={editorNumberPrefix}
                        onChange={(event) => setEditorNumberPrefix(event.target.value)}
                        disabled={!canManageTemplates}
                      />
                    </label>

                    <label className="action-field">
                      <span>Следующий номер</span>
                      <input
                        className="action-input"
                        min="1"
                        type="number"
                        value={editorNextNumber}
                        onChange={(event) => setEditorNextNumber(event.target.value)}
                        disabled={!canManageTemplates}
                      />
                    </label>
                  </div>

                  <div className="documents-contract-file-bar">
                    <div>
                      <span>Файл шаблона</span>
                      <strong>{getFileNameFromPath(selectedTemplate.filePath)}</strong>
                    </div>
                    <div className="inline-actions">
                      {selectedTemplateFileHref ? (
                        <a className="ghost-button" href={selectedTemplateFileHref} target="_blank" rel="noreferrer">
                          Открыть файл
                        </a>
                      ) : null}
                      {canManageTemplates ? (
                        <label className="ghost-button documents-template-file-action">
                          Заменить файл
                          <input
                            hidden
                            type="file"
                            accept=".docx,.txt"
                            onChange={(event) => {
                              const nextFile = event.target.files?.[0] ?? null;
                              if (nextFile) {
                                void replaceTemplateFile(selectedTemplate, nextFile);
                              }
                              event.currentTarget.value = "";
                            }}
                          />
                        </label>
                      ) : null}
                    </div>
                  </div>

                  {isTextEditorEnabled ? (
                    <div className="documents-contract-editor-body">
                      <textarea
                        className="documents-contract-textarea"
                        value={templateText}
                        onChange={(event) => setTemplateText(event.target.value)}
                        spellCheck={false}
                        disabled={!canManageTemplates}
                      />
                    </div>
                  ) : templateTextLoading ? (
                    <p className="route-card-note">Загружаю текст шаблона...</p>
                  ) : null}

                  {templateTextError ? <p className="action-status is-error">{templateTextError}</p> : null}

                  <DocumentsTemplateWorkbench
                    isBusy={busyAction === "preview"}
                    onChooseSource={(row) => void chooseSource(row)}
                    onPreviewTemplate={handlePreviewReveal}
                    onSourceQueryChange={(value) => {
                      setSourceQuery(value);
                      setSelectedSource(null);
                      setPreviewData(null);
                      setPreviewStatus(null);
                      setPreviewError(null);
                    }}
                    previewData={previewData}
                    previewError={previewError}
                    previewStatus={previewStatus}
                    searchPending={searchPending}
                    selectedSource={selectedSource}
                    sourceQuery={sourceQuery}
                    sourceResults={sourceResults}
                    template={selectedTemplate}
                    previewRevealKey={previewRevealKey}
                  />
                </>
              ) : (
                <p className="route-card-note">Выберите шаблон договора слева, чтобы работать с ним.</p>
              )}
            </section>

            <aside className="surface-card documents-contract-codes">
              <div className="surface-kicker">Спецкоды CRM</div>
              <div className="documents-contract-codes-head">
                <h3>Коды</h3>
                <span>{selectedTemplate ? formatSourceTypeLabel(selectedTemplate.sourceEntityType) : "все сделки"}</span>
              </div>

              <label className="action-field action-field-wide">
                <span>Поиск по кодам</span>
                <input
                  className="action-input"
                  placeholder="Например, клиент или заказ"
                  value={codeSearch}
                  onChange={(event) => setCodeSearch(event.target.value)}
                />
              </label>

              <div className="documents-contract-codes-status">
                {copiedCode ? "Скопировано" : "Клик по строке копирует код."}
              </div>

              <div className="documents-contract-codes-groups">
                {codeGroups.map((group) => (
                  <section className="documents-contract-code-group" key={group.key}>
                    <div className="status-line">
                      <strong>{group.title}</strong>
                      <span>{group.rows.length}</span>
                    </div>
                    <div className="documents-contract-code-list">
                      {group.rows.map((placeholder) => (
                        <button
                          className={`documents-contract-code-row${copiedCode === placeholder.code ? " is-copied" : ""}`}
                          key={placeholder.code}
                          type="button"
                          onClick={() => void copyCode(placeholder.code)}
                        >
                          <div className="documents-contract-code-main">
                            <strong>{placeholder.code}</strong>
                            <span>{placeholder.label}</span>
                          </div>
                          <div className="documents-contract-code-meta">
                            <span>{getHumanSourceLabel(placeholder)}</span>
                            <span>Пример: {placeholder.exampleValue}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </aside>
          </div>

          <section className="surface-card documents-contract-registry">
            <div className="documents-contract-registry-head">
              <div>
                <div className="surface-kicker">Реестр документов</div>
                <h3>Архив договоров</h3>
              </div>
              <span>{filteredRegistry.length} шт.</span>
            </div>

            <div className="documents-contract-registry-toolbar">
              <label className="action-field">
                <span>Номер</span>
                <input
                  className="action-input"
                  placeholder="Например, ДГ-000123"
                  value={registryNumberSearch}
                  onChange={(event) => setRegistryNumberSearch(event.target.value)}
                />
              </label>

              <label className="action-field">
                <span>Клиент</span>
                <input
                  className="action-input"
                  placeholder="ФИО клиента"
                  value={registryClientSearch}
                  onChange={(event) => setRegistryClientSearch(event.target.value)}
                />
              </label>

              <label className="action-field">
                <span>Заказ</span>
                <input
                  className="action-input"
                  placeholder="Номер заказа"
                  value={registryOrderSearch}
                  onChange={(event) => setRegistryOrderSearch(event.target.value)}
                />
              </label>
            </div>

            {filteredRegistry.length > 0 ? (
              <>
                {filteredRegistry.length > visibleRegistry.length ? (
                  <p className="route-card-note">
                    Показаны первые {visibleRegistry.length} документов. Уточните поиск, чтобы быстро найти нужный договор.
                  </p>
                ) : null}
                <div className="documents-contract-registry-scroll">
                  <div className="documents-contract-registry-table-head">
                    <span>Номер</span>
                    <span>Шаблон</span>
                    <span>Клиент</span>
                    <span>Заказ</span>
                    <span>Дата</span>
                    <span>Действия</span>
                  </div>
                  <div className="documents-contract-registry-list">
                    {visibleRegistry.map((document) => (
                      <div
                        className="documents-contract-registry-row"
                        key={document.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => window.open(buildDocumentActionHref(props.publicApiBase, document.downloadHref, "inline"), "_blank")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            window.open(buildDocumentActionHref(props.publicApiBase, document.downloadHref, "inline"), "_blank");
                          }
                        }}
                      >
                        <div className="documents-contract-registry-cell is-number">
                          <strong>{document.documentNumber ?? formatRegistryTemplateLabel(document)}</strong>
                        </div>

                        <div className="documents-contract-registry-cell is-template">
                          <span>{formatRegistryTemplateLabel(document)}</span>
                        </div>

                        <div className="documents-contract-registry-cell">
                          <span>{document.client?.fullName ?? "Без клиента"}</span>
                        </div>

                        <div className="documents-contract-registry-cell">
                          <span>{document.order?.dealNumber ?? document.sourceLabel}</span>
                        </div>

                        <div className="documents-contract-registry-cell is-date">
                          <span>{formatDate(document.createdAt)}</span>
                        </div>

                        <div className="documents-contract-registry-actions">
                          <a
                            className="ghost-button documents-contract-table-action"
                            href={buildDocumentActionHref(props.publicApiBase, document.downloadHref, "inline")}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Открыть
                          </a>
                          <a
                            className="ghost-button documents-contract-table-action"
                            href={buildDocumentActionHref(props.publicApiBase, document.downloadHref, "attachment")}
                            onClick={(event) => event.stopPropagation()}
                          >
                            Скачать
                          </a>
                          <button
                            className="ghost-button documents-contract-table-action"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              printDocumentHref(props.publicApiBase, document.downloadHref);
                            }}
                          >
                            Печать
                          </button>
                          {document.order ? (
                            <Link className="ghost-button documents-contract-table-action" href={document.order.href} onClick={(event) => event.stopPropagation()}>
                              Перейти в заказ
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <p className="route-card-note">Документы по текущему поиску не найдены.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
