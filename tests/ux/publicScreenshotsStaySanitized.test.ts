/**
 * 公开截图与文档面的凭据闸门（轮64）。
 *
 * 起因（实测取证，不是推测）：v1.0.0 ~ v1.9.2 这 21 个 tag 的**仓库树**里，
 * `.github/assets/` 的界面截图是早期手工截的真实环境——明文 redis 密码、
 * `mongodb://账号:密码@内网IP` 连接串、内网 IP、真实命名空间 UUID 与租户名，
 * 部分打码仍可辨。公开可读的路径不止 raw 一条，GitHub 每个 tag 还自动生成源码包：
 *   https://raw.githubusercontent.com/Adsryen/ConfScope/<tag>/.github/assets/<图名>
 *   https://github.com/Adsryen/ConfScope/archive/refs/tags/<tag>.{zip,tar.gz}
 * 轮59 已经把 main 上的图换成 retest 合成数据重拍，但**没有任何内容级判据**：
 * 谁 `git checkout v1.9.2 -- .github/assets/配置浏览.png` 把旧图捞回来、或者手工换一张
 * 真环境图进名册，仓库都会照单收下，公开仓库首屏再次变成泄露贴。
 *
 * 所以这里钉四条，全部是「静态可判、不需要跑浏览器」的：
 *   1. 名册双向对齐：磁盘上每张图必须在已人工复核的名册里且 md5 逐位一致；名册里也不许留
 *      磁盘上已不存在的条目。换图必须重跑取证脚本、肉眼看、在同一个提交里改名册——
 *      md5 一致这条就是「看过的那张 == 发出去的那张」的唯一凭据。
 *   2. 泄露 blob 黑名单：命中即红。黑名单只存 md5 与一句说明，**绝不把凭据原文写进仓库**，
 *      否则闸门本身变成第二次泄露。
 *   3. 截图结构与元数据：PNG 魔数、1920×1080、非零字节；不得带 `tEXt/iTXt/zTXt` 块——
 *      截图工具常把本机绝对路径与用户名写进这些块里，图内容打码了、元数据里躺着
 *      `C:\Users\<真人>\...` 是同一类事故。
 *   4. 文档面凭据形态：README / CHANGELOG / docs / .github 里的 markdown 不得出现
 *      明文密码赋值、带凭据的连接串、真实内网 IP。写文档时最容易顺手把「报错原文」整段贴进去。
 *
 * 口径细节（都是实测出来的坑）：
 * - 名册按**文件名**索引，图名同时被 README 引用与取证脚本 `shoot()` 声明（轮59 那条守卫
 *   负责双向），这里只管内容，两条各管一段，别混。
 * - md5 只用于「同一份字节」的比对，不是安全散列；这里要的是可复核的指纹，不是抗碰撞。
 * - 第 4 条的假阳性控制靠占位词表：`example` / `retest` / `<密码>` 这类形态一律放行，
 *   否则文档里连「password: <你的密码>」都不能写，闸门会被绕过式地关掉。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./scanUtils";

const ASSET_DIR = join(PROJECT_ROOT, ".github/assets");

/** 取证脚本产出的标准尺寸（1920 视口 × 1080，见 tests/retest/shots/playwright.config.ts）。 */
const SHOT_WIDTH = 1920;
const SHOT_HEIGHT = 1080;

type ReviewedCapture = { md5: string; note: string };

/**
 * 已人工逐张复核过的公开截图：内容全部来自 retest 合成数据集。
 * 换图的正路：`npx playwright test -c tests/retest/shots/playwright.config.ts`
 * → 肉眼看 `shots/out/` → 拷进 `.github/assets/` → 在同一个提交里更新这里的 md5。
 */
const REVIEWED_CAPTURES: Record<string, ReviewedCapture> = {
  "配置浏览.png": {
    md5: "e34050f48681ffb7caa7a787d1e3e583",
    note: "Retest Project / Development / retest-dev，正文是 svc-legacy-prod.yaml 合成配置",
  },
  "配置浏览-文内查找.png": {
    md5: "bcd4ee5adbc84276689f3e64dc82ac30",
    note: "同一合成数据上 Ctrl+F 命中 module 5 处",
  },
  "配置浏览-内容搜索.png": {
    md5: "0005d8d4aa97b7f1efec5281b0241f66",
    note: "跨配置搜 8080，命中项 svc-gateway.yaml",
  },
  "配置对比.png": {
    md5: "0fca31f51fd7ff2f814c4053d948399c",
    note: "Retest Nacos A/B 两侧 svc-auth.json，域名是 auth.dev.example.com",
  },
  "配置矩阵.png": {
    md5: "f14cb3f576d6f845e46964257bf4cc98",
    note: "retest-dev / retest-qa 一致性矩阵，命名空间为合成名",
  },
};

