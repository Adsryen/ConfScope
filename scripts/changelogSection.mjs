// changelogSection.mjs — CHANGELOG 段落解析的唯一出口（轮58）。
//
// 为什么要单独一个模块：同一份发布说明有两个消费方——
//   - scripts/extract-release-notes.mjs 出**纯文本**，进 update.json 的 notes，
//     最后落在应用内更新面板（white-space: pre-wrap，带 markdown 记号就是噪点）；
//   - scripts/sync-github-release-notes.mjs 出 **markdown**，进 GitHub Release 正文。
// 两边解析的是同一个段落。以前者已经有一套被守卫钉住的判据（段落头必须带日期、
// 剥 HTML 注释、正文为空即失败），若第二份自己再写一遍 parse，两边一旦漂移，
// 就会出现「应用里说 A，GitHub 上说 B」——正是本轮要修的毛病。
//
// 本模块只做定位与取原文，不改写：记号处理留给各自的渲染层。

/** 去掉 tag/参数上的 v 前缀；不是 x.y.z 形态一律返回 null（调用方据此判失败）。 */
export function normalizeVersion(version) {
  const normalized = String(version || "").replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(normalized) ? normalized : null;
}

/** Keep a Changelog 的小节标题按中文界面口径给出；没见过的标题原样保留，
 *  免得将来新增一节就把守卫自红。两个消费方共用这张表。 */
export const SECTION_LABELS = {
  added: "新增",
  changed: "变更",
  deprecated: "废弃",
  removed: "移除",
  fixed: "修复",
  security: "安全",
  engineering: "工程",
  technical: "技术",
};

/**
 * 定位某个版本的段落。
 * 返回 null 表示段落不存在（含「版本没写日期」这种半成品形态）；
 * 命中时 body 是该段落的原始 markdown（不含段落头，不含下一段落的头）。
 * previousVersion 取 CHANGELOG 里紧跟其下的那一段——本文件按时间倒序排列，
 * 下面那段就是上一个发布版本，compare 链接据此拼，不需要读 git tag 列表（CI 里可能是浅克隆）。
 */
export function findChangelogSection(markdown, version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})[ \\t]*$`, "m");
  const found = heading.exec(markdown);
  if (!found) return null;
  const rest = markdown.slice(found.index + found[0].length);
  const next = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  const previousVersion = next ? normalizeVersion(next[1]) : null;
  return {
    version: normalized,
    date: found[1],
    body,
    previousVersion,
  };
}

/** 列出 CHANGELOG 里所有带日期的段落（版本倒序，即文件顺序）。 */
export function listChangelogVersions(markdown) {
  const out = [];
  const pattern = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})[ \t]*$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const version = normalizeVersion(match[1]);
    if (version) out.push({ version, date: match[2] });
  }
  return out;
}

/** 段落正文里的 bullet 条数——用来判断某段是不是「有内容的正式说明」。 */
export function countBullets(body) {
  return body.split("\n").filter((line) => /^[-*] \S/.test(line.trimStart())).length;
}
