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
 * 守卫钉六条，每条都带变异对照：
 * 1. preflight 作业存在、build 依赖它，且作业里确实跑了类型检查、守卫、Go 测试、注入证据、发版脚本；
 * 2. 每个 upload-artifact 步骤都必须 if-no-files-found: error；
 * 3. jq 模板写出的键 ⊆ Go Manifest/PlatformAsset 的 json tag，且必需键一个不少；
 * 4. 矩阵每个 (platform, goarch) 都能在 platforms 里查到；downloadUrl 末段 == fileName
 *    == sha256sum 实参末段 == release 作业 files 里的路径末段（被哈希的就是被发布的那一个）；
 * 5. notes 必须来自 scripts/extract-release-notes.mjs（不得再回 gh release view，也不得留占位兜底）；
 * 6. 该脚本对真实 CHANGELOG 抽出多行 bullet 且无 markdown 残留，段落缺失/正文为空必须非 0 退出。
 *
 * 解释历史的注释不算代码：先按行剥掉 `#` 注释再抽判据，否则守卫会在自己解释自己的注释上自红。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const WORKFLOW = ".github/workflows/release.yml";
const CHECKER_GO = "internal/updatecheck/checker.go";
const NOTES_SCRIPT = "scripts/extract-release-notes.mjs";
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

  it("发版闸门脚本把本轮守卫也纳入（本地与 CI 同一份判据）", () => {
    const verify = readFileSync(join(PROJECT_ROOT, VERIFY_SCRIPT), "utf8");
    expect(verify).toContain("tests/ux/releaseChainContractStaysAligned.test.ts");
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
    const mutated = text.replace('                  fileName: "ConfScope.exe"', '                  filename: "ConfScope.exe"');
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

    const mismatch = text.replace('WIN_SHA256=$(sha256sum "artifacts/ConfScope-windows-amd64/ConfScope.exe"', 'WIN_SHA256=$(sha256sum "artifacts/ConfScope-windows-amd64/ConfScope.bin"');
    expect(mismatch).not.toBe(text);
    expect(manifestProblems(mismatch).some((problem) => problem.includes("被哈希的是"))).toBe(true);

    const notPublished = text.replace("            artifacts/ConfScope-windows-amd64/ConfScope.exe\n", "            artifacts/ConfScope-windows-amd64/ConfScope-win.exe\n");
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

  it("小节标题按中文口径给出（界面是中文应用）", () => {
    const notes = runNotesScript([pkgVersion]).stdout;
    expect(notes).toMatch(/^新增$/m);
    expect(notes).toMatch(/^修复$/m);
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