/**
 * 历史上真实泄露过的图字节（按 tag 树取 blob 实测）。**只许增不许减**：
 * 这些 blob 在旧 tag 上仍然公开可读，闸门要挡的是「同一份字节再进仓库」。
 * 处置过程与公开 URL 全表见 docs/security/public-screenshot-exposure-2026-10.md。
 */
const LEAKED_BLOBS: Record<string, string> = {
  "0cc2fb179992ae837557dce88f8e3e31": "旧「配置浏览」真环境截图：明文 redis 密码",
  "4a06cadebaaa9b9b75d1f2432cb7a869": "旧「配置对比」真环境截图：redis 密码与 mongodb 带账号连接串、内网 IP",
  "5a2609b44fdfa9627f839ec9fc23cd8e": "旧「配置矩阵」真环境截图：真实命名空间 UUID 与租户名",
  de943c20df2c1f03e581e30d2b0412f4: "v1.0.0 的 page-1.png：真环境配置正文（部分打码）",
  "6d58d86470926338af2537f9f0a64ad7": "v1.1.0/v1.2.0 的 page-1.png：真环境 dataId、命名空间与租户名",
};

/** 第 4 条的扫描范围：会公开发布的 markdown。源码与测试夹具不在内（里面全是合成假凭据）。 */
const DOC_SCOPES = ["README.md", "CHANGELOG.md", "docs", ".github"];

/** 凭据形态 → 判据。命中且不像占位就红。 */
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "明文密码赋值", re: /\b(?:password|passwd|pwd|secret|token)\s*[:=]\s*["']?([^\s"',;)]{8,})/gi },
  { label: "带凭据的连接串", re: /\b[a-z][a-z0-9+.-]*:\/\/([^/\s:@]+):([^/\s@]{4,})@/gi },
  { label: "真实内网 IP", re: /\b(?:192\.168|172\.(?:1[6-9]|2\d|3[01])|10)\.\d{1,3}\.\d{1,3}\b/g },
];

/**
 * 占位与合成数据形态：文档里本来就该能写这些，否则闸门会被要求关掉。
 * 两类：① 一眼假的词（example / retest / <你的密码> / ****）；
 * ② 本项目夹具的命名约定——`nacos-secret`、`dav-secret` 这种「以凭据类型结尾的短横线名」，
 *    见 docs/superpowers/plans/2026-07-08-local-data-migration-guardrails.md 里的测试样例。
 */
const PLACEHOLDER =
  /(example|retest|demo|sample|fixture|test|changeme|your[-_]|placeholder|dummy|fake|mock|<[^>]*>|\*{3,}|x{4,})|[-_](?:secret|token|passwd|password|credential|apikey|api_key|key|pwd)$/i;

