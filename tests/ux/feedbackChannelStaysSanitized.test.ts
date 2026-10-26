/**
 * 反馈通道的脱敏闸门（轮80）。
 *
 * 为什么要静态守，而不是只靠单测：这条链路的输出会被用户原样粘进**公开** Issue。
 * 一次泄露不是「这次显示错了」，是永久留在 GitHub 与每个 tag 的源码包里——
 * 与 tests/ux/publicScreenshotsStaySanitized.test.ts 守的是同一类事故，只是那条管图，这条管文本。
 *
 * 事故会长回来的三个具体形状（都对应下面一条断言）：
 * 1. 有人往 Go 的 FeedbackDiagnostics 上「顺手加一个字段」——数据根路径里躺着 Windows 用户名，
 *    连接名与命名空间能直接定位到客户的生产环境。加字段这一步必须当场变红，所以判据写成
 *    **白名单**（恰好这 5 个），不是黑名单（列不全泄露面）。
 * 2. 有人在排版层里自己去取 locale 或读 store：`localStorage.getItem("locale")` 看着无害，
 *    真意是「这一层开始自己拿事实」，下一步就会去拿数据根。排版层只许有参数进来的事实。
 * 3. 有人把「点反馈顺手复制环境信息」加回来：那会盖掉用户正在复制的内容且毫无提示，
 *    所以剪贴板只许由用户明确点下的 CopyButton 动，About.tsx 里不许出现 copyText。
 *
 * 口径细节：全部读 readScannedSource（注释已抹平）——本文件与守卫对象里的注释都写着一堆
 * 被禁的名字（`dataDir`、「数据根路径」），不抹注释的话守卫会把自己判红。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LAYOUT = "src/lib/feedbackDiagnostics.ts";
const ABOUT = "src/components/About.tsx";
const GO_APP = "internal/app/app.go";

/** 允许出现在公开 Issue 里的全部事实——顺序即输出顺序。 */
const ALLOWED_FACTS = ["version", "platform", "runtimeMode", "packageFormat", "assetName"];

describe("反馈排版层只认参数进来的事实", () => {
  it("不 import 任何东西：事实只能由调用方传进来", () => {
    const source = readScannedSource(LAYOUT);
    expect(source, "feedbackDiagnostics.ts 出现了 import，排版层开始自己拿事实了").not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it("不碰 store / i18n / localStorage：取 locale 也只许从参数来", () => {
    const source = readScannedSource(LAYOUT);
    for (const forbidden of ["../store/", "../api/", "../i18n", "useTranslation", "localStorage", "window."]) {
      expect(source, `feedbackDiagnostics.ts 里出现了 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("FeedbackFacts 的字段恰好是白名单那 5 项（加字段=开泄露口子，必须当场红）", () => {
    const block = /export interface FeedbackFacts \{([\s\S]*?)\n\}/.exec(readScannedSource(LAYOUT));
    expect(block, "读不到 FeedbackFacts 定义").not.toBeNull();
    const fields = Array.from(block![1].matchAll(/^\s*(\w+):/gm), (m) => m[1]);
    expect(fields.sort()).toEqual([...ALLOWED_FACTS].sort());
  });

  it("行标签是固定英文：维护者只认一套形状，中文标签等于第二套判据", () => {
    const labels = Array.from(readScannedSource(LAYOUT).matchAll(/- ([^:]+):/g), (m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (const label of labels) {
      expect(label, `标签「${label}」不是固定英文`).toMatch(/^[A-Za-z][A-Za-z ]*$/);
    }
  });
});

describe("Go 侧事实源只许给这 5 项", () => {
  const go = readScannedSource(GO_APP);

  it("FeedbackDiagnostics 的 json tag 恰好是白名单那 5 项", () => {
    const body = /type FeedbackDiagnostics struct \{([\s\S]*?)\n\}/.exec(go);
    expect(body, "读不到 internal/app 的 FeedbackDiagnostics").not.toBeNull();
    const tags = Array.from(body![1].matchAll(/json:"([^",]+)/g), (m) => m[1]);
    expect(tags.sort()).toEqual([...ALLOWED_FACTS].sort());
  });

  it("出口函数只取形态判据，不读数据根、不读连接表、不读日志", () => {
    const body = /func \(a \*App\) GetFeedbackDiagnostics\(\)[\s\S]*?\n\}/.exec(go);
    expect(body, "读不到 GetFeedbackDiagnostics").not.toBeNull();
    for (const forbidden of ["dataDir", "DataDir", "Getenv", "connections", "namespace", "logPath", "ReadFile"]) {
      expect(body![0], `GetFeedbackDiagnostics 里出现了 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("About 页的两个出口只喂脱敏事实", () => {
  const about = readScannedSource(ABOUT);

  it("复制只由用户明确点下的 CopyButton 触发，页面自己不许动剪贴板", () => {
    expect(about, "About.tsx 出现 copyText：又要变成「点反馈顺手覆盖用户剪贴板」").not.toMatch(/\bcopyText\s*\(/);
    expect(about).not.toContain('"../lib/clipboard"');
    expect(about, "复制环境信息必须用唯一出口的 CopyButton").toContain("<CopyButton text={feedbackEnvBlock}");
  });

  it("两个出口的喂料被钉死成那两个变量，不接受别的事实", () => {
    expect(about).toContain("buildFeedbackEnvironment(feedbackFacts, locale)");
    expect(about, "Issue 链接的 href 必须来自 feedbackIssueUrl").toContain("<ExternalLink href={feedbackIssueUrl}");
  });

  it("About 里的 GitHub 外链只认白名单：不许别人的仓库，也不许退回裸 issues 页", () => {
    // 抓**所有**字面量 github 地址（不只是 <ExternalLink href="…">），否则有人把地址挪进
    // const url = "https://github.com/someone-else/repo/issues" 再喂给 href= 就绕过了这条。
    // 作者主页 https://github.com/Adsryen 在 about-footer 里是合法外链，它不是 Issue 出口，
    // 一起进白名单——不列进来的话守卫会把自己需要的东西判红（轮80 实测踩过）。
    const WHITELIST = [
      "https://github.com/Adsryen",
      "https://github.com/Adsryen/ConfScope",
      "https://github.com/Adsryen/ConfScope/releases",
    ];
    const hrefs = Array.from(about.matchAll(/https:\/\/github\.com\/[^"'`\s)<>]+/g), (m) => m[0]);
    expect(hrefs.length, "一个 GitHub 外链都扫不到：判据失效了").toBeGreaterThanOrEqual(2);
    for (const href of hrefs) {
      expect(href, `硬编码外链 ${href} 指向 issues 页：反馈必须走预填正文的 /issues/new`).not.toContain("/issues");
      expect(WHITELIST, `硬编码外链 ${href} 不在白名单里`).toContain(href);
    }
  });

  it("排版函数的调用点全站只有一处，省得第二份各自抄、各自漏", () => {
    // 判据是全站源码扫描，不是「我记得只有 About 用」。第二个调用点等于第二个脱敏口径，
    // 而脱敏口径只有一份被守在这里——抄走的那份不会自动跟上白名单的变化。
    const callers = (fn: string) => sourceFiles().filter((rel) => rel !== LAYOUT && readScannedSource(rel).includes(`${fn}(`));
    for (const fn of ["buildFeedbackEnvironment", "buildNewIssueURL"]) {
      expect(callers(fn), `${fn} 出现了 ${ABOUT} 之外的调用点`).toEqual([ABOUT]);
    }
  });
});
