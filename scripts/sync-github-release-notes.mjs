#!/usr/bin/env node
// sync-github-release-notes.mjs — GitHub Release 正文与 CHANGELOG 同源（轮58）。
//
// 为什么要它：release.yml 的 release 作业原先用 softprops/action-gh-release 的
// generate_release_notes: true，那是 GitHub 按"本版本合并进来的 PR"自动生成注记。
// 本仓库不走 PR 流程，于是线上 20 个 Release 里除 v1.0.0（手写正文）外，正文全部只剩
// 一行 `**Full Changelog**: .../compare/vX...vY` —— 用户点进 releases 页看不到更新了什么。
// 轮52 已把应用内更新面板的 notes 接到 CHANGELOG（extract-release-notes.mjs），本轮把
// GitHub 侧也接到同一个事实源，并给出一次性回填线上正文的 --apply。
//
// 三种模式（互斥）：
//   --print-body=<version> [--out=<路径>]    只渲染 markdown 正文，CI 出包用，不联网
//   --list                                   对着线上 Release 试算，只读，不改任何东西
//   --apply [--version=<x.y.z> | --all] [--force]
//                                            真写：先备份原正文，再 gh release edit，写完回读校验
//
// 安全边界（对着"外部可见且难撤回"这个性质设计的）：
//   1. 写入前必然先把线上原正文落盘（--backup-dir，默认 tmp 下带时间戳目录）并打印路径；
//   2. 剥掉 compare 行后正文仍 ≥ 200 字符 ⇒ 认定是手写正文（v1.0.0 就是这种），默认不覆盖，
//      要 --force；这条顺带让 --apply 重复执行是幂等的；
//   3. CHANGELOG 抽不到段落 ⇒ 非 0 退出。宁可红，也不往 Release 写一行空话（与轮52 同口径）；
//   4. 写完逐条回读比对，不一致就算失败，不静默咽掉。
//
// compare 链接的上一个 tag 取自 CHANGELOG 段落顺序（本文件按时间倒序，紧跟其下的段落就是
// 上一版），不读 git tag 列表 —— CI 里是浅克隆，`git tag -l` 可能只有当前这一个。
// 例外：0.x 从未打过 tag（线上最早的 tag 是 v1.0.0），给它拼 compare/v0.1.0...v1.0.0 是死链，
// 所以这种情况下退回 commits/<tag>，与 GitHub 自己给首个 Release 生成的那行一致。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SECTION_LABELS, findChangelogSection, listChangelogVersions, normalizeVersion } from "./changelogSection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "Adsryen/ConfScope";
const DEFAULT_TAG_PREFIX = "v";
/** 剥掉 compare 行后正文达到这个长度，就认为是有人认真手写过，默认别覆盖。 */
const MANUAL_BODY_MIN_CHARS = 200;
/** 0.x 没打过 tag：作为 compare 基线会拼出死链。 */
const MIN_TAGGED_MAJOR = 1;

function stripAllHtmlComments(text) {
  let out = text;
  for (;;) {
    const next = out.replace(/<!--[\s\S]*?-->/, "");
    if (next === out) return next;
    out = next;
  }
}

/** compare 基线：上一段落的 tag；上一段是 0.x（没打过 tag）或压根没有上一段时返回 null。 */
export function resolveCompareBase(previousVersion, tagPrefix = DEFAULT_TAG_PREFIX) {
  if (!previousVersion) return null;
  const major = Number(String(previousVersion).split(".")[0]);
  if (!Number.isFinite(major) || major < MIN_TAGGED_MAJOR) return null;
  return `${tagPrefix}${previousVersion}`;
}

function buildCompareLine(repo, tag, compareBase) {
  const base = `https://github.com/${repo}`;
  return compareBase
    ? `**Full Changelog**: ${base}/compare/${compareBase}...${tag}`
    : `**Full Changelog**: ${base}/commits/${tag}`;
}

/**
 * 段落正文 → markdown（GitHub 会渲染，所以反引号/加粗/链接原样留着），只做三件事：
 * 小节标题按中文口径换、剥 HTML 注释、连续空行压一行。行首缩进保留（将来有嵌套 bullet
 * 时不会塌成一级）——这与 extract-release-notes.mjs 的纯文本口径是刻意的差别。
 */