function md5Of(file: string): string {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

function listFilesRecursive(root: string): string[] {
  const st = statSync(root);
  if (st.isFile()) return [root];
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const child = statSync(full);
    if (child.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function scopeFiles(): string[] {
  return DOC_SCOPES.map((rel) => join(PROJECT_ROOT, rel))
    .filter(existsSync)
    .flatMap(listFilesRecursive)
    .filter((f) => f.endsWith(".md"));
}

function pngChunks(buf: Buffer): Array<{ type: string; data: string }> {
  const out: Array<{ type: string; data: string }> = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const body = buf.subarray(i + 8, i + 8 + len);
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      out.push({ type, data: body.toString("latin1").replace(/\0/g, "|").slice(0, 120) });
    }
    if (type === "IEND") break;
    i += 12 + len;
  }
  return out;
}

function assetFiles(): string[] {
  if (!existsSync(ASSET_DIR)) return [];
  return readdirSync(ASSET_DIR)
    .filter((n) => /\.(png|jpe?g|webp|gif)$/i.test(n))
    .sort();
}

/** 仓库里可能被再次提交的图片位置（不含 node_modules / dist / shots 中间产物）。 */
function imageFilesInRepo(): string[] {
  const dirs = [".github/assets", "public", "build"];
  return dirs
    .map((d) => join(PROJECT_ROOT, d))
    .filter(existsSync)
    .flatMap(listFilesRecursive)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
}

describe("公开截图必须在已复核名册里且字节逐位一致", () => {
  it("磁盘上的每张图都在名册里，md5 与名册一致", () => {
    const files = assetFiles();
    expect(files.length, ".github/assets 下一张图都没有，取证链路断了").toBeGreaterThan(0);
    const problems: string[] = [];
    for (const name of files) {
      const reviewed = REVIEWED_CAPTURES[name];
      const actual = md5Of(join(ASSET_DIR, name));
      if (!reviewed) {
        problems.push(`${name} 不在名册里（实际 ${actual}）——手工塞图正是当年泄露的入口`);
      } else if (reviewed.md5 !== actual) {
        problems.push(`${name} 字节变了：名册 ${reviewed.md5} / 实际 ${actual}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("名册不留磁盘上已不存在的条目（基线只减不增）", () => {
    const present = new Set(assetFiles());
    const stale = Object.keys(REVIEWED_CAPTURES).filter((n) => !present.has(n));
    expect(stale, `名册里有磁盘上不存在的图：${stale.join(", ")}`).toEqual([]);
  });
});

describe("泄露过的图字节永远不得再进仓库", () => {
  it("仓库内任何图片都不等于历史泄露 blob", () => {
    const hits = imageFilesInRepo()
      .map((f) => ({ rel: f.slice(PROJECT_ROOT.length + 1), md5: md5Of(f) }))
      .filter((x) => LEAKED_BLOBS[x.md5])
      .map((x) => `${x.rel} == ${x.md5}（${LEAKED_BLOBS[x.md5]}）`);
    expect(hits, `泄露过的截图被捞回来了：\n${hits.join("\n")}`).toEqual([]);
  });

  it("黑名单条目本身有说明且不少于历史实测的五条", () => {
    const entries = Object.entries(LEAKED_BLOBS);
    expect(entries.length, "泄露 blob 只许增不许减").toBeGreaterThanOrEqual(5);
    for (const [md5, why] of entries) {
      expect(md5, "黑名单键必须是完整 32 位 md5，截短的比对不到").toMatch(/^[0-9a-f]{32}$/);
      expect(why.length, `${md5} 缺一句「这张图泄露了什么」`).toBeGreaterThan(8);
    }
  });
});

describe("截图结构与元数据", () => {
  it("每张图都是非零字节的合法 PNG，尺寸 1920×1080", () => {
    for (const name of assetFiles()) {
      const buf = readFileSync(join(ASSET_DIR, name));
      expect(buf.length, `${name} 是 0 字节：图裂在公开首屏上没人会发现`).toBeGreaterThan(0);
      expect(buf.subarray(0, 8).toString("hex"), `${name} 不是 PNG`).toBe("89504e470d0a1a0a");
      const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      expect(`${w}x${h}`, `${name} 尺寸与取证视口不符`).toBe(`${SHOT_WIDTH}x${SHOT_HEIGHT}`);
    }
  });

  it("不得携带 tEXt/iTXt/zTXt 元数据块", () => {
    const leaks = assetFiles()
      .map((name) => ({ name, chunks: pngChunks(readFileSync(join(ASSET_DIR, name))) }))
      .filter((x) => x.chunks.length > 0)
      .map((x) => `${x.name}: ${x.chunks.map((c) => `${c.type}=${c.data}`).join(" ")}`);
    expect(leaks, `截图元数据里可能带本机路径或用户名：\n${leaks.join("\n")}`).toEqual([]);
  });
});

describe("文档面不得出现凭据形态", () => {
  it("扫描范围解析得到 markdown（解析不到说明目录改名，守卫要跟着改）", () => {
    expect(scopeFiles().length).toBeGreaterThan(3);
  });

  it("README / CHANGELOG / docs / .github 里没有明文密码、带凭据连接串或真实内网 IP", () => {
    const problems: string[] = [];
    for (const file of scopeFiles()) {
      const rel = file.slice(PROJECT_ROOT.length + 1);
      const text = readFileSync(file, "utf-8");
      for (const { label, re } of SECRET_PATTERNS) {
        for (const m of text.matchAll(re)) {
          const value = m[2] ?? m[1] ?? m[0];
          if (PLACEHOLDER.test(value) || PLACEHOLDER.test(m[0])) continue;
          const line = text.slice(0, m.index ?? 0).split("\n").length;
          problems.push(`${rel}:${line} ${label} -> ${value.slice(0, 40)}`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
