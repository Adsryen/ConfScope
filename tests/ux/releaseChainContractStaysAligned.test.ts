/**
 * 发版链路的四方对齐（轮52）：CI 的 jq 模板 ↔ Go 的 json tag ↔ 构建矩阵 ↔ Release 资产名。
 *
 * 事故形态与轮50/轮51 同型——坏掉的那一环不会报错：
 * - 线上实测 `releases/latest/download/update.json` 里 v1.9.1 的 notes 是 "发行版 1.9.1"：
 *   generate-manifest 用 `gh release view` 读发行正文，而 release 作业 needs 本作业，读的时候
 *   Release 还没被创建，`2>/dev/null || echo ""` 把失败咽掉，于是永远走兜底文案；这两处文字
 *   直接进界面（About.tsx 的更新面板、App.tsx 的后台检查通知），用户每次升级只看到一行空话。
 * - update.json 的键由 CI 的 jq 模板手写、Go 侧靠 json tag 解码、平台查表键靠 GOOS-GOARCH 约定、
 *   资产名靠 upload 与 release files 两处手工对齐。json.Decode 对未知字段静默忽略，
 *   漂一个字母的结果是 sha256 变空或 "no asset for platform X"，构建照样绿。
 * - 发版链路此前一条检查都不跑（release.yml 里 tsc / vitest / go test / gofmt 计数为 0）。
 *
 * 守卫钉九条，每条都带变异对照：
 * 1. preflight 作业存在、build 依赖它，且作业里确实跑了类型检查、守卫、Go 测试、注入证据、发版脚本；
 * 2. 每个 upload-artifact 步骤都必须 if-no-files-found: error；
 * 3. jq 模板写出的键 ⊆ Go Manifest/PlatformAsset 的 json tag，且必需键一个不少；
 * 4. 矩阵每个 (platform, goarch) 都能在 platforms 里查到；downloadUrl 末段 == fileName
 *    == sha256sum 实参末段 == release 作业 files 里的路径末段（被哈希的就是被发布的那一个）；
 * 5. notes 必须来自 scripts/extract-release-notes.mjs（不得再回 gh release view，也不得留占位兜底）；
 * 6. 该脚本对真实 CHANGELOG 抽出多行 bullet 且无 markdown 残留，段落缺失/正文为空必须非 0 退出，
 *    小节标题一律中文（轮64：判据从「必须有新增和修复」改成「不许漏英文」，另用夹具把八类映射逐项覆盖）；
 * 7. （轮58）GitHub Release 正文也只能来自 CHANGELOG：release 作业必须先用
 *    scripts/sync-github-release-notes.mjs 渲染 body_path 指向的那份文件，且不能再把
 *    generate_release_notes 打开——那是按"合并进来的 PR"汇总的自动注记，本仓库不走 PR 流程，
 *    线上 20 个 Release 除 v1.0.0 外正文就只剩一行 compare 链接（本轮要修的形态）；
 * 8. （轮58）两个消费方同源：打过 tag 的版本必须在 CHANGELOG 里有段落，应用内纯文本 notes 与
 *    Release markdown 正文的 bullet 必须一一对得上，处置规则（写入/覆盖/保留手写/已同步/缺段落）
 *    用离线正文快照钉住，不许真打 API。
 * 9. （轮70）发布说明的口吻：CHANGELOG 抽出来的文字原样进应用更新面板与 Release 正文，
 *    开发日志式写法（轮次编号、「实测」「门禁」这类内部词、仓库内部路径、源码文件名、超长条目）
 *    就是直接把用户眼前的文案写成自己的工作草稿。判据见本文件末尾的「发布说明的口吻」一节，
 *    覆盖 1.9.2 起的段落；更早的段落按当时的形态已经发布过，回改会让说明与实际交付脱节。
 *
 * 解释历史的注释不算代码：先按行剥掉 `#` 注释再抽判据，否则守卫会在自己解释自己的注释上自红。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECTION_LABELS, listChangelogVersions, normalizeVersion } from "../../scripts/changelogSection.mjs";
import { isGeneratedBody, latestPointerProblem, manualBodyChars, planRelease, renderReleaseBody, resolveCompareBase } from "../../scripts/sync-github-release-notes.mjs";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const WORKFLOW = ".github/workflows/release.yml";
const CHECKER_GO = "internal/updatecheck/checker.go";
const NOTES_SCRIPT = "scripts/extract-release-notes.mjs";
const SYNC_SCRIPT = "scripts/sync-github-release-notes.mjs";
const REPO = "Adsryen/ConfScope";
const VERIFY_SCRIPT = "scripts/verify-release-version.sh";
const PKG_VERSION: string = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;

/** update.json 里 Go 一定会读的顶层键（缺一个就等于界面上少一块信息）。 */
const REQUIRED_TOP_LEVEL = ["version", "notes", "publishedAt", "mandatory", "platforms"];
/** 每个平台资产必须齐这三样，缺 sha256 就是下载后无从校验，缺 fileName 就是落地名未知。 */
const REQUIRED_ASSET_FIELDS = ["downloadUrl", "sha256", "fileName"];

function stripHashComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line.replace(/\s+#\s+\S.*$/, "")))
    .join("\n");
}

function workflowCode(raw?: string): string {
  return stripHashComments(raw ?? readFileSync(join(PROJECT_ROOT, WORKFLOW), "utf8"));
}

/** 作业块：按 2 空格缩进的 `name:` 切 jobs: 段。 */
function jobBlocks(text: string): Record<string, string> {
  const at = text.indexOf("\njobs:\n");
  if (at < 0) throw new Error(`${WORKFLOW} 里没有 jobs: 段`);
  const body = text.slice(at + "\njobs:".length);
  const heads: { name: string; index: number }[] = [];
  for (const m of body.matchAll(/^ {2}([A-Za-z][\w-]*):[ \t]*$/gm)) {
    heads.push({ name: m[1], index: Number(m.index) });
  }
  const out: Record<string, string> = {};
  heads.forEach((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    out[head.name] = body.slice(head.index, end);
  });
  return out;
}

function stepChunks(block: string): string[] {
  const chunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of block.split("\n")) {
    if (/^ {6}- /.test(line)) {
      current = [line];
      chunks.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return chunks.map((chunk) => chunk.join("\n"));
}

/** 取一个步骤的 run 内容：块标量按 10 空格反缩进，单行写法原样返回。 */
function runBody(chunk: string): string {
  const lines = chunk.split("\n");
  const at = lines.findIndex((line) => /^ {8}run:/.test(line));
  if (at < 0) return "";
  const header = lines[at].slice(lines[at].indexOf("run:") + 4).trim();
  if (header && header !== "|") return header;
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      out.push("");
      continue;
    }
    if (!/^ {10,}\S/.test(line)) break;
    out.push(line.slice(10));
  }
  return out.join("\n");
}

function jobScript(block: string | undefined): string {
  if (!block) return "";
  return stepChunks(block)
    .map(runBody)
    .filter(Boolean)
    .join("\n");
}

function needsOf(block: string | undefined): string[] {
  if (!block) return [];
  const m = /^ {4}needs:\s*(.+)$/m.exec(block);
  if (!m) return [];
  return m[1]
    .replace(/[[\]'"]/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function matrixTargets(buildBlock: string | undefined): { platform: string; goarch: string; key: string }[] {
  const block = buildBlock ?? "";
  const start = block.indexOf("include:");
  const end = block.indexOf("\n    runs-on:");
  if (start < 0 || end < 0) return [];
  const slice = block.slice(start, end);
  const out: { platform: string; goarch: string; key: string }[] = [];
  let current: Record<string, string> | null = null;
  for (const line of slice.split("\n")) {
    const entry = /^ *-\s+(\w+):\s*(\S+)\s*$/.exec(line);
    if (entry) {
      if (current?.platform && current?.goarch) {
        out.push({ platform: current.platform, goarch: current.goarch, key: `${current.platform}-${current.goarch}` });
      }
      current = { [entry[1]]: entry[2] };
      continue;
    }
    const kv = /^ {12}(\w+):\s*(\S+)\s*$/.exec(line);
    if (current && kv) current[kv[1]] = kv[2];
  }
  if (current?.platform && current?.goarch) {
    out.push({ platform: current.platform, goarch: current.goarch, key: `${current.platform}-${current.goarch}` });
  }
  return out;
}

function uploadSteps(text: string): { job: string; name: string; chunk: string }[] {
  const out: { job: string; name: string; chunk: string }[] = [];
  for (const [job, block] of Object.entries(jobBlocks(text))) {
    for (const chunk of stepChunks(block)) {
      if (/uses: *actions\/upload-artifact/.test(chunk)) out.push({ job, name: chunk.split("\n")[0].trim(), chunk });
    }
  }
  return out;
}

function jqTemplate(script: string): string {
  const m = /'\{([\s\S]*?)\}'\s*>\s*update\.json/.exec(script);
  if (!m) throw new Error("generate-manifest 里找不到写 update.json 的 jq 模板");
  return m[1];
}

type JqField = { trail: string[]; value: string };

/** 手写小解析器：jq 模板每行一个键，靠栈记住父路径（不引第三方 YAML/JSON 依赖）。 */
function parseJqTemplate(template: string): JqField[] {
  const fields: JqField[] = [];
  const stack: string[] = [];
  for (const rawLine of template.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "}" || line === "},") {
      stack.pop();
      continue;
    }
    const m = /^(?:"([^"]+)"|([A-Za-z_]\w*))\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? m[2];
    let value = m[3].trim();
    const opens = value.endsWith("{");
    if (opens) value = value.slice(0, -1).trim();
    if (value.endsWith(",")) value = value.slice(0, -1).trim();
    fields.push({ trail: [...stack, key], value });
    if (opens) stack.push(key);
  }
  return fields;
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function jqArgDecls(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of script.matchAll(/--arg\s+([A-Za-z_]\w*)\s+"([^"]*)"/g)) out.set(m[1], m[2]);
  return out;
}

