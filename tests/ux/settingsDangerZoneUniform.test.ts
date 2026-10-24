/**
 * 设置页的「危险操作 / 代理提交 / 说明落点」各只许一种长相（轮72B R-B1..R-B6、R-B9）。
 *
 * 这一族的缺陷都不是「报错」，而是**界面在说谎或装作没事**，fireEvent 永远点得到、
 * 渲染也不报错，只能静态钉：
 * - R-B1 清理缓存失败原先只渲染一句「清理缓存失败」，catch 把异常整个丢掉。这条失败十有八九
 *   是文件权限或磁盘，用户既不知道被什么拦住，也没法把那句话抄给别人。
 * - R-B2 三个代理框每次按键把草稿直写 `cs.settings`，不 trim 不校验；真机打进
 *   `   not-a-url   ` 落库成功、屏幕上一片正常，而 Go 侧 `proxyFunc` 从此静默走不上代理。
 *   三个框还共用同一条 placeholder——示例本身就是 Go 认不得的写法。
 * - R-B3 同为不可逆删除，三行的长相各不相同（一行红底卡片、一行普通行、一行带 h5 的），
 *   而 `.settings-danger-zone h5` 早就没有命中对象，成了死规则。
 * - R-B4 对比节只有 16px 的方框能按，点整行标题什么都不发生；把说明文字塞进 `<label>`
 *   会让整句说明书变成复选框的可访问名（读屏每按一次念一遍）。
 * - R-B5 备份节最该抄走的主数据文件路径反而是唯一没有复制键的位置。
 * - R-B6 检查更新的整套动作在关于页只有一份实现，设置页却只读不回，用户看完
 *   「上次检查：三天前」得自己回想那页在哪儿。
 * - R-B9 「连接下拉按名称排序」是个空开关：设置存了值，对比页的来源选择器根本没读它。
 *
 * 变异对照（每一种都实测过判红，别改成「看着像」）：
 * 1. 把清理缓存的渲染退回裸 `<div className="inline-error" role="alert">一句短话</div>`
 *    → `shouldRenderCacheFailureViaInlineError` 红；同时在 short-hint 登记表加回这条
 *    → `cacheFailureIsNoLongerRegisteredAsShortHint` 红。
 * 2. 代理框退回 `onChange={(e) => update({ proxy: ... })}` → `proxyCommitGoesThroughTheLib` 红。
 * 3. 把 PROXY_PLACEHOLDERS 三格改成同一个值 → `placeholder` 互不相同那条红。
 * 4. 危险行少一处复合类、或某颗按钮退回 `btn btn-ghost`（丢掉 btn-danger）→ 计数红。
 * 5. 把 `<div className="field-hint">` 挪进可点 label 内部 → hint 必须在 label 外那条红。
 * 6. 删掉 `orderedSourceConnections` 的三元（恒排序或不排序）、或某处调用漏传 prop → R-B9 三条红。
 * 7. 把恢复提醒那条 `toast()` 删掉、或把 `onClick={onOpenAbout}` 换成设置页自己调 `checkForUpdates`
 *    → R-B6 红（同一套检查/下载/安装动作在关于页只有一份实现，出口是 api/app）。
 * 8. 把 styles.css 的 `.field-error` 基础规则改名 → 行首锚定那条红。这条必须锚行首：
 *    `.field-error-box .field-error {` 里也含 `.field-error {` 这段字面量，不锚就假绿（实测过）。
 * 9. 可点行把 `:hover` 改成别的伪类（只有按下才有反馈）→ R-B4 样式那条红。
 * 10. 轮74 C2：把「恢复此备份」写回 `btn-primary`、或把「预览本地备份」写成主色 → 备份节权重那条红。
 *     判的是「一整片蓝里读不出哪一步会动现有数据」：主色只留给提交动作，预览降到次要档。
 * 11. 轮74 D2：把 App 的 `onOpenAbout` 改回 `() => setMode("about")`（丢掉到达标记）→ R-B6 红。
 *     到达高亮自身的判据在 tests/ux/arrivalHighlightSingleSource.test.ts。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const SETTINGS = "src/components/SettingsView.tsx";
const STYLES = "src/styles.css";
const DIFFVIEW = "src/components/DiffView.tsx";
const BACKUP_PANEL = "src/components/AppDataBackupPanel.tsx";
const APP = "src/App.tsx";
const SHORT_HINT_GUARD = "tests/ux/inlineErrorSingleSource.test.ts";

/** 三颗不可逆删除：清空本地历史 / 清除本机版本历史 / 清理缓存。 */
const DANGER_KEYS = ["settings.clearLocalHistory", "settings.clearRevisions", "settings.clearCache"];
/** 轮72B 从 locales 里清掉的死键：不许有人只加引用不加文案，也不许只把文案加回来。 */
const RETIRED_KEYS = [
  "settings.groupAuth",
  "settings.groupSecurity",
  "settings.groupAdvanced",
  "settings.localData",
  "settings.localDataDescription",
  "settings.networkProxy",
  "settings.authPerConnection",
  "settings.securityPerConnection",
];
/** 轮72B 新增的说明/报错键：中英文都得有，且源码里真的渲染了。 */
const NEW_COPY_KEYS = [
  "settings.compareSortConnectionsHint",
  "settings.compareSortNamespacesHint",
  "settings.noProxyPatternHint",
  "settings.proxyErrorUrl",
  "settings.proxyErrorNoProxyItem",
  "settings.checkUpdatesInAbout",
  "settings.checkUpdatesInAboutHint",
  "settings.updateReminderRestored",
];