function renderMarkdownBody(section) {
  const lines = [];
  for (const rawLine of stripAllHtmlComments(section.body).split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const label = heading[1].trim();
      lines.push(`### ${SECTION_LABELS[label.toLowerCase()] ?? label}`);
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/**
 * 纯函数：CHANGELOG + 版本号 → GitHub Release 正文。
 * 返回 {version, tag, date, previousVersion, compareBase, body}；段落不存在返回 null。
 */
export function renderReleaseBody(markdown, version, options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const tagPrefix = options.tagPrefix ?? DEFAULT_TAG_PREFIX;
  const section = findChangelogSection(markdown, version);
  if (!section) return null;
  const core = renderMarkdownBody(section);
  if (!core) return null;
  const tag = `${tagPrefix}${section.version}`;
  const compareBase = resolveCompareBase(section.previousVersion, tagPrefix);
  const body = [
    `## ${tag} · ${section.date}`,
    "",
    core,
    "",
    "---",
    "",
    buildCompareLine(repo, tag, compareBase),
    "",
  ].join("\n");
  return { version: section.version, tag, date: section.date, previousVersion: section.previousVersion, compareBase, body };
}

/** 归一化：CRLF 与行尾空白、首尾空行差不算差异（比对线上正文用）。 */
function normalizeBody(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** 线上正文里"除 compare 行以外"的字符数：判断是不是有人手写过。 */
export function manualBodyChars(body) {
  return normalizeBody(String(body ?? "").replace(/^\s*\*\*Full Changelog\*\*:.*$/gim, "")).length;
}

/** 纯函数：单个 Release 的处置决定。action 为 add/update 时 body 才是要写入的正文。 */
export function planRelease(input) {
  const { rendered, existingBody, force = false } = input;
  const chars = manualBodyChars(existingBody);
  if (!rendered) {
    // --force 的语义是"正文只认 CHANGELOG"：那就不能对着抽不到段落的版本静默保留手写正文，
    // 必须报缺段落、非 0 退出，让人回去补 CHANGELOG（否则 force 一次等于把某个版本永久留在旧正文上）。
    const protectedManual = chars >= MANUAL_BODY_MIN_CHARS && !force;
    return {
      action: protectedManual ? "keep-manual" : "missing-section",
      existingChars: chars,
      reason: protectedManual
        ? "CHANGELOG 无段落，但线上已有手写正文，保留"
        : chars >= MANUAL_BODY_MIN_CHARS
          ? "CHANGELOG 里抽不到该版本的段落（--force 下不再保留手写正文，先去补段落）"
          : "CHANGELOG 里抽不到该版本的段落",
    };
  }
  if (!normalizeBody(existingBody)) {
    return { action: "add", body: rendered.body, existingChars: chars, reason: "线上正文是空的" };
  }
  if (normalizeBody(existingBody) === normalizeBody(rendered.body)) {
    return { action: "in-sync", existingChars: chars, reason: "线上正文已与 CHANGELOG 一致" };
  }
  if (chars >= MANUAL_BODY_MIN_CHARS) {
    if (!force) {
      return { action: "keep-manual", existingChars: chars, reason: `线上是手写正文（${chars} 字符），要覆盖得加 --force` };
    }
    return { action: "update", body: rendered.body, existingChars: chars, reason: `线上是手写正文（${chars} 字符），--force 覆盖` };
  }
  // 处置动作没错，但依据必须说真话：有的线上正文只剩 compare 行（chars 为 0），有的确实写了
  // 一小段却够不上手写正文的篇幅，两者都归 update。把后者也写成"只剩 compare 行"，
  // 回填时表格会让人以为覆盖掉了空东西——实际上覆盖掉的是 v1.4.2 那 188 个字符的英文说明。
  return {
    action: "update",
    body: rendered.body,
    existingChars: chars,
    reason: chars
      ? `线上有 ${chars} 字符说明但未达手写正文篇幅（阈值 ${MANUAL_BODY_MIN_CHARS}），以 CHANGELOG 为准`
      : "线上正文只剩 compare 行",
  };
}

// ---- gh 调用层：只有 --list / --apply 联网，--print-body 完全不碰 ----

function ghRun(args) {
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if (res.error) {
    if (res.error.code === "ENOENT") throw new Error("找不到 gh 命令：--list / --apply 需要 GitHub CLI（先用 gh auth status 确认已登录）");
    throw new Error(`gh 启动失败：${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} 退出码 ${res.status}：${(res.stderr || "").trim()}`);
  }
  return res.stdout;
}

function listOnlineReleases(repo) {
  const tsv = ghRun(["api", `repos/${repo}/releases`, "--paginate", "--jq", '.[] | [.tag_name, (.name // ""), ((.body // "") | length | tostring)] | @tsv']);
  return tsv
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [tag, name, chars] = line.split("\t");
      return { tag, name, bodyChars: Number(chars) };
    });
}

function fetchBody(repo, tag) {
  return ghRun(["api", `repos/${repo}/releases/tags/${tag}`, "--jq", '.body // ""']);
}

/** 线上 Release 清单按版本号倒序，和 CHANGELOG 的段落顺序一致（表格里更好对照）。 */
function byVersionDesc(releases) {
  return [...releases].sort((a, b) => {
    const left = normalizeVersion(a.tag) ?? "0.0.0";
    const right = normalizeVersion(b.tag) ?? "0.0.0";
    return left.localeCompare(right, undefined, { numeric: true }) * -1;
  });
}

/**
 * --bodies-dir：把线上正文摆成 `<tag>.md` 的本地快照，试算就不联网。
 * 两个用处：单元测试里能确定性地钉住处置规则；回填 20 个 Release 前不必反复打 API。
 * 只对 --list 开放：--apply 的备份与写后回读都必须对着线上做，本地快照给不了这两个保证。
 */
function readBodySnapshot(dir) {
  const releases = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ tag: file.slice(0, -".md".length), name: "", bodyChars: 0 }));
  const readBody = (tag) => readFileSync(join(dir, `${tag}.md`), "utf8");
  return { releases: byVersionDesc(releases), readBody, source: `本地正文快照 ${dir}` };
}