function sha256SourcePaths(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of script.matchAll(/([A-Z0-9_]+)=\$\(sha256sum\s+"([^"]+)"/g)) out.set(m[1], m[2]);
  return out;
}

function releaseFiles(text: string): string[] {
  const out: string[] = [];
  for (const chunk of stepChunks(jobBlocks(text).release ?? "")) {
    const m = /files:\s*\|\n((?:[ \t]+\S.*\n?)+)/.exec(chunk);
    if (!m) continue;
    for (const line of m[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function assetNameFromUrlValue(value: string): string {
  const m = /\/([^"/]+)"?$/.exec(value.trim());
  return m ? m[1] : "";
}

function goJsonTags(structName: string): string[] {
  const text = stripComments(readFileSync(join(PROJECT_ROOT, CHECKER_GO), "utf8"));
  const m = new RegExp(`type ${structName} struct \\{([\\s\\S]*?)\\n\\}`).exec(text);
  if (!m) throw new Error(`${CHECKER_GO} 里找不到 type ${structName} struct`);
  return [...m[1].matchAll(/json:"([^",]+)/g)].map((found) => found[1]);
}

/** Go 查表键的形态：CurrentPlatform() 必须是 "<GOOS>-<GOARCH>"，与 CI 的键写法同源。 */
function currentPlatformFormat(): string {
  const text = stripComments(readFileSync(join(PROJECT_ROOT, CHECKER_GO), "utf8"));
  const m = /func CurrentPlatform\(\) string \{\s*return fmt\.Sprintf\("([^"]+)"/.exec(text);
  return m ? m[1] : "";
}

function runNotesScript(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [join(PROJECT_ROOT, NOTES_SCRIPT), ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * 规则 6 的小节标题口径（轮64 收紧前先看这条原先为什么会红）：
 * 抽取脚本把 `### Added` 这类英文标题按 scripts/changelogSection.mjs 的 SECTION_LABELS 映射成
 * 中文标签（界面是中文应用），映射不到就 `?? heading` 原样输出——于是更新弹窗里会凭空多出一行
 * "Hotfix"。原先这条守卫写成「必须同时出现 新增 和 修复」，把两件事混成一件：
 * 真实意图是「标题不许漏英文」，而「每个版本都得凑出新增与修复」并不成立——
 * 1.9.6 是纯安全闸门版，只有「安全 / 工程」两节，硬塞一节空的「修复」就是把 CHANGELOG
 * 写成给测试看的样子。拆成两条：① 任一版本的说明都不得出现未映射的标题；
 * ② 八类小节的映射用离线夹具逐项覆盖，新增类漏映射同样判红。
 * @returns 问题清单，空数组代表通过
 */
function notesLabelProblems(notes: string): string[] {
  const problems: string[] = [];
  // 标题行的形态：非空、不是 bullet、不是续行缩进
  const labels = notes
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.startsWith("- ") && !line.startsWith(" ") && line !== "");
  if (labels.length === 0) problems.push("抽不出任何小节标题");
  for (const label of labels) {
    if (/^[A-Za-z][A-Za-z ]*$/.test(label.trim())) problems.push(`小节标题没映射成中文：${label.trim()}`);
  }
  return problems;
}

/** 规则 3 + 4：清单契约。返回问题清单，变异对照靠它判红。 */
function manifestProblems(text: string): string[] {
  const problems: string[] = [];
  const jobs = jobBlocks(text);
  const script = jobScript(jobs["generate-manifest"]);
  if (!script) return ["generate-manifest 作业没有 run 步骤"];

  const manifestTags = goJsonTags("Manifest");
  const assetTags = goJsonTags("PlatformAsset");
  let fields: JqField[];
  try {
    fields = parseJqTemplate(jqTemplate(script));
  } catch (error) {
    return [(error as Error).message];
  }

  const topLevel = fields.filter((field) => field.trail.length === 1).map((field) => field.trail[0]);
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!topLevel.includes(key)) problems.push(`update.json 缺顶层键 ${key}（Go 的 Manifest 会读到空值）`);
  }
  for (const key of topLevel) {
    if (!manifestTags.includes(key)) {
      problems.push(`update.json 的顶层键 ${key} 在 Go 的 Manifest json tag 里不存在，json.Decode 只会静默忽略`);
    }
  }

  const assetFields = fields.filter((field) => field.trail[0] === "platforms" && field.trail.length === 3);
  const platformKeys = fields.filter((field) => field.trail.length === 2 && field.trail[0] === "platforms").map((field) => field.trail[1]);
  const fieldNames = new Set(assetFields.map((field) => field.trail[2]));
  for (const name of REQUIRED_ASSET_FIELDS) {
    if (!fieldNames.has(name)) problems.push(`平台资产缺字段 ${name}`);
  }
  for (const name of fieldNames) {
    if (!assetTags.includes(name)) {
      problems.push(`平台资产字段 ${name} 不在 Go 的 PlatformAsset json tag 里（写成 ${name}，解码只会静默丢弃）`);
    }
  }

  for (const target of matrixTargets(jobs.build)) {
    if (!platformKeys.includes(target.key)) {
      problems.push(`构建矩阵有 ${target.key} 这一路产物，但 update.json 的 platforms 里没有它 ⇒ 该平台用户永远「no asset for platform ${target.key}」`);
    }
  }

  const args = jqArgDecls(script);
  const shaPaths = sha256SourcePaths(script);
  const files = releaseFiles(text).map(basename);
  const usedArgs = new Set<string>();
  for (const key of platformKeys) {
    const byField = new Map(assetFields.filter((field) => field.trail[1] === key).map((field) => [field.trail[2], field.value]));
    const url = byField.get("downloadUrl") ?? "";
    const fileName = unquote(byField.get("fileName") ?? "");
    const sha = byField.get("sha256") ?? "";
    if (!url || !fileName || !sha) {
      problems.push(`${key}: downloadUrl/fileName/sha256 有空值`);
      continue;
    }
    const urlName = assetNameFromUrlValue(url);
    if (urlName !== fileName) problems.push(`${key}: downloadUrl 末段 ${urlName || "(空)"} 与 fileName ${fileName} 不一致`);
    if (!files.includes(fileName)) problems.push(`${key}: release 作业的 files 里没有 ${fileName}，update.json 承诺了一个没发布的资产`);
    const shaVar = /^\$([A-Za-z_]\w*)$/.exec(sha)?.[1];
    if (!shaVar) {
      problems.push(`${key}: sha256 不是引用 --arg 的变量（写成 ${sha}）`);
    } else {
      usedArgs.add(shaVar);
      const declaredValue = args.get(shaVar) ?? "";
      const shellVar = /^\$\{([A-Z0-9_]+)\}$/.exec(declaredValue)?.[1];
      const path = shellVar ? shaPaths.get(shellVar) : undefined;
      if (!path) {
        problems.push(`${key}: sha256 引用 $${shaVar}，但追不到它对应的 sha256sum 实参路径（--arg ${shaVar} "${declaredValue}"）`);
      } else if (basename(path) !== fileName) {
        problems.push(`${key}: 被哈希的是 ${basename(path)}，而 fileName 是 ${fileName}，校验必然对不上`);
      }
    }
    for (const match of url.matchAll(/\$([A-Za-z_]\w*)/g)) usedArgs.add(match[1]);
  }
  for (const [name] of args) {
    const referenced = fields.some((field) => new RegExp(`\\$${name}\\b`).test(field.value));
    if (!referenced) problems.push(`--arg ${name} 声明了却没进 update.json，改模板时漏掉了它`);
  }
  return problems;
}

/** 规则 1 + 2：预检门禁与产物缺失。 */
function preflightProblems(text: string): string[] {
  const problems: string[] = [];
  const jobs = jobBlocks(text);
  if (!jobs.preflight) problems.push("release.yml 没有 preflight 作业：出包链路又不跑任何检查了");
  const needs = needsOf(jobs.build);
  if (!needs.includes("preflight")) problems.push(`build 不依赖 preflight（needs=${JSON.stringify(needs)}），门禁形同虚设`);

  const script = jobScript(jobs.preflight);
  const required: { label: string; pattern: RegExp }[] = [
    { label: "依赖按锁文件安装", pattern: /pnpm install\s+--frozen-lockfile/ },
    { label: "类型检查", pattern: /tsc --noEmit/ },
    { label: "前端构建与生产守卫", pattern: /pnpm build:web/ },
    { label: "静态守卫与单测", pattern: /vitest run tests\/ux/ },
    { label: "gofmt 判据", pattern: /gofmt -l/ },
    { label: "Go 测试", pattern: /go test \.\/internal\/\.\.\./ },
    { label: "版本注入的可执行证据", pattern: /-X confscope\/internal\/app\.appVersion=/ },
    { label: "tag 触发时跑发版闸门", pattern: /verify-release-version\.sh/ },
  ];
  for (const item of required) {
    if (!item.pattern.test(script)) problems.push(`preflight 少了「${item.label}」这一步（作业里没有 ${item.pattern}）`);
  }

  for (const step of uploadSteps(text)) {
    if (!/if-no-files-found:\s*error/.test(step.chunk)) {
      problems.push(`${step.job} 的「${step.name}」没有 if-no-files-found: error，产物缺失只会 warn`);
    }
  }
  return problems;
}

/** 规则 5：发版说明的事实源。 */
function notesProblems(text: string): string[] {
  const problems: string[] = [];
  const script = jobScript(jobBlocks(text)["generate-manifest"]);
  if (!script) return ["generate-manifest 没有 run 步骤"];
  if (!script.includes("extract-release-notes.mjs")) {
    problems.push("update.json 的 notes 不再由 scripts/extract-release-notes.mjs 提供，等于回到占位文案");
  }
  if (/gh release view/.test(script)) {
    problems.push("generate-manifest 又去读 gh release view 的正文：那时 Release 还没创建，读到的永远是空串");
  }
  if (/NOTES="发行版/.test(script)) problems.push("generate-manifest 保留了占位文案兜底，抽不到说明应该直接失败");
  if (!/NOTES="\$\(node scripts\/extract-release-notes\.mjs/.test(script)) {
    problems.push("notes 的赋值形态变了，请确认抽不到段落时仍然会让构建失败（不能在命令替换里吞掉退出码）");
  }
  const jobs = jobBlocks(text);
  const gmSteps = stepChunks(jobs["generate-manifest"] ?? "");
  if (!gmSteps.some((chunk) => /uses: *actions\/checkout/.test(chunk))) {
    problems.push("generate-manifest 没有 Checkout 步骤，读不到 CHANGELOG.md");
  }
  return problems;
}

describe("发版链路的契约对齐（轮52）", () => {
  const text = workflowCode();

  it("真实 release.yml：预检门禁在位且被 build 依赖", () => {
    expect(preflightProblems(text)).toEqual([]);
  });

  it("真实 release.yml：update.json 与 Go 解码器、矩阵、发布资产名四方一致", () => {
    expect(manifestProblems(text)).toEqual([]);
  });

  it("真实 release.yml：发版说明取自 CHANGELOG 而非尚未创建的 Release", () => {
    expect(notesProblems(text)).toEqual([]);
  });

  it("平台查表键的口径：GOOS-GOARCH，与 CI 写死的键同源", () => {
    expect(currentPlatformFormat()).toBe("%s-%s");
    const targets = matrixTargets(jobBlocks(text).build);
    expect(targets.length, "构建矩阵解析不出来，守卫口径失效").toBeGreaterThanOrEqual(4);
    expect(targets.map((target) => target.key).sort()).toEqual([
      "darwin-amd64",
      "darwin-arm64",
      "linux-amd64",
      "windows-amd64",
    ]);
  });

  it("jq 模板用到的 --arg 全部落进 update.json，反之亦然", () => {
    const script = jobScript(jobBlocks(text)["generate-manifest"]);
    const declared = [...jqArgDecls(script).keys()];
    const referenced = new Set<string>();
    for (const field of parseJqTemplate(jqTemplate(script))) {
      for (const match of field.value.matchAll(/\$([A-Za-z_]\w*)/g)) referenced.add(match[1]);
    }
    expect(declared.filter((name) => !referenced.has(name))).toEqual([]);
    expect([...referenced].filter((name) => !declared.includes(name))).toEqual([]);
  });

/**
 * 「四处一致」里最容易被漏掉的那一处：wails.json 的 info.productVersion。
 * 它不在 ldflags 通道上，CI 只用 jq 改写工作副本，所以闸门不盯它就永远不会红。
 */
function wailsVersionGateProblems(script: string): string[] {
  const problems: string[] = [];
  if (!/require\('\.\/wails\.json'\)\.info\.productVersion/.test(script)) {
    problems.push("闸门不再读 wails.json 的 info.productVersion：安装包版本号漂移不会让任何检查变红");
  }
  if (!/\$WAILS_PRODUCT_VERSION" = "\$VERSION/.test(script)) {
    problems.push("闸门读了 productVersion 却没和待发布版本比较，等于没校");
  }
  return problems;
}

  it("发版闸门脚本把本轮守卫也纳入（本地与 CI 同一份判据）", () => {
    const verify = readFileSync(join(PROJECT_ROOT, VERIFY_SCRIPT), "utf8");
    expect(verify).toContain("tests/ux/releaseChainContractStaysAligned.test.ts");
  });

  it("发版闸门把 wails.json 的 productVersion 算进版本号四处一致（轮65）", () => {
    const verify = readFileSync(join(PROJECT_ROOT, VERIFY_SCRIPT), "utf8");
    expect(wailsVersionGateProblems(verify)).toEqual([]);

    const wails = JSON.parse(readFileSync(join(PROJECT_ROOT, "wails.json"), "utf8")) as { info: { productVersion: string } };
    expect(wails.info.productVersion, "仓库里提交的 info.productVersion 要跟 package.json 一起进发版提交").toBe(PKG_VERSION);

    expect(wailsVersionGateProblems(verify.replace(/'\.\/wails\.json'/, "'./nope.json'")).length).toBeGreaterThan(0);
    expect(wailsVersionGateProblems(verify.replace('\$WAILS_PRODUCT_VERSION" = "\$VERSION', '\$WAILS_PRODUCT_VERSION" = "0.0.0')).length).toBeGreaterThan(0);
  });

  it("变异对照：删掉 preflight 依赖、作业名漂了、上传步骤放宽，都必须判红", () => {
    expect(preflightProblems(text.replace("    needs: preflight\n", "")).length).toBeGreaterThan(0);
    expect(preflightProblems(text.replace("    needs: preflight\n", "    needs: preflightz\n")).length).toBeGreaterThan(0);
    expect(preflightProblems(text.replace(/      - name: Static guards[\s\S]*?vitest run tests\/ux\n/, "")).length).toBeGreaterThan(
      0
    );
    expect(
      preflightProblems(text.replace("          # 产物没编出来要在上传这一步就红", "").replace("          if-no-files-found: error\n", ""))
          .length
    ).toBeGreaterThan(0);
  });

  it("变异对照：资产字段改名（fileName→filename）必须判红，因为 Go 只会静默忽略", () => {
    const mutated = text.replace('                  fileName: "confscope-windows-amd64-portable.exe"', '                  filename: "confscope-windows-amd64-portable.exe"');
    expect(mutated).not.toBe(text);
    expect(manifestProblems(mutated).length).toBeGreaterThan(0);
  });

  it("变异对照：顶层键漂了（publishedAt→publishDate）必须判红", () => {
    const mutated = text.replace("              publishedAt: $publishedAt,", "              publishDate: $publishedAt,");
    expect(mutated).not.toBe(text);
    expect(manifestProblems(mutated).length).toBeGreaterThan(0);
  });

  it("变异对照：矩阵加一路平台但清单没跟着加，必须判红", () => {
    const mutated = text.replace(
      "          - os: windows-latest\n            platform: windows\n            goarch: amd64",
      "          - os: windows-latest\n            platform: windows\n            goarch: arm64"
    );
    expect(mutated).not.toBe(text);
    expect(manifestProblems(mutated).some((problem) => problem.includes("windows-arm64"))).toBe(true);
  });

  it("变异对照：删掉一个平台条目、或哈希的文件名与 fileName 不一致，都必须判红", () => {
    // 只删得掉以 "}," 收尾的条目（最后一档收尾是不带逗号的 "}"），windows-amd64 是矩阵里的第一路
    const dropped = text.replace(/"windows-amd64": \{[\s\S]*?\n                \},\n/, "");
    expect(dropped).not.toBe(text);
    expect(manifestProblems(dropped).some((problem) => problem.includes("windows-amd64"))).toBe(true);

    const mismatch = text.replace(
      'WIN_SHA256=$(sha256sum "artifacts/ConfScope-windows-amd64/confscope-windows-amd64-portable.exe"',
      'WIN_SHA256=$(sha256sum "artifacts/ConfScope-windows-amd64/confscope-windows-amd64-portable.bin"'
    );
    expect(mismatch).not.toBe(text);
    expect(manifestProblems(mismatch).some((problem) => problem.includes("被哈希的是"))).toBe(true);

    const notPublished = text.replace("            artifacts/ConfScope-windows-amd64/confscope-windows-amd64-portable.exe\n", "            artifacts/ConfScope-windows-amd64/confscope-windows-amd64-portable-win.exe\n");
    expect(notPublished).not.toBe(text);
    expect(manifestProblems(notPublished).some((problem) => problem.includes("files 里没有"))).toBe(true);
  });

  it("变异对照：说明改回读 gh release view、或留占位兜底、或删掉 Checkout，都必须判红", () => {
    expect(notesProblems(text.replace('NOTES="$(node scripts/extract-release-notes.mjs "${VERSION}")"', 'NOTES=$(gh release view "x" --json body)')).length).toBeGreaterThan(0);
    expect(notesProblems(text.replace('NOTES="$(node scripts/extract-release-notes.mjs "${VERSION}")"', 'NOTES="发行版 ${VERSION}"')).length).toBeGreaterThan(0);
    expect(notesProblems(text.replace('NOTES="$(node scripts/extract-release-notes.mjs "${VERSION}")"', "NOTES=$(cat notes.txt)")).length).toBeGreaterThan(0);
    const noCheckout = text.replace("      - name: Checkout\n        uses: actions/checkout@v4\n\n      - name: Download all artifacts\n        uses: actions/download-artifact@v4\n        with:\n          path: artifacts\n", "      - name: Download all artifacts\n        uses: actions/download-artifact@v4\n        with:\n          path: artifacts\n");
    expect(noCheckout).not.toBe(text);
    expect(notesProblems(noCheckout).length).toBeGreaterThan(0);
  });
});

describe("发布说明抽取脚本（真实 CHANGELOG 的可执行证据）", () => {
  const pkgVersion = PKG_VERSION;

  it(`package.json 的版本（${pkgVersion}）能抽出多行 bullet，且没有 markdown 残留`, () => {
    const run = runNotesScript([pkgVersion]);
    expect(run.code, `抽取失败：${run.stderr}`).toBe(0);
    const notes = run.stdout.trim();
    expect(notes).toBeTruthy();
    expect(notes.split("\n").length, "说明应该不止一行").toBeGreaterThan(3);
    expect(notes).toMatch(/^- /m);
    for (const noise of ["## [", "### ", "**", "`", "]("]) {
      expect(notes, `更新面板按纯文本渲染，不该带 ${noise}`).not.toContain(noise);
    }
  });

  it("真实 CHANGELOG 的小节标题不漏英文（界面是中文应用）", () => {
    const run = runNotesScript([pkgVersion]);
    expect(run.code, run.stderr).toBe(0);
    expect(notesLabelProblems(run.stdout), run.stdout).toEqual([]);
  });

  it("八类小节的映射逐项覆盖，未收录的标题必须被查出（变异对照）", () => {
    const dir = mkdtempSync(join(tmpdir(), "confscope-notes-labels-"));
    const file = join(dir, "CHANGELOG.md");
    const coverage = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Engineering", "Technical"];
    const expected = ["新增", "变更", "废弃", "移除", "修复", "安全", "工程", "技术"];
    writeFileSync(
      file,
      `# Changelog\n\n## [9.9.9] - 2026-01-01\n\n${coverage.map((h) => `### ${h}\n- 该小节的条目\n`).join("\n")}`,
      "utf8"
    );
    const full = runNotesScript(["9.9.9", `--changelog=${file}`]);
    expect(full.code, full.stderr).toBe(0);
    for (const label of expected) expect(full.stdout, `缺少中文标签 ${label}`).toMatch(new RegExp(`^${label}$`, "m"));
    expect(notesLabelProblems(full.stdout), full.stdout).toEqual([]);

    // 变异对照：加一个 SECTION_LABELS 里没有的标题，英文会漏进中文界面，判据必须抓到
    writeFileSync(
      file,
      `# Changelog\n\n## [9.9.9] - 2026-01-01\n\n${coverage.map((h) => `### ${h}\n- 该小节的条目\n`).join("\n")}
### Hotfix\n- 未收录的小节\n`,
      "utf8"
    );
    const leaked = runNotesScript(["9.9.9", `--changelog=${file}`]);
    expect(leaked.code, leaked.stderr).toBe(0);
    expect(notesLabelProblems(leaked.stdout), leaked.stdout).toContain("小节标题没映射成中文：Hotfix");
  });

  it("版本段落不存在 ⇒ 非 0 退出（宁可发版构建红，也不发占位文案）", () => {
    const run = runNotesScript(["0.0.1"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("CHANGELOG");
  });

  it("段落存在但正文为空、或标题没写日期 ⇒ 同样非 0 退出", () => {
    const dir = mkdtempSync(join(tmpdir(), "confscope-changelog-"));
    const empty = join(dir, "empty.md");
    writeFileSync(empty, "# Changelog\n\n## [1.9.9] - 2026-10-20\n\n## [1.9.8] - 2026-01-01\n\n- 上一版\n", "utf8");
    expect(runNotesScript(["1.9.9", `--changelog=${empty}`]).code).not.toBe(0);

    const noDate = join(dir, "nodate.md");
    writeFileSync(noDate, "# Changelog\n\n## [1.9.7]\n\n- 忘了写日期\n", "utf8");
    expect(runNotesScript(["1.9.7", `--changelog=${noDate}`]).code).not.toBe(0);

    const ok = join(dir, "ok.md");
    writeFileSync(ok, "# Changelog\n\n## [Unreleased]\n\n## [1.9.6] - 2026-10-20\n\n### Added\n- 支持 **粗体** 与 [`链接`](https://example.com)\n\n### Fixed\n- 修好一件事\n\n## [1.9.5] - 2026-01-01\n\n- 无关段落\n", "utf8");
    const run = runNotesScript(["v1.9.6", `--changelog=${ok}`]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe("新增\n- 支持 粗体 与 链接\n\n修复\n- 修好一件事");
  });

  it("CHANGELOG 顶部段落与 package.json 版本对齐（发版闸门的判据之一）", () => {
    const changelog = readFileSync(join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(new RegExp(`^## \\[${pkgVersion.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`, "m"));
  });
});

// ---------------------------------------------------------------------------
// 轮58：GitHub Release 正文与 CHANGELOG 同源
// ---------------------------------------------------------------------------

/** CHANGELOG 里有日期的段落版本号（解析口径与两个消费方共用同一份模块）。 */
function changelogVersions(markdown: string): string[] {
  return listChangelogVersions(markdown).map((item) => item.version);
}

/** 本地能看到的 vX.Y.Z tag。CI 浅克隆时这张表可能只剩当前 tag，所以守卫只正向要求覆盖。 */
function localReleaseTags(): string[] {
  try {
    return execFileSync("git", ["tag", "-l", "v[0-9]*"], { cwd: PROJECT_ROOT, encoding: "utf8" })
      .split("\n")
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 取一个步骤 `with:` 的输入（只认 10 空格缩进的 `key: value` 单行写法；块标量不在本守卫口径内）。 */
function stepInputs(chunk: string): Record<string, string> {
  const lines = chunk.split("\n");
  const at = lines.findIndex((line) => /^ {8}with:\s*$/.test(line));
  if (at < 0) return {};
  const out: Record<string, string> = {};
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^ {10}\S/.test(line)) break;
    const pair = /^ {10}([\w-]+):\s*(.*)$/.exec(line);
    if (pair) out[pair[1]] = pair[2].trim();
  }
  return out;
}

/** runner.temp 的两种写法（Actions 表达式与 shell 变量）归一化，好比对同一份文件。 */
function normalizeTempPath(value: string): string {
  return String(value ?? "")
    .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, "<tmp>")
    .replace(/\$\{RUNNER_TEMP\}/g, "<tmp>")
    .replace(/^"|"$/g, "")
    .trim();
}

/** release 作业块的文本变形（作业是最后一个，块含 `  release:` 头且只出现一次）。 */
function mutateReleaseJob(text: string, mutate: (block: string) => string): string {
  const block = jobBlocks(text).release;
  if (!block) throw new Error("release.yml 没有 release 作业");
  const mutated = mutate(block);
  expect(mutated).not.toBe(block);
  return text.replace(block, mutated);
}

/** 规则 7：GitHub Release 正文的事实源。返回问题清单，变异对照靠它判红。 */
function releaseBodyProblems(text: string): string[] {
  const problems: string[] = [];
  const jobs = jobBlocks(text);
  const block = jobs.release;
  if (!block) return ["release.yml 没有 release 作业：没有东西去发布 Release 正文"];
  const steps = stepChunks(block);
  if (!steps.some((chunk) => /uses: *actions\/checkout/.test(chunk))) {
    problems.push("release 作业没有 Checkout 步骤，读不到 CHANGELOG.md");
  }

  const syncStep = steps.find((chunk) => runBody(chunk).includes("sync-github-release-notes.mjs"));
  const run = syncStep ? runBody(syncStep) : "";
  if (!syncStep) {
    problems.push("release 作业不再调用 scripts/sync-github-release-notes.mjs 渲染正文：等于回到 GitHub 自动注记，只剩一行 compare 链接");
  } else {
    if (!/--print-body="\$\{VERSION\}"/.test(run)) {
      problems.push("--print-body 不再取 ${VERSION}：正文可能与本次发布的版本脱节（写死版本号最坏）");
    }
    if (!/VERSION="\$\{GITHUB_REF_NAME#v\}"/.test(run)) {
      problems.push("VERSION 不再从 tag 名剥 v 前缀：${VERSION} 就对不上 CHANGELOG 的段落标题");
    }
    if (!/--repo="\$\{\{ *github\.repository *\}\}"/.test(run)) {
      problems.push("--repo 没跟随当前仓库：compare 链接会被写死成某一个 owner/repo，换仓库或 fork 就是死链");
    }
    if (!/--out=(?:"|')(.*?)\.md(?:"|')/.test(run)) {
      problems.push("渲染结果没有 --out 落盘：Create Release 无从读取正文");
    }
  }

  const createStep = steps.find((chunk) => /uses: *softprops\/action-gh-release/.test(chunk));
  if (!createStep) {
    problems.push("release 作业没有 Create Release 步骤");
    return problems;
  }
  const inputs = stepInputs(createStep);
  if (inputs.generate_release_notes === "true") {
    problems.push("Create Release 又打开 generate_release_notes：那是 GitHub 按合并 PR 生成的注记，本仓库不发 PR，正文只会剩一行 compare");
  }
  if (!inputs.body_path) {
    problems.push("Create Release 没有 body_path：正文不再来自 CHANGELOG");
  } else if (syncStep) {
    const outPath = /--out=(?:"|')(.*?)(?:"|')/.exec(run)?.[1];
    if (!outPath) {
      problems.push("渲染步骤没有把正文写到文件，body_path 指向的是空气");
    } else if (normalizeTempPath(outPath) !== normalizeTempPath(inputs.body_path)) {
      problems.push(`body_path（${inputs.body_path}）与渲染步骤 --out（${outPath}）不是同一个文件`);
    }
  }
  // 发布完的 latest 指针：GitHub 不按版本号算，补建老版本会把它抢走，而应用内更新读的就是
  // releases/latest/download/update.json —— 错位时所有「检查更新」都取不到清单，且不会有任何地方变红。
  const pointerStep = steps.find((chunk) => /releases\/latest/.test(runBody(chunk)));
  if (!pointerStep) {
    problems.push("release 作业发布后没有确认 latest 指针落在本次 tag 上：latest 被别的版本占走时应用内更新读不到 update.json，没有任何检查会红");
  } else if (!/GITHUB_REF_NAME/.test(runBody(pointerStep))) {
    problems.push("latest 指针检查没拿本次发布的 tag 比对（run 里看不到 GITHUB_REF_NAME），等于只打了个读数");
  }
  return problems;
}

function runSyncScript(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [join(PROJECT_ROOT, SYNC_SCRIPT), ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** 处置规则要能被钉住，就得能离线跑：正文快照 + 迷你 CHANGELOG，一次 API 都不打。 */
const FIXTURE_CHANGELOG = `# Changelog

## [Unreleased]

## [2.0.1] - 2026-11-01

### Added
- 甲功能
- 乙功能

## [2.1.0] - 2026-11-05

### Added
- 庚功能

## [2.2.0] - 2026-11-08

### Added
- 戊功能：把两份配置的差异按层级路径列出来，同名 key 在不同父路径下不再混为一谈，读起来不用再自己数缩进。
- 己功能：写入前自动留存目标配置的原样副本，出问题能从操作历史里找到那一次并回退。
- 庚功能：批量替换先出一份可逐项勾选的执行计划，确认后才落笔，计划里能看到每一项改动前后的完整内容，未勾选的一项都不会被改动。

## [2.4.0] - 2026-11-09

### Added
- 戊功能：把两份配置的差异按层级路径列出来，同名 key 在不同父路径下不再混为一谈，读起来不用再自己数缩进。
- 己功能：写入前自动留存目标配置的原样副本，出问题能从操作历史里找到那一次并回退。
- 庚功能：批量替换先出一份可逐项勾选的执行计划，确认后才落笔，计划里能看到每一项改动前后的完整内容，未勾选的一项都不会被改动。

## [2.0.0] - 2026-10-01

### Added
- 丙功能
- 丁功能

### Fixed
- 修好一件事

## [1.9.9] - 2026-09-01

### Added
- 更早的段落

## [0.9.8] - 2026-08-01

### Added
- 最后一个段落：没有下一段可依，compare 行要退回 commits 链接
`;

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "confscope-release-notes-"));
  writeFileSync(join(dir, "CHANGELOG.md"), FIXTURE_CHANGELOG, "utf8");
  return dir;
}

function snapshotRows(stdout: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^(v[\w.]+)\s+(有|无)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (match) rows[match[1]] = match[4];
  }
  return rows;
}

describe("GitHub Release 正文的事实源（轮58）", () => {
  const text = workflowCode();

  it("真实 release.yml：正文由 sync 脚本从 CHANGELOG 渲染后交给 body_path", () => {
    expect(releaseBodyProblems(text)).toEqual([]);
  });

  it("变异对照：重新打开自动注记、删掉 body_path、删掉渲染步骤、路径对不上、删掉 Checkout 都必须判红", () => {
    expect(releaseBodyProblems(mutateReleaseJob(text, (block) => block.replace("generate_release_notes: false", "generate_release_notes: true")))).toContain(
      "Create Release 又打开 generate_release_notes：那是 GitHub 按合并 PR 生成的注记，本仓库不发 PR，正文只会剩一行 compare"
    );

    const noBodyPath = mutateReleaseJob(text, (block) => block.replace("          body_path: ${{ runner.temp }}/release-body.md\n", ""));
    expect(releaseBodyProblems(noBodyPath)).toContain("Create Release 没有 body_path：正文不再来自 CHANGELOG");

    const noSyncStep = mutateReleaseJob(text, (block) => block.replace("scripts/sync-github-release-notes.mjs", "scripts/some-other-notes-source.mjs"));
    expect(releaseBodyProblems(noSyncStep).some((problem) => problem.includes("不再调用 scripts/sync-github-release-notes.mjs"))).toBe(true);

    const wrongPath = mutateReleaseJob(text, (block) => block.replace("body_path: ${{ runner.temp }}/release-body.md", "body_path: ${{ github.workspace }}/release-body.md"));
    expect(releaseBodyProblems(wrongPath).some((problem) => problem.includes("不是同一个文件"))).toBe(true);

    const noCheckout = mutateReleaseJob(text, (block) => block.replace("      - name: Checkout\n        uses: actions/checkout@v4\n\n", ""));
    expect(releaseBodyProblems(noCheckout)).toContain("release 作业没有 Checkout 步骤，读不到 CHANGELOG.md");

    const hardcodedRepo = mutateReleaseJob(text, (block) => block.replace('--repo="${{ github.repository }}"', `--repo="${REPO}"`));
    expect(releaseBodyProblems(hardcodedRepo).some((problem) => problem.includes("--repo 没跟随当前仓库"))).toBe(true);

    const hardcodedVersion = mutateReleaseJob(text, (block) => block.replace('--print-body="${VERSION}"', '--print-body="1.9.3"'));
    expect(releaseBodyProblems(hardcodedVersion).some((problem) => problem.includes("--print-body 不再取"))).toBe(true);
  });
});

describe("发布说明的两个消费方同源（轮58）", () => {
  const changelog = readFileSync(join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");

  it("每个 CHANGELOG 段落都渲染得出正文，且带中文小节与 compare 行", () => {
    const versions = changelogVersions(changelog);
    expect(versions.length, "CHANGELOG 解析不出来，守卫口径失效").toBeGreaterThan(5);
    for (const version of versions) {
      const rendered = renderReleaseBody(changelog, version, { repo: REPO });
      expect(rendered, `段落 [${version}] 渲染不出 Release 正文`).not.toBeNull();
      expect(rendered!.body).toMatch(/^## v/);
      expect(rendered!.body).toMatch(/^### /m);
      expect(rendered!.body).toMatch(/^- /m);
      expect(rendered!.body).toContain(`https://github.com/${REPO}/`);
    }
  });

  it("打过 tag 的版本必须在 CHANGELOG 里有段落（CI 浅克隆时这张表可能只剩当前 tag）", () => {
    for (const tag of localReleaseTags()) {
      const version = normalizeVersion(tag);
      if (!version) continue;
      expect(changelogVersions(changelog).includes(version), `${tag} 打过 tag 但 CHANGELOG 没有段落：Release 正文会抽不出来`).toBe(true);
    }
  });

  it("compare 链接的上一个 tag 由段落顺序推导；0.x 没打过 tag，退回 commits 链接不造死链", () => {
    expect(resolveCompareBase("1.9.1")).toBe("v1.9.1");
    expect(resolveCompareBase("0.1.0"), "0.x 没有 tag，不能当 compare 基线").toBeNull();
    expect(resolveCompareBase(null)).toBeNull();

    const latest = renderReleaseBody(changelog, PKG_VERSION, { repo: REPO });
    expect(latest!.compareBase, "当前版本应当拼出 compare 基线").toBeTruthy();
    expect(latest!.body).toContain(`**Full Changelog**: https://github.com/${REPO}/compare/${latest!.compareBase}...v${PKG_VERSION}`);

    const firstTagged = renderReleaseBody(changelog, "1.0.0", { repo: REPO });
    expect(firstTagged!.previousVersion).toBe("0.1.0");
    expect(firstTagged!.compareBase).toBeNull();
    expect(firstTagged!.body).toContain(`**Full Changelog**: https://github.com/${REPO}/commits/v1.0.0`);
  });

  it("应用内纯文本 notes 与 Release 正文的 bullet 一一对应（同源不是口号）", () => {
    const plain = runNotesScript([PKG_VERSION]);
    expect(plain.code, plain.stderr).toBe(0);
    const dir = fixtureDir();
    const bodyFile = join(dir, "release-body.md");
    const rendered = runSyncScript([`--print-body=${PKG_VERSION}`, `--out=${bodyFile}`]);
    expect(rendered.code, rendered.stderr).toBe(0);

    const bullets = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[-*] \S/.test(line))
        // 两边口径的差别就是 markdown 记号：比之前统一剥掉
        .map((line) => line.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const plainBullets = bullets(plain.stdout);
    const bodyBullets = bullets(readFileSync(bodyFile, "utf8"));
    expect(plainBullets.length).toBeGreaterThan(3);
    expect(bodyBullets).toEqual(plainBullets);
  });

  it("抽不到段落 ⇒ --print-body 非 0 退出（发版构建宁可红，也不发一行 compare 当说明）", () => {
    const run = runSyncScript(["--print-body=0.0.1"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("CHANGELOG");
    const fixture = runSyncScript(["--print-body=0.9.8", `--changelog=${join(fixtureDir(), "CHANGELOG.md")}`]);
    expect(fixture.code, "段落抽得出就不该非 0").toBe(0);
    expect(fixture.stdout, "CHANGELOG 的最后一段没有下一段可依，退回 commits 链接").toContain(`/commits/v0.9.8`);
  });
});

describe("latest 指针必须还在版本号最高的 Release 上", () => {
  const releases = [{ tag: "v1.9.13" }, { tag: "v1.9.0" }, { tag: "v1.0.0" }];

  it("指针与最高版本号一致就没什么可说", () => {
    expect(latestPointerProblem({ onlineLatestTag: "v1.9.13", releases })).toBeNull();
    expect(latestPointerProblem({ onlineLatestTag: "", releases }), "读不到指针不当作错位").toBeNull();
    expect(latestPointerProblem({ onlineLatestTag: "v1.9.0", releases: [] })).toBeNull();
  });

  it("老版本抢走指针就判红，并给出现成的纠正命令", () => {
    const problem = latestPointerProblem({ onlineLatestTag: "v1.9.0", releases });
    expect(problem, "应用内更新读 releases/latest/download/update.json，错位等于全量用户更新失败").not.toBeNull();
    expect(problem).toContain("update.json");
    expect(problem).toContain("gh release edit v1.9.13 --latest");
  });

  it("接线：--list / --apply 三条出口都把错位算成红，本地快照模式跳过", () => {
    const syncSource = readFileSync(join(PROJECT_ROOT, SYNC_SCRIPT), "utf8");
    expect(syncSource).toContain("latestPointerProblem({ onlineLatestTag: latestTag, releases })");
    const exits = syncSource.match(/return [^\n]*latestProblem[^\n]*\? 1 : 0;/g) ?? [];
    expect(exits.length, "list / 无写入 / 写入完成三条出口都要带上它").toBe(3);
    expect(/let latestProblem = null;\s*if \(!opts\.bodiesDir\) \{/.test(syncSource), "快照模式没有线上指针这个事实源").toBe(true);
  });
});

describe("Release 正文回填的处置规则（离线快照，一次 API 都不打）", () => {
  const dir = fixtureDir();
  const changelogArg = `--changelog=${join(dir, "CHANGELOG.md")}`;
  const snapshotDir = join(dir, "snapshot");
  mkdirSync(snapshotDir, { recursive: true });
  const inSyncBody = runSyncScript([`--print-body=1.9.9`, changelogArg]).stdout;

  const manual = "手写正文：这一版详细说明了功能清单、下载表格与 macOS 暂不可用的说明。";
  writeFileSync(join(snapshotDir, "v2.0.1.md"), "", "utf8"); // 空正文 ⇒ 写入
  writeFileSync(join(snapshotDir, "v2.1.0.md"), "**Full Changelog**: https://github.com/o/r/compare/v2.0.1...v2.1.0\n", "utf8"); // 只剩链接 ⇒ 覆盖
  writeFileSync(join(snapshotDir, "v1.9.9.md"), inSyncBody, "utf8"); // 已与 CHANGELOG 一致 ⇒ 已同步
  writeFileSync(join(snapshotDir, "v2.0.0.md"), `${manual}\n\n`.repeat(8), "utf8"); // 有段落但线上是手写 ⇒ 默认保留
  writeFileSync(join(snapshotDir, "v3.3.3.md"), `${manual}\n\n`.repeat(8), "utf8"); // 无段落但线上是手写 ⇒ 保留（别把人写的顶掉）
  writeFileSync(join(snapshotDir, "v0.9.9.md"), "只有一句话", "utf8"); // 无段落又短 ⇒ 必须报缺段落

  // 一对控制变量：同样的字符数，只差末尾那行生成标记。正文取自真实渲染链路，
  // 只把「戊功能：」改成「戊功能（旧文案）：」，模拟线上还停在旧文案的状态。
  const staleBody = (version: string) =>
    runSyncScript([`--print-body=${version}`, changelogArg]).stdout.replace("戊功能：", "戊功能（旧文案）：");
  const withMarker = staleBody("2.2.0");
  const withoutMarker = withMarker.replace(/^<!-- confscope:release-notes.*-->$/gm, "").trim() + "\n";
  writeFileSync(join(snapshotDir, "v2.2.0.md"), withMarker, "utf8"); // 带标记的旧文案 ⇒ 不用 --force 也按 CHANGELOG 更新
  writeFileSync(join(snapshotDir, "v2.4.0.md"), withoutMarker, "utf8"); // 同样长度没标记 ⇒ 仍走老口径当作手写

  it("--list 把处置分开：写入 / 覆盖 / 已同步 / 保留手写 / 缺段落", () => {
    const run = runSyncScript(["--list", `--bodies-dir=${snapshotDir}`, changelogArg]);
    expect(run.code, "有缺段落就该非 0，逼人去补 CHANGELOG").not.toBe(0);
    expect(snapshotRows(run.stdout)).toMatchObject({
      "v2.0.1": "写入",
      "v2.1.0": "覆盖",
      "v1.9.9": "已同步",
      "v2.0.0": "保留手写",
      "v3.3.3": "保留手写",
      "v0.9.9": "缺段落",
    });
  });

  it("手写正文默认不动；--force 只覆盖抽得出段落的，抽不出段落的要当场报缺段落", () => {
    const forced = runSyncScript(["--list", "--force", `--bodies-dir=${snapshotDir}`, changelogArg]);
    const rows = snapshotRows(forced.stdout);
    expect(rows["v2.0.0"], "有段落的手写正文，--force 要能覆盖").toBe("覆盖");
    expect(rows["v3.3.3"], "force 的语义是正文只认 CHANGELOG：抽不到段落就必须报缺段落，不能静默留在旧正文上").toBe("缺段落");
    expect(rows["v1.9.9"], "force 不该把已同步的重新写一遍").toBe("已同步");
    expect(forced.code).not.toBe(0);
  });

  it("参数口径：--force 只准逐版覆盖手写正文，批量回填拿不到这个口子", () => {
    // 批量 --apply --force 一旦允许，一次判错就把整片 Release 的手写正文冲掉，
    // 而备份只在写之前那份，恢复还得人工逐个对回线上。
    // 探针仓库名：万一参数校验哪天被改回去，这条命令会打到不存在的仓库上直接失败，
    // 而不是拿真实的 Adsryen/ConfScope 去批量覆盖手写正文（变异测试时踩过这个雷）。
    const probeRepo = "--repo=confscope-ci-probe/no-such-release-repo";
    for (const args of [["--apply", "--force"], ["--apply", "--all", "--force"]]) {
      const run = runSyncScript([...args, probeRepo]);
      expect(run.code, `${args.join(" ")} 必须被参数校验拦住`).toBe(2);
      expect(run.stderr).toContain("--version");
      expect(run.stderr, "要给出可用的替代写法，不能只说不行").toContain("--apply --all");
    }

    // 只读试算不受限：--list 不写任何东西，正是要用它逐版看清 force 会覆盖什么。
    const forcedList = runSyncScript(["--list", "--force", `--bodies-dir=${snapshotDir}`, changelogArg]);
    expect(snapshotRows(forcedList.stdout), "--list --force 仍然要走到试算").toMatchObject({ "v2.0.0": "覆盖" });

    const help = runSyncScript(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--force 必须和 --version 一起给");
  });

  it("生成标记是判据，长度只是没标记老正文的权宜口径", () => {
    expect(manualBodyChars(withoutMarker), "夹具正文必须够长，否则这条只在测阈值以下的分支").toBeGreaterThanOrEqual(200);
    const rows = snapshotRows(runSyncScript(["--list", `--bodies-dir=${snapshotDir}`, changelogArg]).stdout);
    expect(rows["v2.2.0"], "带生成标记 ⇒ 脚本产物，按 CHANGELOG 更新").toBe("覆盖");
    expect(rows["v2.4.0"], "同样篇幅但认不出标记 ⇒ 仍按老口径保留手写").toBe("保留手写");

    const rendered = renderReleaseBody(FIXTURE_CHANGELOG, "2.2.0", { repo: REPO });
    expect(rendered, "夹具里的段落必须渲染得出正文").not.toBeNull();
    expect(planRelease({ rendered, existingBody: withMarker }).reason).toContain("生成标记");
    expect(planRelease({ rendered, existingBody: withoutMarker }).action).toBe("keep-manual");
    // 变异对照：注释前缀换了就不算标记，免得将来写成别的注释还指望它起作用
    const wrongMarker = withMarker.replace(/^<!-- confscope:release-notes(.*)-->$/m, "<!-- generated-from: CHANGELOG$1-->");
    expect(planRelease({ rendered, existingBody: wrongMarker }).action, "前缀不匹配的注释不算生成标记").toBe("keep-manual");
  });

  it("重跑幂等；生成标记不算进「人手写的字符数」", () => {
    const rendered = renderReleaseBody(FIXTURE_CHANGELOG, "2.2.0", { repo: REPO });
    expect(planRelease({ rendered, existingBody: rendered.body }).action, "线上已是刚渲染的那份 ⇒ 不该再写一遍").toBe("in-sync");
    const stripped = rendered.body.replace(/^<!-- confscope:release-notes.*-->$/gm, "").trim() + "\n";
    expect(manualBodyChars(rendered.body), "标记不计入手写字符数，否则脚本产物会被当手写保护起来").toBe(manualBodyChars(stripped));
    expect(isGeneratedBody(rendered.body)).toBe(true);
    expect(isGeneratedBody(stripped)).toBe(false);
  });

  it("CHANGELOG 抽不到段落、线上却带生成标记 ⇒ 报缺段落，不当手写正文护着", () => {
    const longPlain = `${"生成的旧正文".repeat(80)}\n\n- 甲\n- 乙\n`;
    const marked = `${longPlain}\n<!-- confscope:release-notes generated-from CHANGELOG.md v9.9.9 -->\n`;
    expect(manualBodyChars(marked)).toBeGreaterThanOrEqual(200);
    const plan = planRelease({ rendered: null, existingBody: marked });
    expect(plan.action, "脚本产物谈不上保护，缺段落就得逼人回去补 CHANGELOG").toBe("missing-section");
    expect(plan.reason).toContain("脚本生成");
    expect(planRelease({ rendered: null, existingBody: longPlain }).action, "人写的长正文仍然保留").toBe("keep-manual");
  });

  it("真实链路：--print-body 末尾带标记且版本号对得上，纯文本 notes 不被污染", () => {
    const body = runSyncScript([`--print-body=1.9.13`]).stdout;
    expect(body).toMatch(/^<!-- confscope:release-notes generated-from CHANGELOG\.md v1\.9\.13 -->$/m);
    expect(body.lastIndexOf("confscope:release-notes"), "标记要排在 compare 行之后").toBeGreaterThan(
      body.lastIndexOf("**Full Changelog**")
    );
    const notes = runNotesScript(["1.9.13"]);
    expect(notes.code).toBe(0);
    expect(notes.stdout, "应用内更新面板读的是纯文本 notes，不该长出这行注释").not.toContain("confscope:release-notes");
    expect(notes.stdout).not.toContain("<!--");
  });

  it("覆盖的依据要说真话：线上有内容就不能写成「只剩 compare 行」", () => {
    // 回填是不可逆的对外写入，操作者靠这张表判断"覆盖掉的是不是一行空话"。
    // v1.4.2 线上有 188 字符的英文说明（够不上手写正文的阈值），旧文案把它和
    // 只剩 compare 行的版本混成一句话——表格上看不出异常，实际顶掉的是真人写的内容。
    const rendered = renderReleaseBody(FIXTURE_CHANGELOG, "2.0.1", { repo: REPO });
    expect(rendered, "夹具里的段落必须渲染得出正文").not.toBeNull();

    const onlyCompare = planRelease({
      rendered,
      existingBody: "**Full Changelog**: https://github.com/o/r/compare/v2.0.0...v2.0.1",
    });
    expect(onlyCompare.action).toBe("update");
    expect(onlyCompare.reason, "确实只剩 compare 行时才许这么说").toBe("线上正文只剩 compare 行");

    const shortNotes = ["英文三条说明", "- build dmg", "- fix icons", "", "x".repeat(150)].join("\n");
    const short = planRelease({ rendered, existingBody: shortNotes });
    expect(short.action).toBe("update");
    expect(short.existingChars, "夹具正文要落在「有内容但未达手写篇幅」这一档").toBeGreaterThan(0);
    expect(short.existingChars).toBeLessThan(200);
    expect(short.reason, "有线上内容就必须报出字符数，不能谎称只剩 compare 行").toContain(`${short.existingChars} 字符`);
    expect(short.reason).not.toContain("只剩 compare 行");
  });

  it("空正文的依据是「线上正文是空的」，别再和只剩 compare 行混用", () => {
    const rendered = renderReleaseBody(FIXTURE_CHANGELOG, "2.0.1", { repo: REPO });
    const added = planRelease({ rendered, existingBody: "   \n  " });
    expect(added.action).toBe("add");
    expect(added.reason).toBe("线上正文是空的");
  });

  it("--bodies-dir 只许配 --list：写入的备份与回读必须对着线上", () => {
    const run = runSyncScript(["--apply", `--bodies-dir=${snapshotDir}`, changelogArg]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("--bodies-dir 只能配 --list");
  });

  it("参数口径：模式互斥、未知参数、--print-body 不给版本号都得非 0", () => {
    expect(runSyncScript(["--list", "--apply"]).code).not.toBe(0);
    expect(runSyncScript(["--nope=1"]).code).not.toBe(0);
    expect(runSyncScript(["--print-body="]).code).not.toBe(0);
    expect(runSyncScript(["--help"]).code).toBe(0);
  });

  it("renderMarkdownBody 保留行内 markdown，但 extractReleaseNotes 必须剥掉（两个口径是刻意的）", () => {
    const dir2 = fixtureDir();
    const file = join(dir2, "with-marks.md");
    writeFileSync(file, "## [2.5.0] - 2026-12-01\n\n### Added\n- 支持 **粗体** 与 `code` 和 [链接](https://example.com)\n\n## [2.4.0] - 2026-01-01\n\n- 无关\n", "utf8");
    const plain = runNotesScript(["2.5.0", `--changelog=${file}`]);
    expect(plain.stdout.trim()).toBe("新增\n- 支持 粗体 与 code 和 链接");
    const body = runSyncScript([`--print-body=2.5.0`, `--changelog=${file}`]);
    expect(body.stdout).toContain("- 支持 **粗体** 与 `code` 和 [链接](https://example.com)");
  });
});

// ---------------------------------------------------------------------------
// 轮70：发布说明的口吻
// ---------------------------------------------------------------------------
// CHANGELOG 的段落不是开发日志：它被抽成两份，一份是 update.json 的 notes（应用内「更新内容」按
// white-space: pre-wrap 直接显示），一份是 GitHub Release 正文。写成取证记录，用户看到的就是一屏
// 黑话。口径落在 .trellis/spec/guides/release-notes-voice.md，这一节把其中能机械判定的部分钉住。

/**
 * 判据没有版本豁免下界：CHANGELOG 里每个带日期的段落都要过一遍。
 * 原先设过 1.9.2 的下界，理由是「旧正文已经发出去，回改会和当时交付的内容脱节」；实际后果是旧段落
 * 里的开发日志措辞永远没人管，而判据被临时调到全量普查之后就停在那里回不去了。本轮把旧段落按
 * 「事实不变、只换说法」改成用户口径并同步回线上正文，下界连同它的豁免语义一起删掉。
 */
/** 规则 13：条目开头不贴表情符号做装饰。渲染到 Release 页面就是一排图标，读起来像聊天记录。 */
const VOICE_EMOJI = /\p{Extended_Pictographic}/u;
/** 规则 9：一条 bullet 讲一件事。超长就是把两三件事塞进了一句，更新面板里会糊成一坨。 */
const VOICE_BULLET_MAX = 200;
/** 规则 5：仓库内部路径对读者没有意义，还会顺手把目录结构暴露出去。 */
const VOICE_REPO_PATHS = ["tests/", "internal/", "src/", "scripts/", ".trellis/", ".github/"];
/** 规则 4：开发口吻的内部词（中文按子串判）。 */
const VOICE_CN_TERMS = [
  "轮\\d",
  "本轮",
  "这一轮",
  "实测",
  "真机",
  "复验",
  "取证",
  "变异对照",
  "守卫",
  "用例",
  "普查",
  "接线",
  "判据",
  "闸门",
  "门禁",
  "金丝雀",
  "事实源",
  "兜底",
  "收口",
  "水合",
  "保活",
  "演成",
  "归位",
];
/** 规则 4：工具名（英文按词边界判，免得正常句子被误伤）。 */
const VOICE_EN_TERMS = ["eslint", "gofmt", "retest", "tsc", "vitest"];
/** 规则 5 的另一半：源码文件名。安装包的 .exe/.deb/.rpm/.dmg/.tar.gz 是用户要下载的东西，不算。 */
const VOICE_SOURCE_EXT = String.raw`\.(?:mjs|nsi|nsh|ps1|sh|go|tsx?)(?![0-9A-Za-z])`;

const VOICE_TERMS: Array<{ label: string; pattern: RegExp }> = [
  ...VOICE_CN_TERMS.map((word) => ({ label: word, pattern: new RegExp(word) })),
  ...VOICE_EN_TERMS.map((word) => ({ label: word, pattern: new RegExp(`(?<![0-9a-z])${word}(?![0-9a-z])`, "i") })),
];

const VOICE_SECTION_LABELS = new Set<string>(Object.values(SECTION_LABELS));

/**
 * 纯文本说明 → 「一条一件事」的列表。
 * CHANGELOG 为了 140 列宽会把一条写成两行，抽取时只去了行首缩进，所以这里要把续行并回上一条：
 * `- ` 起头算新条目，小节标题（SECTION_LABELS 的取值，或紧跟 bullet 之前的纯英文标题）算分隔。
 * 内部词/路径/文件名那三项判的是全文每一行，不依赖这里的合并，合并只服务长度判据。
 */
function voiceBullets(notes: string): string[] {
  const bullets: string[] = [];
  let openBullet = false;
  for (const rawLine of notes.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      openBullet = false;
      continue;
    }
    const isLabel = VOICE_SECTION_LABELS.has(line) || (!openBullet && /^[A-Za-z][A-Za-z ]*$/.test(line));
    if (isLabel) {
      openBullet = false;
      continue;
    }
    if (/^- \S/.test(line)) {
      bullets.push(line.slice(2).trim());
      openBullet = true;
      continue;
    }
    if (openBullet) bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line}`;
    else bullets.push(line);
  }
  return bullets;
}

/** 口吻判据。输入是抽取脚本渲染出来的 notes 文本（用户实际看到的形态），不是 CHANGELOG 原文。 */
function notesVoiceProblems(notes: string): string[] {
  const problems: string[] = [];
  const bullets = voiceBullets(notes);
  if (bullets.length === 0) problems.push("抽不出任何 bullet，这一版的说明是空的");

  const seen = new Set<string>();
  const push = (kind: string, key: string, detail: string, line: string) => {
    const dedupe = `${kind}|${key}|${line}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    problems.push(`${kind}「${key}」会原样出现在用户眼前：${detail}（${line.slice(0, 90)}）`);
  };
  for (const rawLine of notes.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const term of VOICE_TERMS) {
      if (term.pattern.test(line)) push("开发口吻的内部词", term.label, term.label, line);
    }
    for (const repoPath of VOICE_REPO_PATHS) {
      if (line.includes(repoPath)) push("仓库内部路径", repoPath, repoPath, line);
    }
    for (const hit of line.match(new RegExp(VOICE_SOURCE_EXT, "g")) ?? []) {
      push("源码文件名", hit, hit, line);
    }
    if (VOICE_EMOJI.test(line)) push("表情符号装饰", "emoji", "发布说明不用表情符号给条目做装饰", line);
  }
  for (const bullet of bullets) {
    const length = [...bullet].length;
    if (length > VOICE_BULLET_MAX) {
      problems.push(`单条 bullet ${length} 字符，超过 ${VOICE_BULLET_MAX}，应该拆成两条：${bullet.slice(0, 60)}…`);
    }
  }
  return problems;
}

describe("发布说明的口吻（面向用户，不是开发日志）", () => {
  const changelog = readFileSync(join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
  const covered = changelogVersions(changelog);
  const extracted = covered.map((version) => {
    const run = runNotesScript([version]);
    expect(run.code, `${version} 抽取失败：${run.stderr}`).toBe(0);
    return { version, notes: run.stdout };
  });

  it("覆盖范围：每个带日期的段落都在判据内，没有版本豁免", () => {
    expect(covered.length).toBeGreaterThanOrEqual(30);
    expect(covered[0]).toBe(changelogVersions(changelog)[0]);
    expect(covered).toContain(PKG_VERSION);
    // 曾经落在下界之外的三段，现在同样受约束
    for (const anchor of ["1.9.1", "1.1.0", "0.1.0"]) expect(covered).toContain(anchor);
  });

  it(`${covered.length} 个段落的说明里没有内部词、内部路径、源码文件名、表情符号`, () => {
    const problems = extracted.flatMap(({ version, notes }) =>
      notesVoiceProblems(notes).map((text) => `${version}：${text}`)
    );
    expect(problems, `\n${problems.join("\n")}`).toEqual([]);
  });

  it(`每条 bullet 不超过 ${VOICE_BULLET_MAX} 字符（更新面板按纯文本整段显示）`, () => {
    const measured = extracted.flatMap(({ version, notes }) =>
      voiceBullets(notes).map((bullet) => ({ version, length: [...bullet].length, bullet }))
    );
    const over = measured.filter((item) => item.length > VOICE_BULLET_MAX);
    expect(over, `\n${over.map((item) => `${item.version} ${item.length}：${item.bullet}`).join("\n")}`).toEqual([]);
    expect(measured.length).toBeGreaterThan(50);
  });

  it("变异对照：四类形态各来一发必须全被抓到，合格文案不判红", () => {
    const withTerm = notesVoiceProblems("修复\n- 本轮实测确认这里少清了一个定时器。");
    expect(withTerm.length, "内部词「实测」「本轮」").toBeGreaterThan(0);
    expect(withTerm.join("\n")).toContain("实测");

    const withRound = notesVoiceProblems("修复\n- 轮70 修掉了安装包的乱码。");
    expect(withRound.join("\n"), "轮次编号").toContain("轮\\d");

    const withPath = notesVoiceProblems("工程\n- 判据见 tests/ux/releaseChainContractStaysAligned.test.ts。");
    expect(withPath.join("\n"), "内部路径与源码文件名").toContain("tests/");
    expect(withPath.join("\n")).toContain(".ts");

    const withEmoji = notesVoiceProblems("新增\n- ✨ **配置矩阵**: 支持多环境对比。");
    expect(withEmoji.join("\n"), "表情符号装饰").toContain("表情符号");

    const tooLong = notesVoiceProblems(`修复\n- ${"重".repeat(VOICE_BULLET_MAX + 1)}。`);
    expect(tooLong.join("\n"), "超长 bullet").toContain("超过 200");

    expect(notesVoiceProblems("修复\n- Windows 安装程序在安装进度页里的中文提示不再显示成乱码。"), "合格文案不该被判红").toEqual([]);
  });

  it("变异对照：走真实抽取链路的夹具同样判红（不是只在纯函数上自嗨）", () => {
    const dir = mkdtempSync(join(tmpdir(), "confscope-voice-"));
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(
      file,
      "## [9.9.9] - 2026-01-01\n\n### Fixed\n- 本轮实测后补齐了门禁，判据见 scripts/verify-release-version.sh。\n\n## [9.9.8] - 2025-01-01\n\n- 无关段落\n",
      "utf8"
    );
    const run = runNotesScript(["9.9.9", `--changelog=${file}`]);
    expect(run.code, run.stderr).toBe(0);
    const joined = notesVoiceProblems(run.stdout).join("\n");
    for (const needle of ["本轮", "实测", "门禁", "scripts/", ".sh"]) {
      expect(joined, `夹具里的「${needle}」应被抓到`).toContain(needle);
    }
  });

  it("判据有牙：1.9.1 改写前的原文快照按同判据必红（快照不参与 CHANGELOG 判定）", () => {
    // 1.9.1 改写前的正文快照。段落本身已经改成用户口径并通过判定，这份快照留着只证明判据不是空气
    const preFloorSample = [
      "工程",
      "- 前端主数据迁出 localStorage：以数据文件为唯一事实源，localStorage 降级为热缓存，损坏时隔离副本并回退。",
      "- 数据护栏测试补充文件↔缓存双向兼容与损坏回退用例；smoke 环境代码与 NSIS 安装器脚手架入库，retest SSH 测试环境自助化。",
    ].join("\n");
    const joined = notesVoiceProblems(preFloorSample).join("\n");
    for (const needle of ["事实源", "用例", "retest"]) {
      expect(joined, `旧段落里的「${needle}」本该是红的`).toContain(needle);
    }
  });
});
