import { afterEach, describe, expect, it, vi } from "vitest";
import { PORT_MAX, PORT_MIN, SSH_DEFAULT_PORT, portIssue, sshPortIssues } from "./ports";

const LABEL = "SSH 端口";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("端口常量", () => {
  // 字面值契约：其余用例都拿常量自身作断言（改常量它们照样绿），
  // 只有把常量和文案、规范口径绑死，才能挡住「改常量顺便改文案自圆其说」这类漂移。
  it("端口常量字面值契约：1、65535、22", () => {
    expect(PORT_MIN).toBe(1);
    expect(PORT_MAX).toBe(65535);
    expect(SSH_DEFAULT_PORT).toBe(22);
  });
});

describe("portIssue", () => {
  it("边界值合法：1 与 65535 都不报错", () => {
    expect(portIssue(PORT_MIN, { label: LABEL })).toBeUndefined();
    expect(portIssue(PORT_MAX, { label: LABEL })).toBeUndefined();
    expect(portIssue(SSH_DEFAULT_PORT, { label: LABEL })).toBeUndefined();
  });

  it("越界、小数、负数各自给出可展示的文案", () => {
    expect(portIssue(0, { label: LABEL })).toContain("SSH 端口需在 1–65535 之间（当前 0）");
    expect(portIssue(65536, { label: LABEL })).toContain("（当前 65536）");
    expect(portIssue(-1, { label: LABEL })).toContain("1–65535");
    // 文案里的区间写成字面量：常量一改这里就红，这才是「唯一出处」的意义。
    expect(portIssue(PORT_MAX + 1, { label: LABEL })).toContain("1–65535 之间（当前 65536）");
    expect(portIssue(80.5, { label: LABEL })).toContain("SSH 端口必须是整数");
  });

  it("留空：必填报错、可选放行", () => {
    expect(portIssue(undefined, { label: LABEL })).toContain("SSH 端口不能为空");
    expect(portIssue(undefined, { label: LABEL, optional: true })).toBeUndefined();
  });

  it("文案跟随当前语言", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en-US" });

    expect(portIssue(999999, { label: "SSH Port" })).toContain("SSH Port must be between 1 and 65535 (current: 999999)");
    expect(portIssue(undefined, { label: "SSH Port" })).toContain("SSH Port is required");
  });
});

describe("sshPortIssues", () => {
  const labels = { port: "SSH 端口", localPort: "本地端口" };

  it("没启用 SSH 就不拿默认值去报错", () => {
    expect(sshPortIssues(undefined, labels)).toEqual([]);
  });

  it("一份配置里两个端口都非法时，按 SSH 端口、本地端口的顺序给全", () => {
    const issues = sshPortIssues({ port: 0, localPort: 70000 }, labels);

    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("SSH 端口需在 1–65535 之间（当前 0）");
    expect(issues[1]).toContain("本地端口需在 1–65535 之间（当前 70000）");
  });

  it("本地端口留空是合法的（交给系统自动分配）", () => {
    expect(sshPortIssues({ port: 22, localPort: undefined }, labels)).toEqual([]);
  });

  it("返回的是文案而不是 undefined 的混排数组，调用方可以直接取 [0] 当禁用理由", () => {
    const issues = sshPortIssues({ port: undefined, localPort: undefined }, labels);

    expect(issues.every((message) => typeof message === "string" && message.length > 0)).toBe(true);
  });
});