function onlineSource(repo) {
  return { releases: byVersionDesc(listOnlineReleases(repo)), readBody: (tag) => fetchBody(repo, tag), source: `线上 ${repo}` };
}

const USAGE = `用法:
  node scripts/sync-github-release-notes.mjs --print-body=<version> [--out=<路径>] [--repo=<名称>] [--changelog=<路径>]
  node scripts/sync-github-release-notes.mjs --list [--repo=<名称>] [--changelog=<路径>]
  node scripts/sync-github-release-notes.mjs --apply [--version=<x.y.z> | --all] [--force] [--backup-dir=<路径>]

  --print-body  渲染 markdown 正文（CI 出包用，不联网）；给 --out 就落盘，否则打 stdout
  --list        对线上每个 Release 试算处置，只读
  --bodies-dir  配合 --list：用 <tag>.md 形式的本地正文快照试算，不联网（--apply 不接受）
  --apply       真写：先把线上原正文备份到 --backup-dir（默认 tmp 带时间戳目录），再 gh release edit，写完回读校验
  --version     只处理一个版本；不给则 --all（默认全量回填）
  --force       连手写正文一起覆盖（默认保留，见脚本头部安全边界）；
                语义是"正文只认 CHANGELOG"，所以抽不到段落的版本会报缺段落，而不是静默留在旧正文上
  --changelog   默认仓库根的 CHANGELOG.md
  --repo        默认 ${DEFAULT_REPO}
`;

const ACTION_LABELS = {
  add: "写入",
  update: "覆盖",
  "keep-manual": "保留手写",
  "in-sync": "已同步",
  "missing-section": "缺段落",
};

