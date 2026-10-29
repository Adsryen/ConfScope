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
 * 4. 用例侧的依赖必须还在：E4 的现场前提注释还在
 *    ——它哪天不再依赖这条前提，才允许重新讨论要不要把租户建出来；
 * 5. 与 tests/retest/state.ts 的 nacos.a/b.namespace 同源（改一侧忘另一侧的漂移方向是 CI 红），
 *    且 A 侧禁的不许是 A 自己浏览的基准租户；
 * 6. 脚本文件头必须留着真机读数（ghost 探针那批标识 + /v1/console/namespaces），
 *    不许把环境口径写成又一句无据的断言。
 * 变异自检（改坏任一条，本文件必须变红）：① 把 retest-qa 加回 A 的 ENVS；
 * ② 把 MUST_NOT_EXIST 的复核从 review() 里删掉；③ 把 state.ts 的 a.namespace 改成 retest-qa；
 * ④ 删掉 E4 注释里那条前提；⑤ 删掉脚本头部的实测读数段。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./scanUtils";

const SCRIPT = "scripts/retest-data/init-namespaces.py";
const STATE = "tests/retest/state.ts";
const E4_SPEC = "tests/retest/specs/98-remaining.spec.ts";

/** E4 侧写下的同一条前提（措辞不同：它把自己的现场前提记在注释里，读数打进日志）。 */
const E4_PREMISE = "不是已列出的租户";

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

  it("用例侧仍然依赖这条前提（不再依赖了才准重新讨论建不建）", () => {
    // S31 的第5步入口随 r113 撤除、硬断言也随之消失；现在只剩 E4 还吃这条前提（现场前提写在注释里并如实记读数）。
    expect(read(E4_SPEC), "E4 不再把命名空间提醒的读数当现场前提（它靠的是 retest-qa 在 A 上还没被列出来）").toContain(E4_PREMISE);
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
