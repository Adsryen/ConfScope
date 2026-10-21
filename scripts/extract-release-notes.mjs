#!/usr/bin/env node
// extract-release-notes.mjs — 从 CHANGELOG.md 抽出某个版本的发布说明，供发版链路使用（轮52）。
//
// 为什么需要它：release.yml 的 generate-manifest 作业原先用 `gh release view <tag> --json body`
// 取发行说明，但作业顺序是 release `needs: [build, generate-manifest]` —— 读的时候 Release 还没
// 被创建，`2>/dev/null || echo ""` 把失败咽掉，于是 notes 恒为兜底文案。线上实测
// https://github.com/Adsryen/ConfScope/releases/latest/download/update.json 里
// v1.9.1 的 notes 就是 "发行版 1.9.1"。这两处内容都直接进界面（About.tsx 的更新弹窗、
// App.tsx 的后台检查通知），所以用户每次升级看到的都是一行空话。
//
// 判据交给 CHANGELOG：发版闸门（scripts/verify-release-version.sh）已经要求
// tag / package.json / CHANGELOG 三处版本一致，说明段落必然存在；抽不到就是发版没准备好，
// 本脚本非 0 退出，让出包构建直接红，不再退回占位文案。
//
// 段落定位与中文小节口径都走 scripts/changelogSection.mjs（轮58 起与
// sync-github-release-notes.mjs 同源），本文件只负责"给应用更新面板看的纯文本"这一层的
// 记号处理：white-space: pre-wrap 的纯文本里留 markdown 记号就是噪点。
//
// 用法:
//   node scripts/extract-release-notes.mjs 1.9.2
//   node scripts/extract-release-notes.mjs v1.9.2 --changelog=CHANGELOG.md
// 成功：stdout 输出纯文本说明（应用的更新面板是 white-space: pre-wrap，原样可显示），exit 0。
// 失败：stderr 说明原因，exit 1（段落缺失、段落没有日期、或正文为空）。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTION_LABELS, findChangelogSection } from "./changelogSection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 去掉行内 markdown 记号：更新弹窗按纯文本渲染，反引号/加粗/链接目标留着只会变噪点。 */
function stripInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * 纯函数：从 CHANGELOG 文本里抽 version 对应段落的正文，渲染成纯文本。
 * 返回字符串（可能为空串表示段落存在但没内容）；段落不存在返回 null。
 */
export function extractReleaseNotes(markdown, version) {
  const section = findChangelogSection(markdown, version);
  if (!section) return null;
  const body = stripHtmlComments(section.body);

  const lines = [];
  let sawContent = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) {
      // 连续空行压成一行；段首空行不留
      if (sawContent && lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const key = heading[1].trim().toLowerCase();
      lines.push(SECTION_LABELS[key] ?? heading[1].trim());
      sawContent = true;
      continue;
    }
    sawContent = true;
    // 缩进的 bullet 要保住相对缩进，所以只 trimStart 不 trim
    lines.push(stripInlineMarkdown(line.trimStart()));
  }
  return sawContent ? lines.join("\n") : "";
}

function main(argv) {
  const args = argv.slice(2);
  let version = null;
  let changelog = join(ROOT, "CHANGELOG.md");
  for (const arg of args) {
    if (arg.startsWith("--changelog=")) changelog = resolve(ROOT, arg.slice("--changelog=".length));
    else if (arg === "--changelog") {
      process.stderr.write("错误: --changelog 需要跟一个路径（--changelog=CHANGELOG.md）\n");
      return 2;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`未知参数: ${arg}（用法: extract-release-notes.mjs <version> [--changelog=路径]\n`);
      return 2;
    } else if (!version) version = arg;
    else {
      process.stderr.write(`多余参数: ${arg}\n`);
      return 2;
    }
  }
  if (!version) {
    process.stderr.write("用法: node scripts/extract-release-notes.mjs <version> [--changelog=路径]\n");
    return 2;
  }
  let markdown;
  try {
    markdown = readFileSync(changelog, "utf8");
  } catch (error) {
    process.stderr.write(`读不到 CHANGELOG：${changelog}（${error.code || error.message}）\n`);
    return 1;
  }
  let notes;
  try {
    notes = extractReleaseNotes(markdown, version);
  } catch (error) {
    process.stderr.write(`解析 CHANGELOG 失败：${error.message}\n`);
    return 1;
  }
  if (notes === null) {
    process.stderr.write(
      `CHANGELOG 里没有 "## [${version.replace(/^v/i, "")}] - YYYY-MM-DD" 段落（版本没写日期、或段落还没起草），先补齐再发版。\n`
    );
    return 1;
  }
  if (!notes.trim()) {
    process.stderr.write(`CHANGELOG 的 [${version.replace(/^v/i, "")}] 段落是空的，发版说明不能是空串。\n`);
    return 1;
  }
  process.stdout.write(`${notes}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}
