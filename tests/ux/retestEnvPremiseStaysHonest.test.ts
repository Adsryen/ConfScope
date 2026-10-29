/**
 * retest 环境的前提由脚本自己把关，「该没有的」与「该建的」同等强制（轮88）。
 *
 * 缺陷长什么样（这一条是我自己造出来的，账记在 .trellis/spec/frontend/smoke-testing.md
 * 「环境必须能从空容器复现」）：轮86 把 scripts/retest-data/init-namespaces.py 的 ENVS
 * 写成 A = retest-dev + retest-qa，理由是「98-remaining E4 的晋级目标在 A/retest-qa，
 * 缺了就是 Nacos v1 的静默半成功、5s 回读会 mismatch」。这条理由是推理出来的，不是读出来的：
 * r84 那次全批 168 passed 时 A 侧本来就没有 retest-qa，同一条日志 12564 行还打印过
 * 那句提醒的读数；轮87 把它建出来之后，99-s-promote-entry S31 当场红成
 * `element(s) not found`（.apply-promote-namespace-note 消失了）。删回基线复跑 E4 + S31 = 2 passed。
 *
 * 为什么值得一条静态守卫：环境数据不在仓库里，改它不触发任何测试。
 * 「给测试环境补一块看起来缺的数据」永远像是善意的修复，
 * 而它一次踩坏两条共用互斥前提的用例，红字还长得像「产品坏了」。
 *
 * 守卫钉六条（一条 it 一条，顺序对应）：
 * 1. ENVS：A 只建 retest-dev、B 只建 retest-qa；A 侧一旦长出第三个租户直接红；
 * 2. MUST_NOT_EXIST 必须声明 a 侧禁 retest-qa，且与 ENVS 不许自相矛盾（同一租户又「该建」又「该没有」）；
 * 3. review() 必须真的读 MUST_NOT_EXIST 做复核，main 必须 ensure_all() + review() 都调
 *    ——只声明不检查等于没有守卫，而 CI 恰恰只跑这一个脚本；
 * 4. 用例侧不再吃这条前提（r113 之后 E4 只判落库范围、S31 的晋级入口整块撤除），
 *    于是这条从「钉住依赖」翻成「钉住依赖已消失」：E4 不许再把 A 缺租户写成现场前提，
 *    它的目标侧必须仍是 B/retest-qa，脚本也必须把闸门写成环境基线而不是用例依赖；
 * 5. 与 tests/retest/state.ts 的 nacos.a/b.namespace 同源（改一侧忘另一侧的漂移方向是 CI 红），
 *    且 A 侧禁的不许是 A 自己浏览的基准租户；
 * 6. 脚本文件头必须留着真机读数（ghost 探针那批标识 + /v1/console/namespaces），
 *    不许把环境口径写成又一句无据的断言。
 * 变异自检（改坏任一条，本文件必须变红）：① 把 retest-qa 加回 A 的 ENVS；
 * ② 把 MUST_NOT_EXIST 的复核从 review() 里删掉；③ 把 state.ts 的 a.namespace 改成 retest-qa；
 * ④ 把旧措辞「不是已列出的租户」写回 E4 注释、或把 E4 的目标侧改成别的租户；
 * ⑤ 删掉脚本头部的实测读数段。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./scanUtils";

const SCRIPT = "scripts/retest-data/init-namespaces.py";
const STATE = "tests/retest/state.ts";
const E4_SPEC = "tests/retest/specs/98-remaining.spec.ts";

/** r113 之前 E4 写下的现场前提（它把读数记在注释里）。现在只用来判「这句不许再出现」。 */
const E4_PREMISE = "不是已列出的租户";

/** E4 现在的目标侧：写向 B 的基准租户，所以「A 侧不许长出同名租户」才是环境基线而非用例依赖。 */
const E4_TARGET_LINE = "应用到 B/retest-qa";

/** 脚本自己对该闸门的定性（真机侧结论，不是推理）：用例级消费者已消失，留着只守基线。 */
const SCRIPT_BASELINE = "这条前提失去了用例级消费者";

function read(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8");
}

