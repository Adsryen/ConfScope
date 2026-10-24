/**
 * README 必须与仓库现实对齐（轮59）。
 *
 * 起因：README.md 停在 2026-07-15、三张界面截图停在 2026-07-03，半年里加的行号、命中词标红、
 * 缩略图、Ctrl+F 查找、批量对比跨项内容搜索一条都没写；文字里还留着「localStorage 本地持久化」
 * （主数据早已迁到 app-data/confscope-data.json）和 Go >= 1.22（go.mod 是 1.25.0）。
 * 更要紧的是旧截图是**人手工截的真实环境**：明文 redis 密码、mongodb 连接串、192.168 内网 IP
 * 直接挂在公开仓库首屏。
 *
 * 所以这里钉四件事：
 *   1. README 引用的本地文件必须存在（图裂了、链接指空都算红）；
 *   2. 界面截图必须由 tests/retest/shots/ 的取证脚本产出，且双向对齐——README 用到的每张图都要
 *      有对应的 shoot()，脚本产出的每张图都必须被 README 引用（防「手工塞一张真环境截图」这条
 *      根因回潮，也防留下没人看的产物）；
 *   3. 版本号只能有一份事实源：Go / Wails 取自 go.mod，pnpm 取自 package.json 的 packageManager，
 *      Node 取自 release.yml 的 setup-node；取 README 里的**全部**出现处逐一对齐，
 *      只判「某处出现过正确版本」不够——同一版本写两处，改掉一处照样绿；
 *   4. 发布产物名必须能在 release.yml 里找到，不能凭印象写。
 *
 * 另加一条过期口径不得回潮。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./scanUtils";

const readme = readFileSync(join(PROJECT_ROOT, "README.md"), "utf-8");
const goMod = readFileSync(join(PROJECT_ROOT, "go.mod"), "utf-8");
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as {
  packageManager?: string;
};
const workflow = readFileSync(join(PROJECT_ROOT, ".github/workflows/release.yml"), "utf-8");
const shotsSpec = readFileSync(join(PROJECT_ROOT, "tests/retest/shots/readmeShots.spec.ts"), "utf-8");

/** README 里的相对引用（img src、a href 与 markdown 链接），去掉锚点与外链。 */
function localRefs(text: string): string[] {
  const raw = [
    ...[...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
  ];
  return raw
    .map((ref) => ref.split("#")[0])
    .filter((ref) => ref.length > 0 && !/^(https?:|mailto:)/.test(ref));
}

/** 取证脚本里 shoot(page, "<name>") 产出的图名（不含扩展名）。 */
function shotNames(text: string): string[] {
  return [...text.matchAll(/shoot\(page,\s*"([^"]+)"\)/g)].map((m) => m[1]);
}

describe("README 引用的本地文件必须存在", () => {
  it("图片与文档链接都指得到实体文件", () => {
    const refs = [...new Set(localRefs(readme))];
    expect(refs.length, "README 一条本地引用都没抽到，多半是引用写法改了").toBeGreaterThan(0);
    const missing = refs.filter((ref) => !existsSync(join(PROJECT_ROOT, ref)));
    expect(missing, `README 引用了不存在的文件：${missing.join(", ")}`).toEqual([]);
  });

  it("界面预览确实引用了 .github/assets 下的截图", () => {
    const assets = localRefs(readme).filter((ref) => ref.startsWith(".github/assets/"));
    expect(assets.length).toBeGreaterThanOrEqual(3);
  });
});

describe("界面截图必须由取证脚本产出（双向对齐）", () => {
  const produced = shotNames(shotsSpec);
  const referenced = localRefs(readme)
    .filter((ref) => ref.startsWith(".github/assets/"))
    .map((ref) => ref.replace(/^\.github\/assets\//, "").replace(/\.png$/, ""));

  it("取证脚本声明了产出的图", () => {
    expect(produced.length).toBeGreaterThanOrEqual(3);
  });

  it("README 用到的每张图都能由脚本重跑出来，而不是手工截的", () => {
    const handmade = referenced.filter((name) => !produced.includes(name));
    expect(
      handmade,
      `这些截图没有取证脚本兜着，只能手工截（手工截极易带进真实环境数据）：${handmade.join(", ")}`
    ).toEqual([]);
  });

  it("脚本产出的每张图都被 README 引用，不留没人看的产物", () => {
    const orphan = produced.filter((name) => !referenced.includes(name));
    expect(orphan, `取证脚本产出了 README 没用到的图：${orphan.join(", ")}`).toEqual([]);
  });
});

describe("README 的版本口径与工程文件同源", () => {
  const goVersion = /(^|\n)go (\d+\.\d+)/.exec(goMod)?.[2];
  const wailsVersion = /github\.com\/wailsapp\/wails\/v2 (v\d+\.\d+)/.exec(goMod)?.[1];
  const pnpmMajor = /^pnpm@(\d+)/.exec(pkg.packageManager ?? "")?.[1];
  const nodeVersion = /node-version:\s*["']?(\d+)/.exec(workflow)?.[1];

  it("解析得到四组版本号（解析不到说明上游格式变了，守卫要跟着改）", () => {
    expect(goVersion, "go.mod 的 go 指令").toBeTruthy();
    expect(wailsVersion, "go.mod 的 wails v2 版本").toBeTruthy();
    expect(pnpmMajor, "package.json 的 packageManager").toBeTruthy();
    expect(nodeVersion, "release.yml 的 setup-node node-version").toBeTruthy();
  });

  /** 取 README 里某类版本的全部出现处，必须只剩期望的那一个写法。 */
  function mentionsAreAll(label: string, pattern: RegExp, expected: string | undefined): void {
    const found = [...readme.matchAll(pattern)].map((m) => m[1]);
    expect(found.length, `README 里一处 ${label} 版本都没写`).toBeGreaterThan(0);
    expect([...new Set(found)], `README 里 ${label} 的版本写法`).toEqual([expected]);
  }

  it("Go / Wails / Node 每一处都等于事实源", () => {
    mentionsAreAll("Go", /(?:^|[\s>(`])Go (v?\d+\.\d+)/g, goVersion);
    mentionsAreAll("Wails", /(?:^|[\s>(`])Wails (?:CLI )?(v\d+\.\d+)/g, wailsVersion);
    mentionsAreAll("Node", /(?:^|[\s>(`])Node\.js (\d+)/g, nodeVersion);
  });

  // README 允许写大版本（pnpm 10）或完整版本（pnpm 10.33.2），两种都必须落在 packageManager 上；
  // 单独拆出来是因为通用 helper 只能比字符串全等，这里要做「前缀也算对」的宽松匹配。
  it("pnpm 每一处都等于 packageManager 的事实源", () => {
    const found = [...readme.matchAll(/(?:^|[\s>(`])pnpm[ @]*(\d+(?:\.\d+){0,2})/g)].map((m) => m[1]);
    expect(found.length, "README 里一处 pnpm 版本都没写").toBeGreaterThan(0);
    for (const mention of [...new Set(found)]) {
      const exact = pkg.packageManager === `pnpm@${mention}`;
      expect(
        mention === pnpmMajor || exact,
        `README 里的 pnpm ${mention} 既不是 packageManager 的大版本 ${pnpmMajor}，也不等于完整版本 ${pkg.packageManager}`
      ).toBe(true);
    }
  });
});

describe("发布产物名与 release.yml 一致", () => {
  it("README 提到的每个资产名都在 workflow 里出现", () => {
    const assets = [
      "confscope-windows-amd64-portable.exe",
      // 轮62：安装版是 Windows 的推荐形态，产物名跟着 update.json 的 windows-amd64-installer 条目
      "confscope-windows-amd64-installer.exe",
      "confscope-linux-amd64.tar.gz",
      "confscope-linux-amd64.deb",
      "confscope-linux-amd64.rpm",
      "confscope-macos-arm64.dmg",
      "confscope-macos-amd64.dmg",
    ];
    for (const asset of assets) {
      expect(readme, `README 少了产物 ${asset}`).toContain(asset);
      expect(workflow, `release.yml 里没有 ${asset}`).toContain(asset);
    }
  });
});

describe("过期口径不得回潮", () => {
  it("主数据口径已经不是 localStorage，README 不得再把它写成持久化主语", () => {
    expect(readme).toContain("app-data/confscope-data.json");
    expect(readme).not.toContain("localStorage 本地持久化");
  });

  it("开发链路分平台，不得只留 Windows 那一条命令", () => {
    expect(readme).toContain("dev-portable-data.ps1");
    expect(readme).toContain("build-latest.sh");
    expect(readme).toContain("CONFSCOPE_DATA_DIR");
  });
});
