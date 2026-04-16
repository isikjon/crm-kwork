import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../../config/env.js";

const execFileAsync = promisify(execFile);
const PLACEHOLDER_PATTERN = /{{\s*[a-zA-Z0-9_.]+\s*}}/g;
const WORD_TEXT_NODE_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function sanitizeFileName(fileName: string) {
  const cleaned = fileName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "document-template";
}

export function isPlainTextTemplatePath(templatePath: string) {
  return path.extname(templatePath).toLowerCase() === ".txt";
}

export async function persistUploadedTemplateFile(params: {
  tenantSlug: string;
  fileName: string;
  fileBase64: string;
}) {
  const match = params.fileBase64.match(/^data:(.+?);base64,(.+)$/);
  const encoded = match?.[2] ?? params.fileBase64;
  const buffer = Buffer.from(encoded, "base64");

  const storageDir = path.join(env.FILE_STORAGE_ROOT, "templates", params.tenantSlug);
  await fs.mkdir(storageDir, { recursive: true });

  const safeFileName = sanitizeFileName(params.fileName);
  const filePath = path.join(storageDir, safeFileName);
  await fs.writeFile(filePath, buffer);

  return filePath;
}

function replacePlainTextContent(content: string, values: Record<string, string>) {
  let next = content;
  for (const [code, value] of Object.entries(values)) {
    next = next.split(code).join(value);
  }
  return next;
}

export async function readPlainTextTemplateContent(templatePath: string) {
  if (!isPlainTextTemplatePath(templatePath)) {
    throw new Error("Встроенное редактирование доступно только для TXT-шаблонов.");
  }

  return fs.readFile(templatePath, "utf8");
}

export async function writePlainTextTemplateContent(params: {
  templatePath: string;
  content: string;
}) {
  if (!isPlainTextTemplatePath(params.templatePath)) {
    throw new Error("Встроенное редактирование доступно только для TXT-шаблонов.");
  }

  await fs.writeFile(params.templatePath, params.content, "utf8");
}

export async function renderPlainTextTemplatePreview(params: {
  templatePath: string;
  values: Record<string, string>;
}) {
  if (!isPlainTextTemplatePath(params.templatePath)) {
    return null;
  }

  const source = await fs.readFile(params.templatePath, "utf8");
  return replacePlainTextContent(source, params.values);
}

function replaceXmlContent(content: string, values: Record<string, string>) {
  let next = content;
  for (const [code, value] of Object.entries(values)) {
    next = next.split(code).join(escapeXml(value));
  }
  return next;
}

function collectWordTextNodes(content: string) {
  const nodes: Array<{
    innerStart: number;
    innerEnd: number;
    text: string;
  }> = [];

  for (const match of content.matchAll(WORD_TEXT_NODE_PATTERN)) {
    const fullMatch = match[0];
    const innerText = match[1] ?? "";
    const matchIndex = match.index ?? 0;
    const openTagEnd = fullMatch.indexOf(">") + 1;
    const closeTagStart = fullMatch.lastIndexOf("</w:t>");

    nodes.push({
      innerStart: matchIndex + openTagEnd,
      innerEnd: matchIndex + closeTagStart,
      text: decodeXml(innerText)
    });
  }

  return nodes;
}

function locateTextNode(nodes: Array<{ start: number }>, offset: number) {
  let nodeIndex = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index].start > offset) {
      break;
    }
    nodeIndex = index;
  }
  return nodeIndex;
}

function replaceSplitPlaceholdersInWordXml(content: string, values: Record<string, string>) {
  // Word often splits {{placeholder}} into several XML runs; we stitch them before replacement, but DOCX still requires manual review.
  const nodes = collectWordTextNodes(content);
  if (nodes.length === 0) {
    return content;
  }

  const combinedStarts: Array<{ start: number }> = [];
  let combined = "";
  for (const node of nodes) {
    combinedStarts.push({ start: combined.length });
    combined += node.text;
  }

  const plannedMatches: Array<{
    start: number;
    end: number;
    code: string;
  }> = [];

  const codes = Object.keys(values).sort((left, right) => right.length - left.length);
  for (const code of codes) {
    let searchFrom = 0;
    while (searchFrom < combined.length) {
      const foundAt = combined.indexOf(code, searchFrom);
      if (foundAt === -1) {
        break;
      }

      const startNodeIndex = locateTextNode(combinedStarts, foundAt);
      const endNodeIndex = locateTextNode(combinedStarts, foundAt + code.length - 1);
      if (startNodeIndex !== endNodeIndex) {
        plannedMatches.push({
          start: foundAt,
          end: foundAt + code.length,
          code
        });
      }

      searchFrom = foundAt + code.length;
    }
  }

  if (plannedMatches.length === 0) {
    return content;
  }

  plannedMatches.sort((left, right) => right.start - left.start);
  const nextTexts = nodes.map((node) => node.text);

  for (const match of plannedMatches) {
    const startNodeIndex = locateTextNode(combinedStarts, match.start);
    const endNodeIndex = locateTextNode(combinedStarts, match.end - 1);

    const startOffset = match.start - combinedStarts[startNodeIndex].start;
    const endOffsetExclusive = match.end - combinedStarts[endNodeIndex].start;

    if (startNodeIndex === endNodeIndex) {
      continue;
    }

    nextTexts[startNodeIndex] = `${nextTexts[startNodeIndex].slice(0, startOffset)}${values[match.code]}`;

    for (let index = startNodeIndex + 1; index < endNodeIndex; index += 1) {
      nextTexts[index] = "";
    }

    nextTexts[endNodeIndex] = nextTexts[endNodeIndex].slice(endOffsetExclusive);
  }

  let next = content;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    next = `${next.slice(0, nodes[index].innerStart)}${escapeXml(nextTexts[index])}${next.slice(nodes[index].innerEnd)}`;
  }

  return next;
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walkFiles(fullPath));
      continue;
    }

    if (entry.isFile()) {
      result.push(fullPath);
    }
  }

  return result;
}

