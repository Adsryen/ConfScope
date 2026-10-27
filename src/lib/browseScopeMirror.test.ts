/**
 * 作用域镜像必须跨实例（轮97 K3）。
 *
 * 钉的是三件事：报上去的是「最新那一份」、读的人拿到的是同一份、
 * 卸载只清自己写的那一次——换 key 重挂载时新实例可能已经先报上了，
 * 照值清会把新作用域一起清没，旧「重试」于是判成「页面不在了」。
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearBrowseScope, readBrowseScope, reportBrowseScope } from "./browseScopeMirror";

const dev = { connId: "dev", tenant: "public", scopeLabel: "dev / public" };
const qa = { connId: "qa", tenant: "qa-public", scopeLabel: "qa / qa-public" };

describe("browseScopeMirror", () => {
  afterEach(() => {
    // 单例：每条用例自己报自己清，别把上一轮的账留给下一条
    const last = readBrowseScope();
    if (last) clearBrowseScope(last);
  });

  it("没挂载过时读到 null，调用方据此拒绝执行", () => {
    expect(readBrowseScope()).toBeNull();
  });

  it("报上去的作用域立即可读", () => {
    reportBrowseScope(dev);
    expect(readBrowseScope()).toEqual(dev);
  });

  it("卸载按身份清：旧实例清不掉新实例报上的那一份", () => {
    const oldScope = reportBrowseScope(dev);
    // 换 key 重挂载：新实例先报上，旧实例的卸载清理随后才跑
    reportBrowseScope(qa);
    clearBrowseScope(oldScope);
    expect(readBrowseScope()?.scopeLabel, "照值清会把新作用域一起清没").toBe("qa / qa-public");

    clearBrowseScope(readBrowseScope()!);
    expect(readBrowseScope()).toBeNull();
  });

  it("同值再报一次也是新的一份账，不会互相顶掉", () => {
    const first = reportBrowseScope({ ...dev });
    const second = reportBrowseScope({ ...dev });
    clearBrowseScope(first);
    expect(readBrowseScope(), "身份不同就不该清掉当前这份").not.toBeNull();
    clearBrowseScope(second);
    expect(readBrowseScope()).toBeNull();
  });
});
