/**
 * 「目标已经是这一版吗」这条判据本身的测试（轮98 A1）。
 *
 * 它同时被写后回读确认和写前豁免使用，所以它的每个分支都是执行链路的口径：
 * 判松了会漏写（该写的说成不用写），判紧了会重复写（已达成的又 publish 一遍，
 * 服务端多一版没人要的历史，操作历史多一条假「改动」）。
 * 这里按分支逐条钉死，执行器层的用例只管装配，不替这条谓词背书。
 */
import { describe, expect, it } from "vitest";
import type { ApplyPlanValueInput } from "./applyPlan";
import { isTargetAlreadyApplied, writeMatchesReadBack, type PlannedWriteShape } from "./applyWriteEquivalence";

function present(overrides: Partial<ApplyPlanValueInput> = {}): ApplyPlanValueInput {
  return { exists: true, value: "a: 1", content: "a: 1", format: "YAML", parseStatus: "ok", ...overrides };
}

function missing(): ApplyPlanValueInput {
  return { exists: false };
}

const publish: PlannedWriteShape = { kind: "publish", content: "a: 1" };
const remove: PlannedWriteShape = { kind: "delete" };
const keyWrite: PlannedWriteShape = { kind: "publish_ref", content: "enabled" };

describe("writeMatchesReadBack", () => {
  it("写入类：正文逐字符相等才算同一版", () => {
    expect(writeMatchesReadBack(publish, present())).toBe(true);
    expect(writeMatchesReadBack(publish, present({ content: "a: 2" }))).toBe(false);
    // 精确比较（轮55 口径）：差一个尾随空格就是另一版，不做 normalize。
    expect(writeMatchesReadBack({ kind: "publish", content: "a: 1 " }, present())).toBe(false);
    expect(writeMatchesReadBack(publish, present({ content: "a: 1\n" }))).toBe(false);
  });

  it("写入类：目标不存在不是已达成，照常写", () => {
    expect(writeMatchesReadBack(publish, missing())).toBe(false);
  });

  it("写入类：key 级写只有 value 时按 value 比", () => {
    expect(writeMatchesReadBack(keyWrite, present({ content: undefined, value: "enabled" }))).toBe(true);
    expect(writeMatchesReadBack(keyWrite, present({ content: undefined, value: "disabled" }))).toBe(false);
  });

  it("写入类：整篇 content 优先于 value", () => {
    expect(writeMatchesReadBack(publish, present({ content: "a: 1", value: "different" }))).toBe(true);
    expect(writeMatchesReadBack(publish, present({ content: "a: 9", value: "a: 1" }))).toBe(false);
  });

  it("现值既没有 content 也没有 value：宁可再写一次，不判已达成", () => {
    const bare: ApplyPlanValueInput = { exists: true, format: "TEXT", parseStatus: "ok" };
    expect(writeMatchesReadBack(publish, bare)).toBe(false);
    expect(writeMatchesReadBack(keyWrite, bare)).toBe(false);
  });

  it("空正文写入：要写的是空串且目标也是空串才算达成", () => {
    const emptyWrite: PlannedWriteShape = { kind: "publish", content: "" };
    expect(writeMatchesReadBack(emptyWrite, present({ content: "", value: "" }))).toBe(true);
    expect(writeMatchesReadBack(emptyWrite, present({ content: "a: 1", value: "a: 1" }))).toBe(false);
    // content 字段整个没带过来时按「读不出可比字段」处理，不等于空串
    expect(writeMatchesReadBack(emptyWrite, present({ content: undefined, value: undefined }))).toBe(false);
  });

  it("删除类：目标已经不存在就是已达成，还在就照常删", () => {
    expect(writeMatchesReadBack(remove, missing())).toBe(true);
    expect(writeMatchesReadBack(remove, present())).toBe(false);
    expect(writeMatchesReadBack({ kind: "delete_ref" }, missing())).toBe(true);
    expect(writeMatchesReadBack({ kind: "delete_ref" }, present())).toBe(false);
  });

  it("引用类写入与文档级写入吃同一条规则", () => {
    const refDocWrite: PlannedWriteShape = { kind: "publish_ref", content: "a: 1" };
    expect(writeMatchesReadBack(refDocWrite, present())).toBe(true);
    expect(writeMatchesReadBack(refDocWrite, present({ content: "a: 2" }))).toBe(false);
  });

  it("isTargetAlreadyApplied 就是这条谓词本身，不是第二份实现", () => {
    const samples: [PlannedWriteShape, ApplyPlanValueInput][] = [
      [publish, present()],
      [publish, present({ content: "other" })],
      [publish, missing()],
      [remove, missing()],
      [remove, present()],
    ];
    for (const [write, current] of samples) {
      expect(isTargetAlreadyApplied(write, current)).toBe(writeMatchesReadBack(write, current));
    }
  });
});