function parseArgs(argv) {
  const opts = {
    mode: null,
    printBody: null,
    out: null,
    version: null,
    force: false,
    repo: process.env.CONFSCOPE_RELEASE_REPO || DEFAULT_REPO,
    tagPrefix: DEFAULT_TAG_PREFIX,
    changelog: join(ROOT, "CHANGELOG.md"),
    backupDir: null,
    bodiesDir: null,
    help: false,
  };
  const modes = [];
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--print-body=")) {
      modes.push("print");
      opts.printBody = arg.slice("--print-body=".length);
    } else if (arg.startsWith("--out=")) opts.out = resolve(ROOT, arg.slice("--out=".length));
    else if (arg === "--list") modes.push("list");
    else if (arg === "--apply") modes.push("apply");
    else if (arg.startsWith("--version=")) opts.version = normalizeVersion(arg.slice("--version=".length)) ?? arg.slice("--version=".length);
    else if (arg === "--all") {
      // 全量回填是 --apply 的默认行为；这个开关留着让 CI/文档里的意图写得更明白
    }
    else if (arg === "--force") opts.force = true;
    else if (arg.startsWith("--repo=")) opts.repo = arg.slice("--repo=".length);
    else if (arg.startsWith("--tag-prefix=")) opts.tagPrefix = arg.slice("--tag-prefix=".length);
    else if (arg.startsWith("--changelog=")) opts.changelog = resolve(ROOT, arg.slice("--changelog=".length));
    else if (arg.startsWith("--backup-dir=")) opts.backupDir = resolve(ROOT, arg.slice("--backup-dir=".length));
    else if (arg.startsWith("--bodies-dir=")) opts.bodiesDir = resolve(ROOT, arg.slice("--bodies-dir=".length));
    else {
      return { opts, problem: `未知参数: ${arg}` };
    }
  }
  if (opts.help) return { opts, problem: null };
  if (!modes.length) return { opts, problem: "缺模式：--print-body=<version> / --list / --apply 三选一" };
  if (new Set(modes).size > 1) return { opts, problem: "--print-body / --list / --apply 互斥，不能同给" };
  opts.mode = modes[0];
  if (opts.mode === "print" && !opts.printBody) return { opts, problem: "--print-body= 后面要给版本号" };
  if (opts.bodiesDir && opts.mode !== "list") {
    return { opts, problem: "--bodies-dir 只能配 --list：写入前的备份与写后回读都必须对着线上做，本地快照给不了这两个保证" };
  }
  return { opts, problem: null };
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return width;
}