const settings = readScannedSource(SETTINGS);
const css = readScannedSource(STYLES);
const diffView = readScannedSource(DIFFVIEW);
const app = readScannedSource(APP);
const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

/** 从 `const NAME: Record<...> = { ... }` 里抠出字段值，用于验三张表的内容而不是形状。 */
function objectLiteralValues(source: string, name: string): Record<string, string> {
  const start = source.indexOf(`const ${name}`);
  expect(start, `源码里没有 ${name}`).toBeGreaterThan(-1);
  const body = source.slice(source.indexOf("{", start), source.indexOf("\n};", start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(\w+):\s*"([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

/**
 * 按 `className="btn …" onClick={handler}` 成对取每颗按钮的配色档位。
 * 只认「类名紧挨着 onClick」的写法（备份节全是这个形状），箭头包一层也照样取到函数名。
 */
function toneByHandler(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/className="(btn[^"]*)"[\s\S]{0,40}?onClick=\{(?:\(\)\s*=>\s*)?([A-Za-z_$][\w$]*)/g)) {
    out[m[2]] = m[1];
  }
  return out;
}

describe("危险行只有一种长相（R-B3）", () => {
  it("三颗不可逆删除共用同一段复合类与同一套按钮配色", () => {
    const rows = settings.match(/<div className="settings-setting-row settings-danger-zone">/g) ?? [];
    expect(rows, "危险行不再是 settings-setting-row + settings-danger-zone 这一种写法").toHaveLength(3);
    const dangerButtons = settings.match(/className="btn btn-ghost btn-danger(?: settings-busy-btn)?"/g) ?? [];
    expect(dangerButtons, "不可逆删除的按钮配色退回普通 ghost").toHaveLength(3);
    for (const key of DANGER_KEYS) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
  });

  it("样式给了这个复合类，死规则 h5 不许被粘回来", () => {
    expect(css, "缺少 .settings-setting-row.settings-danger-zone（提复合才压得住 padding）").toContain(
      ".settings-setting-row.settings-danger-zone {"
    );
    expect(css, ".settings-danger-zone h5 没有命中对象：章节标题是 strong，不是 h5").not.toMatch(/\.settings-danger-zone h5/);
    expect(settings, "危险行里又冒出 <h5>，与其余行的标题层级不一致").not.toMatch(/<h5/);
  });
});

