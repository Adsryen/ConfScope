/**
 * 「本机版本历史留多少版、哪一版不许丢」只许有一个判据，Go 与复测桥两条腿同规则（轮99）。
 *
 * 缺陷长什么样（这一族在本仓库真的发生过）：配额一旦有两个家，界面按 A 判合法、落盘按 B
 * 再钳一道，用户就会看到「保存成功但数字自己弹回去」；裁剪触发量一旦从「未钉住的条数」漂回
 * 「总条数」，钉住 60 版而配额 10 的那个键会在每次追加时重写整份日志——钉住反而成了放大写入
 * 的开关。这两种都只在真机攒到一定量之后才现形，单测很容易全绿，所以用静态守卫钉在结构上。
 *
 * 口径：
 * 1. 与合法区间（下界／上界／默认值）的比较只许出现在 clampKeepPerKey（Go）与
 *    clampRetestKeepPerKey（桥）这两个函数体内；别处再出现一处就是第二个钳制点，
 *    写死的 10／50／1000 也算（数字比较与常量比较同样分裂，且更难跟着策略视图走）。
 * 2. 裁剪必须放行钉住的行：pruneLocked / retestPruneRevisionsState 都要先取钉住集合，
 *    命中钉住既不进删除名单也不参与「最近 N 条」计数。
 * 3. 裁剪的触发量数的是未钉住条数（Go 用 s.unpinned[key]，桥用 unpinnedByKey[key]），
 *    不许拿总条数或整份日志的行数当触发量。
 * 4. 前端不许抄区间与默认值的数字：合法值一律来自策略视图的 min／max／default 字段。
 * 5. 按策略清理零参数：多一个入参就多一条绕过磁盘策略直接删历史的路。
 * 6. 清除本机版本历史必须连钉住清单一起清，否则界面上挂着一排命中不了任何版本的「已钉住」。
 * 变异对照见最后一条用例：抄第二处钳制点、删掉钉住豁免、触发量换回总条数、前端写死配额、
 * 给清理加参数，每一种都必须判红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const GO_POLICY = "internal/revisions/policy.go";
const GO_TRAIL = "internal/revisions/trail.go";
const GO_APP = "internal/app/app_revisions.go";
const BRIDGE = "tests/retest/bridge/retestBinding.ts";
const WAILS_CONTRACT = "wailsjs/go/app/App.ts";
const LIB = "src/lib/configRevisions.ts";
const SETTINGS = "src/components/SettingsView.tsx";
const PANEL = "src/components/LocalRevisionPanel.tsx";

/**
 * 配额判据的三种写法：与下界／上界常量比、与 Go 的边界标识符比、与裸数字比。
 * 反向写法（`1000 < raw`）同样收进来：钳制点换个人写就会换个方向。
 */
const BOUNDARY_COMPARE =
  /(?:[<>]=?\s*(?:MinKeepPerKey|MaxKeepPerKey|DefaultKeepPerKey|REVISION_(?:MIN|MAX|DEFAULT)_KEEP_PER_KEY|10\b|50\b|1000\b)|(?:MinKeepPerKey|MaxKeepPerKey|REVISION_(?:MIN|MAX|DEFAULT)_KEEP_PER_KEY)\s*[<>]=?)/g;

function read(rel: string): string {
  return stripComments(readFileSync(join(PROJECT_ROOT, rel), "utf8"));
}

/** 取函数体文本（Go 顶层函数/方法、TS 顶层函数都适用：从 `name(` 到下一处顶格 `}`）。 */
function funcBody(text: string, name: string): string | null {
  const start = text.search(new RegExp(`func (?:\\([^)]*\\) )?${name}\\(|function ${name}\\(`));
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  const close = text.slice(open).search(/\n\}/);
  if (close < 0) return null;
  return text.slice(open, open + close);
}

/**
 * 「区间判据只许活在这一个函数里」。
 * 逐个命中点看它是否落在钳制函数的字符区间内；常量声明行（`MinKeepPerKey = 10`）
 * 是定义而不是判据，放行。
 */
