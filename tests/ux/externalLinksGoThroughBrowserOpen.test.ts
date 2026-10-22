/**
 * 外链只认一个出口（轮17 波41 R66）。
 *
 * 扫出来的真 bug：桌面 webview 里 `window.open` / `target="_blank"` 开不出任何窗口——
 * Wails v2.13 的运行时脚本只有 `BrowserOpenURL(url) → window.WailsInvoke('BO:'+url)`，
 * 整包搜不到 NewWindowRequested，也不拦 window.open，于是关于页 4 个外链「点了没反应」。
 * 修法是把开链接这件事收进 `src/lib/externalLink.ts` + `<ExternalLink>`，
 * 这条守卫负责挡住三种回潮：
 * 1) 有人重新写裸 `window.open` / 裸 `target="_blank"`（桌面端等于写了个死按钮）；
 * 2) 有人把 scheme 白名单放宽到 `javascript:` / `data:`（等于把 XSS 入口交回给用户）；
 * 3) 有人删掉兜底文案，让失败重新变回静默。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

/** URL 打开的实现体，白名单与两种投递方式都住在这里。 */
const IMPLEMENTATION = "src/lib/externalLink.ts";
/** JSX 侧的唯一出口。 */
const COMPONENT = "src/components/ExternalLink.tsx";
/** 外链协议白名单，只许减不许加；这三个是「交给系统浏览器」安全的前提。 */
const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:"];
const PROTOCOLS_DECL = /EXTERNAL_URL_PROTOCOLS\s*=\s*\[([^\]]*)\]/;
/** 裸的新窗口写法：属性形式与 API 形式都要挡。 */
const BARE_WINDOW_OPEN = /\bwindow\.open\s*\(/g;
const BARE_TARGET_BLANK = /target="_blank"/g;
const RAW_ANCHOR = /<a(?=[\s/>])/g;
const DELEGATED_OPEN = /\bopenExternalLink\s*\(/g;
const DELEGATED_URL = /\bopenExternalUrl\s*\(/g;
const COMPONENT_USE = /<ExternalLink[\s/>]/g;
/** 兜底提示用到的文案 key，缺一个就退化成「点了没反应」。 */
const FALLBACK_KEYS = ["common.linkUnsafe", "common.openLinkCopied", "common.copyFailed"];

function occurrences(re: RegExp, source: string): number[] {
  const hits: number[] = [];
  for (const m of source.matchAll(re)) hits.push(m.index ?? 0);
  return hits;
}

function report(file: string, source: string, at: number): string {
  const line = source.slice(0, at).split("\n").length;
  return `${file}:${line}: ${source.split("\n")[line - 1].trim().slice(0, 110)}`;
}

function scan(re: RegExp, exclude?: string[]): string[] {
  const violations: string[] = [];
  for (const file of sourceFiles()) {
    if (exclude?.includes(file)) continue;
    const source = readScannedSource(file);
    for (const at of occurrences(re, source)) violations.push(report(file, source, at));
  }
  return violations;
}

describe("外链走系统浏览器的单一出口（波41 R66）", () => {
  it("除实现体外，src/ 里不许出现裸 window.open", () => {
    expect(scan(BARE_WINDOW_OPEN, [IMPLEMENTATION])).toEqual([]);
  });

  it('除 <ExternalLink> 之外，src/ 里不许出现裸 target="_blank"', () => {
    expect(scan(BARE_TARGET_BLANK, [COMPONENT])).toEqual([]);
  });

  it("除 <ExternalLink> 之外，src/ 里不许再有裸 <a> 标签", () => {
    expect(scan(RAW_ANCHOR, [COMPONENT])).toEqual([]);
  });

  it("scheme 白名单就是 http/https/mailto，一个不多一个不少", () => {
    const source = readScannedSource(IMPLEMENTATION);
    const found = PROTOCOLS_DECL.exec(source);
    expect(found, "EXTERNAL_URL_PROTOCOLS 声明被删了").toBeTruthy();
    const listed = Array.from((found?.[1] ?? "").matchAll(/"([^"]+)"/g), (m) => m[1]);
    expect(listed.sort()).toEqual([...ALLOWED_PROTOCOLS].sort());
    for (const dangerous of ["javascript:", "data:", "file:", "ftp:", "vbscript:"]) {
      expect(listed, `白名单里出现了 ${dangerous}`).not.toContain(dangerous);
    }
  });

  it("<ExternalLink> 必须 preventDefault 后交给 helper，同时把 href/target/rel 留在 DOM 上", () => {
    const source = readScannedSource(COMPONENT);
    expect(source).toMatch(/e\.preventDefault\(\)/);
    expect(source).toMatch(/openExternalLink\s*\(\s*e\.currentTarget\.href\s*\)/);
    expect(source).toMatch(/href=\{href\}/);
    expect(source).toMatch(/target="_blank"/);
    expect(source).toMatch(/rel="noopener noreferrer"/);
  });

  it("实现体两条投递路径都在：先运行时、后 window.open，且都过归一化", () => {
    const source = readScannedSource(IMPLEMENTATION);
    expect(source).toMatch(/runtime\?\.BrowserOpenURL/); // 桌面端投递路径
    expect(source).toMatch(/\.open\?\.\(|window\.open/);
    expect(source).toMatch(/normalizeExternalUrl\(/);
    // 打不开时必须复制到剪贴板，否则又回到静默失败
    expect(source).toMatch(/copyText\(/);
    expect(source).toMatch(/toast\(/);
  });

  it("兜底文案 key 在 zh / en 两份 locale 里都存在且非空", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      for (const key of FALLBACK_KEYS) {
        expect(flat[key], `${file} 缺少 ${key}`).toBeTruthy();
      }
    }
  });

  it("委托调用点不许空转：helper 至少被 2 处使用，<ExternalLink> 至少 3 处", () => {
    let delegated = 0;
    let urls = 0;
    let uses = 0;
    for (const file of sourceFiles()) {
      if (file === IMPLEMENTATION) continue;
      const source = readScannedSource(file);
      delegated += occurrences(DELEGATED_OPEN, source).length;
      urls += occurrences(DELEGATED_URL, source).length;
      uses += occurrences(COMPONENT_USE, source).length;
    }
    expect(delegated + urls).toBeGreaterThanOrEqual(2);
    expect(uses).toBeGreaterThanOrEqual(3);
  });

  it("关于页的 4 个外链站点仍然走出口（下载页 + GitHub + 反馈 + 作者）", () => {
    const source = readScannedSource("src/components/About.tsx");
    // 命令式那处（下载页/Release 页）只钉「确实走出口且只有一处」，不钉变量名：
    // 轮62 起它是 releasePageUrl，上一版把 url 写进判据里，改个局部变量名就能让它自红。
    expect(occurrences(/\bvoid openExternalLink\(/g, source).length, "关于页的命令式外链必须走 openExternalLink 出口").toBe(1);
    expect(occurrences(COMPONENT_USE, source).length).toBe(3);
  });
});
