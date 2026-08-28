// 配置浏览内容搜索与批量替换的纯领域逻辑。
import type { ConfigDocument, ConfigItem } from "../api/nacos";
import type { ApplyEntryEndpoint, ApplyEntryPayload, ApplyEntryRef } from "./applyEntry";
import { applyEntryRiskSummary } from "./applyEntry";
import { detectFormat } from "./format";
import { normalizeConfig } from "./normalize";
import { validateConfig } from "./validate";

const DOCUMENT_KEY = "__document";
const SUMMARY_LIMIT = 96;

export interface ContentSearchResult {
  item: ConfigItem;
  document: ConfigDocument;
  matchedFields: Array<"dataId" | "group" | "content">;
  summary: string;
}

export interface ContentReplacement {
  content: string;
  count: number;
}

export interface ContentReplaceEntryInput {
  source: ApplyEntryEndpoint;
  target: ApplyEntryEndpoint;
  results: ContentSearchResult[];
  findText: string;
  replaceText: string;
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把文本中的搜索词包裹为 <mark class="search-hit">，返回已转义的 HTML 片段。
 *  大小写不敏感（与 containsText 的匹配语义一致）；多个命中全部标记。 */
export function highlightSearchTerm(text: string, term: string): string {
  const q = term.trim();
  if (!q) return escapeHtml(text);
  const pattern = new RegExp(escapeRegex(q), "gi");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out += escapeHtml(text.slice(last, m.index)) + `<mark class="search-hit">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function containsText(value: string, term: string): boolean {
  return normalizedText(value).includes(normalizedText(term));
}

function contentSummary(content: string, term: string): string {
  const normalizedContent = normalizedText(content);
  const index = normalizedContent.indexOf(normalizedText(term));
  if (index < 0) return content.slice(0, SUMMARY_LIMIT).replace(/\s+/g, " ").trim();
  const start = Math.max(0, index - 28);
  const end = Math.min(content.length, index + term.length + 48);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function contentRef(endpoint: ApplyEntryEndpoint, result: ContentSearchResult): ApplyEntryRef {
  return {
    provider: endpoint.provider,
    connectionId: endpoint.connectionId,
    namespace: endpoint.namespace,
    group: result.item.group,
    dataId: result.item.dataId,
    key: DOCUMENT_KEY,
  };
}

function replacementValue(dataId: string, document: ConfigDocument, content: string) {
  const format = detectFormat(dataId, document.format, content);
  const validationErrors = validateConfig(content, format);
  const normalized = normalizeConfig(content, format);
  const parseError = validationErrors.join("\n") || normalized.parseError;
  return {
    exists: true,
    value: content,
    valueType: "text" as const,
    format,
    parseStatus: validationErrors.length ? ("error" as const) : normalized.parseStatus,
    ...(parseError ? { parseError } : {}),
    content,
    version: document.version,
    updateTime: document.updateTime,
  };
}

/** 在已读取的配置中按 dataId、分组和内容执行大小写无关的字面搜索。 */
export function searchConfigContent(documents: Array<{ item: ConfigItem; document: ConfigDocument }>, term: string): ContentSearchResult[] {
  const query = term.trim();
  if (!query) return [];

  return documents.flatMap(({ item, document }) => {
    const matchedFields: ContentSearchResult["matchedFields"] = [];
    if (containsText(item.dataId, query)) matchedFields.push("dataId");
    if (containsText(item.group, query)) matchedFields.push("group");
    if (containsText(document.content, query)) matchedFields.push("content");
    if (!matchedFields.length) return [];
    return [
      {
        item,
        document,
        matchedFields,
        summary: contentSummary(document.content, query),
      },
    ];
  });
}

/** 对配置文本进行字面全量替换，并返回实际替换次数。 */
export function replaceConfigContent(content: string, findText: string, replaceText: string): ContentReplacement {
  if (!findText) return { content, count: 0 };
  const count = content.split(findText).length - 1;
  return { content: content.split(findText).join(replaceText), count };
}

/** 从已选中的搜索结果生成配置级批量 ApplyPlan 入口。 */
export function buildContentReplaceApplyEntry(input: ContentReplaceEntryInput): ApplyEntryPayload | null {
  const findText = input.findText;
  if (!findText) return null;

  const items = input.results.flatMap((result) => {
    const replacement = replaceConfigContent(result.document.content, findText, input.replaceText);
    if (!replacement.count) return [];
    const sourceRef = contentRef(input.source, result);
    const targetRef = contentRef(input.target, result);
    return [
      {
        ...targetRef,
        sourceRef,
        targetRef,
        sourceValueOverride: replacementValue(result.item.dataId, result.document, replacement.content),
      },
    ];
  });

  if (!items.length) return null;
  return {
    sourceType: "manual",
    scope: "batch",
    source: input.source,
    target: input.target,
    items,
    rangeSummary: applyEntryRiskSummary(items),
    origin: { mode: "manual", returnMode: "browse" },
  };
}

/** 获取替换后会发生实际变更的结果数量与总命中次数。 */
export function replacementImpact(
  results: ContentSearchResult[],
  findText: string,
  replaceText: string
): { configs: number; replacements: number } {
  return results.reduce(
    (impact, result) => {
      const replacement = replaceConfigContent(result.document.content, findText, replaceText);
      return replacement.count ? { configs: impact.configs + 1, replacements: impact.replacements + replacement.count } : impact;
    },
    { configs: 0, replacements: 0 }
  );
}