describe("代理框只有一个提交出口（R-B2）", () => {
  it("落库必须经 lib/proxySettings 的判据，不许再逐键写盘", () => {
    expect(settings, "提交没有走唯一入口 readProxyField").toContain("readProxyField(");
    expect(settings, "打字即落库的老路子被粘回来了").not.toMatch(/onChange=\{(?:\(e\)|e) =>\s*update\(\{\s*proxy:/);
    // 轮73 R73-I4 之后写法变了（不再从渲染闭包展开整段 proxy），要保住的判据没变：
    // 提交必须经 update() 这一个出口，才有「已保存」徽章与 useSettings 广播。
    expect(settings, "代理的写入仍要经过 update()，才能保住「已保存」徽章与 useSettings 同步").toMatch(
      /update\(\{ proxy: \{ \[field\]: outcome\.value \}[^)]*\}, "settings-network"\)/
    );
    // 校验只在提交那一刻跑：加载时清洗历史脏值 = 悄悄改用户存过的东西。
    expect(settings, "不许在加载路径清洗历史值").not.toMatch(/normalizeNoProxyList\(/);
  });

  it("三框各给各的示例，且失焦与 Enter 都能提交", () => {
    const placeholders = objectLiteralValues(settings, "PROXY_PLACEHOLDERS");
    expect(Object.keys(placeholders).sort()).toEqual(["httpProxy", "httpsProxy", "noProxy"]);
    const values = Object.values(placeholders);
    expect(new Set(values).size, "三个框又共用同一条 placeholder（示例本身就是 Go 认不得的值）").toBe(values.length);
    expect(settings).toMatch(/onBlur=\{\(?e\)? => commitProxyField\(field, e\.target\.value\)\}/);
    expect(settings, "输入法组词期间的 Enter 是「选这个词」，不能当提交").toMatch(/if \(e\.key !== "Enter" \|\| e\.nativeEvent\.isComposing\) return;/);
    const labels = objectLiteralValues(settings, "PROXY_LABEL_KEYS");
    for (const [field, key] of Object.entries(labels)) {
      expect(zh[key], `zh 缺 ${key}（${field} 框没有可访问名）`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
      expect(placeholders[field]).toMatch(/^(\*\.|localhost|http)/);
    }
  });

  it("字段级报错有容器、有文案、带得上出错的哪一项", () => {
    expect(settings, "报错没有落在同一个 label 里（字段级错误必须贴着字段）").toMatch(
      /<span className="field-error" role="alert">/
    );
    expect(settings).toMatch(/t\(PROXY_ISSUE_KEYS\[issue\.issue\], \{ item: issue\.detail \}\)/);
    expect(zh["settings.proxyErrorNoProxyItem"], "noProxy 的报错少了 {item}，用户不知道哪一项写错").toContain("{item}");
    expect(en["settings.proxyErrorNoProxyItem"], "noProxy 的报错少了 {item}").toContain("{item}");
    // 行首锚定：`.field-error-box .field-error {` 也含 `.field-error {`，不锚行首就漏判基础规则被改名。
    expect(css, "缺少 .field-error 规则，报错会跟正文一个颜色").toMatch(/^\.field-error \{[^}]*\}/m);
    expect(css, "缺少 .settings-proxy-grid，三框又变回手写三份").toMatch(/\.settings-proxy-grid \{[^}]*\}/);
  });

  it("「代理只管更新」这句说明真的被渲染（原先是躺着的死键）", () => {
    expect(settings).toContain('t("settings.proxyOnlyForUpdate")');
    expect(settings).toContain('t("settings.noProxyPatternHint")');
    expect(zh["settings.proxyOnlyForUpdate"], "文案又被改成「所有请求」，与 Go 侧能力不符").toContain("更新");
  });
});

describe("提示落点与复制能力不许倒退（R-B1 / R-B5 / R-B6）", () => {
  it("清理缓存失败走 InlineError：异常原文在、能复制、会滚进视野", () => {
    expect(settings, "catch 又把异常丢了：屏幕上只剩一句「清理缓存失败」").toMatch(/setCacheError\(errorText\(e\)\)/);
    expect(settings, "失败态不再渲染异常原文（少了 cacheError 判空或退回短提示）").toMatch(
      /\{cacheResult === "fail" && cacheError && \(/
    );
    expect(settings, "清理缓存失败没把引用交给 InlineError").toMatch(
      /<InlineError title=\{t\("settings\.clearCacheFailed"\)\} message=\{cacheError\} containerRef=\{cacheErrorRef\} \/>/
    );
    expect(settings).toMatch(/useKeepVisible<HTMLDivElement>\(!!cacheError, cacheError\)/);
    expect(settings, "缓存结果被切走时又把旧异常留下了").toMatch(/setCacheBusy\(true\);\s*setCacheResult\(""\);\s*setCacheError\(""\);/);
  });

  it("short-hint 登记表不再收这条：它的载荷是异常原文，不是短句", () => {
    const shortHintGuard = readFileSync(join(PROJECT_ROOT, SHORT_HINT_GUARD), "utf8");
    expect(shortHintGuard, "登记表里又留了 settings.clearCacheFailed，会把下一位作者往「一句裸 div」上带").not.toMatch(
      /SHORT_HINT_SITES[\s\S]*?settings\.clearCacheFailed/
    );
  });

  it("备份节的主数据文件路径带复制键，且形状有自己的类", () => {
    expect(settings, "主数据文件路径又变成只能手抄的一串").toMatch(
      /<div className="settings-data-file-path">[\s\S]{0,600}<CopyButton text=\{docInfo\.path\} ariaLabel=\{t\("settings\.copyPathAria"/
    );
    expect(css, "缺少 .settings-data-file-path 规则，长路径会把复制键顶出这一行").toMatch(/\.settings-data-file-path \{[^}]*\}/);
  });

  it("检查更新只把人送去关于页，不在设置页复制第二份检查逻辑", () => {
    expect(settings, "设置页 props 没有 onOpenAbout，这一节又成了只读不回的死信息").toMatch(/onOpenAbout: \(\) => void;/);
    expect(settings, "检查更新的键没接到 onOpenAbout").toMatch(/<button type="button" className="btn btn-ghost btn-sm" onClick=\{onOpenAbout\}/);
    // 检查 / 下载 / 校验 / 安装 / 交接这套能力都从 api/app 出口走，只有关于页消费它。
    expect(settings, "检查逻辑在关于页只有一份实现，设置页不许再引 api/app 那一套").not.toContain('"../api/app"');
    expect(settings).not.toMatch(/\bcheckForUpdates\b|\blaunchUpdateInstaller\b/);
    expect(app, "App 没有把 onOpenAbout 接到关于页").toMatch(/<SettingsView onOpenAbout=\{openAboutAtUpdate\} \/>/);
    // 轮74 D2：落地那一页得认得出自己是来干什么的。标记只由跳转方给、关于页消费完必须清掉，
    // 否则下次从导航栏进关于页也会白闪一下。
    expect(app, "关于页没收到到达标记：从设置页跳过去仍是一片静止的 logo 页").toMatch(
      /<About embedded arriveAtUpdate=\{aboutArriveAtUpdate\} onArriveConsumed=\{\(\) => setAboutArriveAtUpdate\(false\)\} \/>/
    );
    expect(app, "新版本提醒另开了一条进关于页的路，标记会漏给关于页").toMatch(/onAction: openAboutAtUpdate,/);
    // 恢复提醒是「点完屏幕上什么都不挪」的动作，必须补一条轻提示。
    expect(settings, "清空跳过版本后没有任何回执").toMatch(/toast\(t\("settings\.updateReminderRestored"\), "success"\)/);
  });
});

describe("可点整行与两条对比说明（R-B4）", () => {
  it("两行都可点，且说明文字在 label 外面", () => {
    const rows = settings.match(/<label className="settings-setting-row settings-setting-row-clickable">/g) ?? [];
    expect(rows, "对比节的整行可点被改回只有一颗方框能按").toHaveLength(2);
    for (const match of settings.matchAll(/<label className="settings-setting-row settings-setting-row-clickable">([\s\S]*?)<\/label>/g)) {
      expect(match[1], "说明文字被包进 label：整句说明书会变成复选框的可访问名").not.toContain("field-hint");
      expect(match[1], "label 里必须有复选框才算真的整行可点").toContain('type="checkbox"');
    }
    expect(settings).toContain('t("settings.compareSortConnectionsHint")');
    expect(settings).toContain('t("settings.compareSortNamespacesHint")');
  });

  it("可点行有悬停与焦点反馈，样式靠复合类而不是顺序", () => {
    expect(css, "缺基础规则").toMatch(/\.settings-setting-row\.settings-setting-row-clickable \{[^}]*cursor: pointer;/);
    expect(css, "缺悬停反馈").toMatch(/\.settings-setting-row\.settings-setting-row-clickable:hover \{/);
    expect(css, "缺键盘焦点反馈").toMatch(/\.settings-setting-row\.settings-setting-row-clickable:focus-within \{/);
  });

  it("清掉的死键不许以「只加文案」或「只加引用」的方式复活", () => {
    for (const key of RETIRED_KEYS) {
      expect(zh[key], `${key} 又被加回 zh，却没有站点引用它`).toBeFalsy();
      expect(en[key], `${key} 又被加回 en，却没有站点引用它`).toBeFalsy();
      const shortName = key.split(".")[1];
      for (const file of sourceFiles()) {
        expect(readScannedSource(file), `${file} 又引用了死键 ${key}`).not.toContain(`settings.${shortName}`);
      }
    }
  });

  it("新增说明与报错文案中英文成对", () => {
    for (const key of NEW_COPY_KEYS) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
  });
});

describe("连接排序开关是真的（R-B9）", () => {
  it("来源选择器读这个开关，且只在勾选时排", () => {
    expect(diffView, "SourcePicker 没有声明 sortConnections prop").toMatch(/sortConnections: boolean;/);
    expect(diffView, "开关又被写死（既不排也不分派）").toMatch(/const orderedSourceConnections = sortConnections\s*\?\s*\[\.\.\.sourceConnections\]\.sort\(/);
    expect(diffView, "选项列表又用回未排序的 sourceConnections").toMatch(/const sourceOptions = orderedSourceConnections\.map\(/);
  });

  it("两处来源选择器都把设置里的值传进去", () => {
    const passes = diffView.match(/sortConnections=\{settings\.compare\.sortConnections\}/g) ?? [];
    expect(passes, "只有一侧传了开关：另一侧的比较页又回到不排序").toHaveLength(2);
  });

});

describe("备份节的按钮权重只有一个提交焦点（轮74 C2）", () => {
  it("备份节只给提交动作用主色：预览降次要档，覆盖本机数据走实心危险档（轮74 C2）", () => {
    const tones = toneByHandler(readScannedSource(BACKUP_PANEL));
    expect(Object.keys(tones).length, "一颗按钮都没解析到，锚点写法变了").toBeGreaterThan(6);
    ["saveBackupPassword", "exportLocalBackup", "uploadWebDAVBackup"].forEach((fn) => {
      expect(tones[fn], `${fn} 是本节的提交动作，主色不能丢`).toContain("btn-primary");
    });
    ["previewLocalBackup", "previewRemoteBackup"].forEach((fn) => {
      expect(tones[fn], `${fn} 只是「看一眼再决定」，不该和提交动作抢主色`).toContain("btn-ghost");
    });
    expect(tones.restorePreview, "这颗会用备份件覆盖本机数据，必须是最重的一档").toContain("btn-danger-fill");
    const primaryCount = Object.values(tones).filter((cls) => cls.includes("btn-primary")).length;
    expect(primaryCount, `主色按钮共 ${primaryCount} 颗：一个面板里这么多蓝，等于没有蓝`).toBe(3);
  });
});