function printTable(rows, headers) {
  const widths = headers.map((header, i) => Math.max(displayWidth(header), 0, ...rows.map((row) => displayWidth(String(row[i] ?? "")))));
  const line = (cells) =>
    cells
      .map((cell, i) => {
        const text = String(cell ?? "");
        if (i === cells.length - 1) return text;
        return `${text}${" ".repeat(Math.max(0, widths[i] - displayWidth(text)))}`;
      })
      .join("  ");
  process.stdout.write(`${line(headers)}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

function main(argv) {
  const { opts, problem } = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (problem) {
    process.stderr.write(`${problem}\n\n${USAGE}`);
    return 2;
  }

  let markdown;
  try {
    markdown = readFileSync(opts.changelog, "utf8");
  } catch (error) {
    process.stderr.write(`读不到 CHANGELOG：${opts.changelog}（${error.code || error.message}）\n`);
    return 1;
  }

  if (opts.mode === "print") {
    const rendered = renderReleaseBody(markdown, opts.printBody, { repo: opts.repo, tagPrefix: opts.tagPrefix });
    if (!rendered) {
      process.stderr.write(
        `CHANGELOG 里没有 "## [${String(opts.printBody).replace(/^v/i, "")}] - YYYY-MM-DD" 段落（版本没写日期、或段落还没起草），写不出 Release 正文。\n`
      );
      return 1;
    }
    if (!rendered.body.trim()) {
      process.stderr.write(`CHANGELOG 的 [${rendered.version}] 段落渲染出来是空的，Release 正文不能是空串。\n`);
      return 1;
    }
    if (opts.out) {
      writeFileSync(opts.out, rendered.body, "utf8");
      process.stderr.write(
        `Release 正文已写入 ${opts.out}：${rendered.body.length} 字符，${rendered.date}，compare 基线 ${rendered.compareBase ?? "无（按 commits 处理）"}\n`
      );
    } else {
      process.stdout.write(rendered.body);
    }
    return 0;
  }

  let source;
  try {
    source = opts.bodiesDir ? readBodySnapshot(opts.bodiesDir) : onlineSource(opts.repo);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return opts.bodiesDir ? 1 : 3;
  }
  const releases = source.releases;
  const readBody = source.readBody;

  let targets = releases;
  if (opts.mode === "apply" && opts.version) {
    const wanted = `${opts.tagPrefix}${opts.version}`;
    targets = releases.filter((release) => release.tag === wanted);
    if (!targets.length) {
      process.stderr.write(`${opts.repo} 上没有 ${wanted} 这个 Release（tag 还没推？），没东西可同步。\n`);
      return 1;
    }
  }

  const sectionedVersions = listChangelogVersions(markdown).map((item) => item.version);
  const rows = [];
  const plans = [];
  for (const release of targets) {
    const version = normalizeVersion(release.tag);
    let existingBody = "";
    try {
      existingBody = readBody(release.tag);
    } catch (error) {
      process.stderr.write(`读 ${release.tag} 的正文失败：${error.message}\n`);
      return opts.bodiesDir ? 1 : 3;
    }
    const rendered = version ? renderReleaseBody(markdown, version, { repo: opts.repo, tagPrefix: opts.tagPrefix }) : null;
    const plan = planRelease({ rendered, existingBody, force: opts.force });
    plans.push({ ...plan, tag: release.tag, version, rendered });
    rows.push([
      release.tag,
      version && sectionedVersions.includes(version) ? "有" : "无",
      `${plan.existingChars}`,
      ACTION_LABELS[plan.action] ?? plan.action,
      plan.reason,
    ]);
  }

  process.stdout.write(`${opts.mode === "apply" ? "同步" : "试算"} ${targets.length} 个 Release（${source.source}，正文事实源：CHANGELOG.md）\n\n`);
  printTable(rows, ["tag", "CHANGELOG", "线上正文", "动作", "依据"]);

  // "哪些段落还没有对应 Release"只有对着线上才有意义：本地快照模式下这张表本来就不全，
  // 照着它提示一批"还没发布"只会误导，所以快照模式跳过这段。
  if (!opts.bodiesDir) {
    const onlineVersions = new Set(releases.map((release) => normalizeVersion(release.tag)));
    const pending = sectionedVersions.filter((version) => !onlineVersions.has(version));
    if (pending.length) {
      process.stdout.write(`\nCHANGELOG 已有段落但线上还没有 Release 的版本（下次出包由 CI 生成正文）：${pending.join(", ")}\n`);
    }
  }

  const missing = plans.filter((plan) => plan.action === "missing-section");
  const writable = plans.filter((plan) => plan.action === "add" || plan.action === "update");

  if (opts.mode === "list") {
    process.stdout.write(`\ndry-run：没有改动任何 Release。要落地用 --apply（写入前会先备份线上原正文）。\n`);
    return missing.length ? 1 : 0;
  }

  if (!writable.length) {
    process.stdout.write(`\n没有需要写入的 Release${missing.length ? "，但有缺段落" : ""}。\n`);
    for (const plan of missing) process.stderr.write(`缺段落 ${plan.tag}: ${plan.reason}\n`);
    return missing.length ? 1 : 0;
  }

  const backupDir = opts.backupDir ?? mkdtempSync(join(tmpdir(), "confscope-release-notes-backup-"));
  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (error) {
    process.stderr.write(`建备份目录失败：${backupDir}（${error.message}）\n`);
    return 1;
  }
  process.stdout.write(`\n线上原正文备份目录：${backupDir}\n`);

  const failures = [];
  for (const plan of writable) {
    const backupPath = join(backupDir, `${plan.tag}.before.md`);
    const notesPath = join(backupDir, `${plan.tag}.notes.md`);
    try {
      writeFileSync(backupPath, readBody(plan.tag), "utf8");
      writeFileSync(notesPath, plan.rendered.body, "utf8");
      ghRun(["release", "edit", plan.tag, "--repo", opts.repo, "--notes-file", notesPath]);
      const after = readBody(plan.tag);
      if (normalizeBody(after) !== normalizeBody(plan.rendered.body)) {
        failures.push(`${plan.tag}: 写后回读与生成的正文不一致`);
        continue;
      }
      process.stdout.write(`  已写入 ${plan.tag}（原正文备份：${backupPath}）\n`);
    } catch (error) {
      failures.push(`${plan.tag}: ${error.message}`);
    }
  }

  for (const failure of failures) process.stderr.write(`写入失败 ${failure}\n`);
  for (const plan of missing) process.stderr.write(`缺段落 ${plan.tag}: ${plan.reason}\n`);
  const kept = plans.filter((plan) => plan.action === "keep-manual").length;
  const synced = plans.filter((plan) => plan.action === "in-sync").length;
  process.stdout.write(`\n写入成功 ${writable.length - failures.length}/${writable.length}，保留手写 ${kept}，已同步 ${synced}。\n`);
  return failures.length || missing.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}