async function renderDocxTemplate(params: {
  templatePath: string;
  targetPath: string;
  values: Record<string, string>;
}) {
  // DOCX rendering is a backend-side safe pipeline through unzip/edit/zip, not true in-browser document editing.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crm-docx-"));

  try {
    await execFileAsync("unzip", ["-qq", params.templatePath, "-d", tempDir]);

    const files = await walkFiles(tempDir);
    const xmlFiles = files.filter((filePath) => filePath.endsWith(".xml") || filePath.endsWith(".rels"));
    for (const filePath of xmlFiles) {
      const raw = await fs.readFile(filePath, "utf8");
      const splitAware = filePath.endsWith(".xml")
        ? replaceSplitPlaceholdersInWordXml(raw, params.values)
        : raw;
      const rendered = replaceXmlContent(splitAware, params.values);
      if (rendered !== raw) {
        await fs.writeFile(filePath, rendered, "utf8");
      }
    }

    await fs.mkdir(path.dirname(params.targetPath), { recursive: true });
    await execFileAsync("zip", ["-qr", params.targetPath, "."], {
      cwd: tempDir
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function readDocxXmlContent(templatePath: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crm-docx-manifest-"));

  try {
    await execFileAsync("unzip", ["-qq", templatePath, "-d", tempDir]);

    const files = await walkFiles(tempDir);
    const xmlFiles = files.filter((filePath) => filePath.endsWith(".xml") || filePath.endsWith(".rels"));
    const parts = await Promise.all(xmlFiles.map((filePath) => fs.readFile(filePath, "utf8")));
    return parts.join("\n");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function readTemplateAnalysisContent(templatePath: string) {
  const extension = path.extname(templatePath).toLowerCase();
  if (extension === ".docx") {
    return {
      content: await readDocxXmlContent(templatePath),
      extension
    };
  }

  return {
    content: await fs.readFile(templatePath, "utf8"),
    extension
  };
}

export async function analyzeTemplateManifest(params: {
  templatePath: string;
  knownCodes: string[];
}) {
  // Manifest analysis warns about unknown or risky placeholders before preview/generate in both /documents and deal-card flows.
  const { content, extension } = await readTemplateAnalysisContent(params.templatePath);
  const matches = content.match(PLACEHOLDER_PATTERN) ?? [];
  const normalizedMatches = matches.map((match) => match.replace(/\s+/g, ""));
  const uniqueFoundCodes = [...new Set(normalizedMatches)].sort((left, right) => left.localeCompare(right, "ru"));
  const knownCodeSet = new Set(params.knownCodes);
  const knownCodes = uniqueFoundCodes.filter((code) => knownCodeSet.has(code));
  const unknownCodes = uniqueFoundCodes.filter((code) => !knownCodeSet.has(code));
  const openMarkers = (content.match(/{{/g) ?? []).length;
  const closeMarkers = (content.match(/}}/g) ?? []).length;
  const hasSplitPlaceholderRisk = extension === ".docx" && (openMarkers > matches.length || closeMarkers > matches.length);

  return {
    extension,
    foundCodes: uniqueFoundCodes,
    knownCodes,
    unknownCodes,
    counts: {
      foundCodes: uniqueFoundCodes.length,
      knownCodes: knownCodes.length,
      unknownCodes: unknownCodes.length
    },
    warnings: [
      ...(unknownCodes.length > 0
        ? [`В шаблоне есть неизвестные коды: ${unknownCodes.join(", ")}`]
        : []),
      ...(hasSplitPlaceholderRisk
        ? ["DOCX может содержать placeholders, разорванные Word на XML-runs. CRM пытается собрать такие коды, но их все равно нужно проверять вручную."]
        : [])
    ]
  };
}

export async function renderDocumentFromTemplate(params: {
  templatePath: string;
  targetPath: string;
  values: Record<string, string>;
}) {
  const extension = path.extname(params.templatePath).toLowerCase();
  if (extension === ".docx") {
    await renderDocxTemplate(params);
    return {
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
  }

  const source = await fs.readFile(params.templatePath, "utf8");
  const rendered = replacePlainTextContent(source, params.values);
  await fs.mkdir(path.dirname(params.targetPath), { recursive: true });
  await fs.writeFile(params.targetPath, rendered, "utf8");

  return {
    mimeType: "text/plain; charset=utf-8"
  };
}