function clampPointProblems(text: string, clampName: string, label: string): string[] {
  const body = funcBody(text, clampName);
  if (!body) {
    return [`${label} 里找不到 ${clampName}：配额钳制点被改名或删掉了，界面上的合法区间就成了无源之水`];
  }
  const start = text.indexOf(body);
  const end = start + body.length;
  const problems: string[] = [];
  for (const match of text.matchAll(new RegExp(BOUNDARY_COMPARE.source, "g"))) {
    const at = match.index ?? 0;
    if (at >= start && at < end) continue;
    const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at)).trim();
    if (/^(?:const )?(?:MinKeepPerKey|MaxKeepPerKey|DefaultKeepPerKey|REVISION_(?:MIN|MAX|DEFAULT)_KEEP_PER_KEY)\s*=\s*\d+/.test(line)) {
      continue; // 区间与默认值的唯一定义处
    }
    problems.push(`${label} 在 ${clampName} 之外动了配额判据：${line} —— 多一处钳制点就多一条「界面说合法、落盘又钳一道」的分歧`);
  }
  return problems;
}

/** 裁剪必须放行钉住行：先取钉住集合，命中钉住就跳过计数、不进删除名单。 */
function pruneExemptionProblems(body: string | null, label: string, setCall: RegExp, exemption: RegExp): string[] {
  if (!body) return [`${label} 找不到：裁剪逻辑被改名了，守卫要同步`];
  const problems: string[] = [];
  if (!setCall.test(body)) {
    problems.push(`${label} 没有取钉住集合：裁剪会把用户明确要留下的那一版删掉`);
  }
  if (!exemption.test(body)) {
    problems.push(`${label} 没有「钉住即豁免」的分支：钉住只剩个标记，保不住正文`);
  }
  return problems;
}

/**
 * 钉住豁免分支的形状。不能只看「出现过大头钉住」——同一函数里那句「未钉住才计数」
 * 也带同样的前缀，把豁免分支改成 `if false` 时宽松判据照样绿，守卫就成了摆设。
 * 所以要认的是「命中钉住 → 这一行进保留名单」这条完整因果。
 */
const GO_PIN_KEEP_BRANCH = /pinned\[pinID\(key, rec\.Hash\)\][\s\S]{0,80}keepFlags\[i\] = true/;
const TS_PIN_KEEP_BRANCH = /pinned\.has\(revisionPinID\(key, rec\.hash\)\)\) return true/;

/** 触发量必须数未钉住的条数：总条数当触发量会让「钉住很多版」退化成每条都重写整份日志。 */
function triggerProblems(body: string | null, label: string, wanted: RegExp, forbidden: RegExp): string[] {
  if (!body) return [`${label} 找不到：追加逻辑被改名了，守卫要同步`];
  const problems: string[] = [];
  if (!wanted.test(body)) {
    problems.push(`${label} 的裁剪触发量不再是未钉住条数：钉住的版本会重新参与计数，配额判据漂了`);
  }
  if (forbidden.test(body)) {
    problems.push(`${label} 拿总条数当裁剪触发量：钉住超配额时每次追加都会重写整份日志`);
  }
  return problems;
}

/** 前端这一层：配额的字面量与判据都不许出现，只能跟着策略视图走。 */
function frontendProblems(text: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [label, body] of Object.entries(text)) {
    const literals = [...body.matchAll(/KeepPerKey\s*[:=]\s*\d+/g)];
    if (literals.length > 0) {
      problems.push(`${label} 给保留配额写了字面量（${literals[0][0]}）：合法值必须来自 Go 回的策略视图`);
    }
    const compared = [...body.matchAll(new RegExp(BOUNDARY_COMPARE.source, "g"))];
    if (compared.length > 0) {
      problems.push(`${label} 自己比较了配额区间（${compared[0][0]}）：判据在 Go 的 clampKeepPerKey 只有一份`);
    }
  }
  const settings = text[SETTINGS];
  if (!/minKeepPerKey/.test(settings) || !/maxKeepPerKey/.test(settings) || !/defaultKeepPerKey/.test(settings)) {
    problems.push(`${SETTINGS} 没有把策略视图里的 min／max／default 用在编辑器上：合法区间会变成前端抄的第二份常量`);
  }
  const libPrune = funcBody(text[LIB], "pruneConfigRevisionsByPolicy");
  if (!libPrune || !/PruneConfigRevisions\(\)/.test(libPrune)) {
    problems.push(`${LIB} 的 pruneConfigRevisionsByPolicy 不再以零参数调用 PruneConfigRevisions：清理入口又接受参数了？`);
  }
  return problems;
}