/** ENVS 块里某一侧要建的命名空间（`"a": ("http://…", ["retest-dev"])` 的第二个元素）。 */
function envNamespaces(source: string, side: "a" | "b"): string[] {
  const block = source.slice(source.indexOf("ENVS = {"));
  const matched = new RegExp(`"${side}":\\s*\\(\\s*"[^"]+"\\s*,\\s*\\[([^\\]]*)\\]`).exec(block);
  if (!matched) throw new Error(`${SCRIPT} 的 ENVS 读不到 ${side} 侧：写法被改了，守卫要跟着改`);
  return [...matched[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** MUST_NOT_EXIST 块里某一侧禁止出现的命名空间。 */
function forbiddenNamespaces(source: string, side: "a" | "b"): string[] {
  const start = source.indexOf("MUST_NOT_EXIST = {");
  if (start < 0) throw new Error(`${SCRIPT} 里没有 MUST_NOT_EXIST：环境前提只剩「该建的」半条口径`);
  const block = source.slice(start);
  const matched = new RegExp(`"${side}":\\s*\\[([^\\]]*)\\]`).exec(block);
  return matched ? [...matched[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

describe("retest 命名空间前提（ENVS 该建的 / MUST_NOT_EXIST 该没有的）", () => {
  const source = read(SCRIPT);

  it("A 只建 retest-dev，B 只建 retest-qa", () => {
    expect(envNamespaces(source, "a"), "A 侧多建出来的每一个租户都会改变用例看到的目标现场").toEqual(["retest-dev"]);
    expect(envNamespaces(source, "b")).toEqual(["retest-qa"]);
  });

  it("A 侧被明令禁止出现 retest-qa（E4 的晋级目标必须是「还没建出来的租户」）", () => {
    expect(forbiddenNamespaces(source, "a"), "MUST_NOT_EXIST 少了 a 侧的 retest-qa：租户一存在产品就不提醒，用例跟着红").toEqual([
      "retest-qa",
    ]);
    // 两条口径不能自相矛盾：同一个租户不许又「该建」又「该没有」。
    for (const side of ["a", "b"] as const) {
      const built = envNamespaces(source, side);
      const banned = forbiddenNamespaces(source, side);
      expect(
        banned.filter((ns) => built.includes(ns)),
        `${side} 侧同时要求建又要求没有：${JSON.stringify(banned)}`
      ).toEqual([]);
    }
  });

  it("review() 真的复核 MUST_NOT_EXIST（只声明不检查等于没有守卫）", () => {
    const start = source.indexOf("def review(");
    expect(start, "脚本里找不到 review()：收尾复核被删掉了？").toBeGreaterThan(-1);
    const body = source.slice(start, start + 1_600);
    expect(body, "review() 不再读 MUST_NOT_EXIST：A 上多出 retest-qa 会静默通过，等批跑起来才红").toContain("MUST_NOT_EXIST");
    expect(body).toContain("list_namespaces");
    // ensure_all 只建，review 才判——main 必须两者都调用。
    const main = source.slice(source.indexOf("def main("));
    expect(main).toContain("review()");
    expect(main).toContain("ensure_all()");
  });

  it("用例侧不再依赖这条前提，闸门以环境基线的身份留着（口径要三处对齐）", () => {
    const e4 = read(E4_SPEC);
    // 617fc1c 之后没有任何用例再吃这条前提：E4 改判执行落库范围、S31 驱动的是已撤除的晋级入口。
    // 守卫不因此删掉——它翻面钉住「新口径」，把这条判断留在磁盘上而不是留在会话记忆里。
    expect(e4, "E4 又把「A 上没有 retest-qa」写成现场前提：那条用例早已不驱动晋级入口").not.toContain(E4_PREMISE);
    expect(e4, "E4 的目标侧不再是 B/retest-qa：这条基线为什么还在，要重新核对一遍").toContain(E4_TARGET_LINE);
    expect(source, "脚本把闸门又写成用例级前提：用例侧已无消费者，如实写成环境基线").toContain(SCRIPT_BASELINE);
  });

  it("与 tests/retest/state.ts 的基准命名空间同源", () => {
    const state = read(STATE);
    const nsOf = (side: "a" | "b"): string => {
      const matched = new RegExp(`${side}:\\s*\\{[^}]*?namespace:\\s*"([^"]+)"`).exec(state);
      if (!matched) throw new Error(`${STATE} 里读不到 nacos.${side}.namespace`);
      return matched[1];
    };
    expect(nsOf("a"), "A 侧基准租户与 ENVS 不同源").toBe(envNamespaces(source, "a")[0]);
    expect(nsOf("b"), "B 侧基准租户与 ENVS 不同源").toBe(envNamespaces(source, "b")[0]);
    // A 侧被禁的正是 B 的基准租户（沿用沙箱命名空间），这条是前提本身，不是自相矛盾；
    // 真正的矛盾只有一种：禁掉 A 自己的基准租户。
    expect(forbiddenNamespaces(source, "a"), "A 侧不能把自己 browsing 的基准租户禁掉").not.toContain(nsOf("a"));
    expect(forbiddenNamespaces(source, "a")).toContain(nsOf("b"));
  });

  it("脚本头部留着真机读数，不许把口径写成无据断言", () => {
    const header = source.slice(0, source.indexOf("ENVS = {"));
    expect(header, "环境口径的依据必须是读出来的：留着 ghost 探针那批读数，下一个人才能复核而不是重猜").toMatch(/ghost[\w-]*/);
    expect(header).toMatch(/v1\/console\/namespaces/);
  });
});