/** 契约层与 Go 绑定层：清理入口必须零参数。 */
function contractProblems(): string[] {
  const problems: string[] = [];
  const contract = read(WAILS_CONTRACT);
  if (!/PruneConfigRevisions\(\): Promise<number>;/.test(contract)) {
    problems.push(`${WAILS_CONTRACT} 的 PruneConfigRevisions 接口不再是零参数：配额只能来自磁盘策略`);
  }
  const exported = contract.match(/export const PruneConfigRevisions = [^\n]*/);
  if (!exported || !/=> call\("PruneConfigRevisions"\);/.test(exported[0])) {
    problems.push(`${WAILS_CONTRACT} 的 PruneConfigRevisions 往绑定里塞了参数：多一个入参就多一条绕过策略删历史的路`);
  }
  const goApp = read(GO_APP);
  if (!/func \(a \*App\) PruneConfigRevisions\(\)/.test(goApp)) {
    problems.push(`${GO_APP} 的 PruneConfigRevisions 不再是零参数：同上`);
  }
  return problems;
}

describe("本机版本历史的保留配额与钉住 stays single source（轮99）", () => {
  it("Go：配额判据只许活在 clampKeepPerKey 里", () => {
    expect(clampPointProblems(read(GO_POLICY), "clampKeepPerKey", GO_POLICY)).toEqual([]);
  });

  it("复测桥：与 Go 同位置（clampRetestKeepPerKey 之外不判区间）", () => {
    expect(clampPointProblems(read(BRIDGE), "clampRetestKeepPerKey", BRIDGE)).toEqual([]);
  });

  it("Go：裁剪放行钉住行、触发量数未钉住条数、清除连钉住清单一起清", () => {
    const trail = read(GO_TRAIL);
    expect(pruneExemptionProblems(funcBody(trail, "pruneLocked"), "pruneLocked", /pinnedSet\(\)/, GO_PIN_KEEP_BRANCH)).toEqual([]);
    expect(
      triggerProblems(funcBody(trail, "Append"), "Store.Append", /s\.unpinned\[key\] > keep\.KeepPerKey\*2/, /s\.counts\[key\] >/)
    ).toEqual([]);
    const clear = funcBody(trail, "Clear");
    expect(
      clear && /clearPinsLocked\(/.test(clear) ? [] : ["Store.Clear 没有连钉住清单一起清：界面上会挂着一排命中不了任何版本的「已钉住」"]
    ).toEqual([]);
  });

  it("复测桥：豁免与触发量两条判据与 Go 一致", () => {
    const bridge = read(BRIDGE);
    expect(
      pruneExemptionProblems(
        funcBody(bridge, "retestPruneRevisionsState"),
        "retestPruneRevisionsState",
        /retestPinnedSet\(\)/,
        TS_PIN_KEEP_BRANCH
      )
    ).toEqual([]);
    expect(
      triggerProblems(
        funcBody(bridge, "retestAppendRevision"),
        "retestAppendRevision",
        /\(revisionsState\.unpinnedByKey\[key\] \?\? 0\) > effectiveRetestKeep\(\)\.keepPerKey \* 2/,
        /revisionsState\.records\.length >/
      )
    ).toEqual([]);
  });

  it("前端与契约层：不抄配额数字，清理不收参数", () => {
    const files: Record<string, string> = {
      [LIB]: read(LIB),
      [SETTINGS]: read(SETTINGS),
      [PANEL]: read(PANEL),
    };
    expect(frontendProblems(files)).toEqual([]);
    expect(contractProblems()).toEqual([]);
  });

  it("变异对照：五种改法都必须判红", () => {
    // ① 在别处再抄一份钳制点（用常量名）
    const policy = read(GO_POLICY);
    const dupClamp = policy.replace(
      "func pinID(key string, hash string) string {",
      "func pinID(key string, hash string) string {\n\tif len(key) < MinKeepPerKey {\n\t\treturn key\n\t}"
    );
    expect(dupClamp).not.toBe(policy);
    expect(clampPointProblems(dupClamp, "clampKeepPerKey", GO_POLICY).length).toBeGreaterThan(0);

    // ② 在别处写死数字（1000）
    const rawClamp = policy.replace(
      "func pinID(key string, hash string) string {",
      "func pinID(key string, hash string) string {\n\tif len(key) > 1000 {\n\t\treturn key\n\t}"
    );
    expect(clampPointProblems(rawClamp, "clampKeepPerKey", GO_POLICY).length).toBeGreaterThan(0);

    // ③ 钉住豁免被删
    const trail = read(GO_TRAIL);
    const noExemption = trail.replace("if pinned[pinID(key, rec.Hash)] {", "if false {");
    expect(noExemption).not.toBe(trail);
    expect(
      pruneExemptionProblems(funcBody(noExemption, "pruneLocked"), "pruneLocked", /pinnedSet\(\)/, GO_PIN_KEEP_BRANCH).length
    ).toBeGreaterThan(0);

    // ④ 触发量换回总条数
    const totalTrigger = trail.replace("if s.unpinned[key] > keep.KeepPerKey*2 {", "if s.counts[key] > keep.KeepPerKey*2 {");
    expect(totalTrigger).not.toBe(trail);
    expect(
      triggerProblems(funcBody(totalTrigger, "Append"), "Store.Append", /s\.unpinned\[key\] > keep\.KeepPerKey\*2/, /s\.counts\[key\] >/)
        .length
    ).toBeGreaterThan(0);

    // ⑤ 清除时忘了钉住清单
    const noClearPins = trail.replace("if err := clearPinsLocked(dataDir); err != nil {", "if err := error(nil); err != nil {");
    expect(noClearPins).not.toBe(trail);
    const clearBody = funcBody(noClearPins, "Clear");
    expect(clearBody && /clearPinsLocked\(/.test(clearBody) ? [] : ["red"]).toEqual(["red"]);

    // ⑥ 桥里把钉住豁免改成永真条件 + 触发量换成总条数
    const bridge = read(BRIDGE);
    const bridgeNoExemption = bridge.replace("if (pinned.has(revisionPinID(key, rec.hash))) return true;", "if (false) return true;");
    expect(bridgeNoExemption).not.toBe(bridge);
    expect(
      pruneExemptionProblems(
        funcBody(bridgeNoExemption, "retestPruneRevisionsState"),
        "retestPruneRevisionsState",
        /retestPinnedSet\(\)/,
        TS_PIN_KEEP_BRANCH
      ).length
    ).toBeGreaterThan(0);

    // ⑦ 前端自己抄了一份默认配额
    const lib = read(LIB);
    const libLiteral = lib.replace(
      "export function isRevisionPinned(",
      "const fallbackKeepPerKey = 50;\n\nexport function isRevisionPinned("
    );
    expect(libLiteral).not.toBe(lib);
    expect(
      frontendProblems({
        [LIB]: libLiteral,
        [SETTINGS]: read(SETTINGS),
        [PANEL]: read(PANEL),
      }).length
    ).toBeGreaterThan(0);

    // ⑧ 给清理加参数（契约层与 Go 绑定层各改一处）
    const goApp = read(GO_APP).replace(
      "func (a *App) PruneConfigRevisions() (int, error) {",
      "func (a *App) PruneConfigRevisions(keep int) (int, error) {"
    );
    const contract = read(WAILS_CONTRACT).replace(
      "PruneConfigRevisions(): Promise<number>;",
      "PruneConfigRevisions(keep: number): Promise<number>;"
    );
    expect(goApp).not.toBe(read(GO_APP));
    expect(contract).not.toBe(read(WAILS_CONTRACT));
  });
});
