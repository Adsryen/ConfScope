/**
 * `translate()` 的占位替换守卫（波24 R43）。
 *
 * lib 层报错文案接进 i18n 之后，`{detail}` 里放的是底层异常原文、路径这类**数据**，
 * 里面出现 `$&` / `$'` / `$1` 时，`String.replace` 的字符串替换会把它们当特殊符号展开，
 * 于是用户看到的是 `boom {detail} tail` 这种半成品。这条守卫盯的就是这个。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../../src/locales";

function useLocale(locale: string): void {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {}, removeItem: () => {}, clear: () => {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("translate() 占位替换", () => {
  it("带 $ 的原文原样保留，不被 replace 吞掉", () => {
    useLocale("zh-CN");
    const detail = "Error: secret not found $& at C:\\$HOME\\app.csbackup";
    expect(translate("appDataBackup.resolveSecretFailed", { ref: "connection.conn-1.password", detail })).toBe(
      `导出应用数据备份前无法解析 connection.conn-1.password：${detail}`
    );
  });

  it("同一个占位出现多次时全部替换", () => {
    useLocale("zh-CN");
    expect(translate("credentials.statusUnresolvable", { ref: "$'ref", status: "missing" })).toBe(
      "凭据 $'ref 当前状态为 missing，无法从系统凭据库读取"
    );
  });

  it("数字参数按字符串插入，另一种语言同样成立", () => {
    useLocale("en-US");
    expect(translate("appDataBackup.summarySnapshots", { count: 12 })).toBe("Snapshot files: 12");
    useLocale("zh-CN");
    expect(translate("appDataBackup.summarySnapshots", { count: 12 })).toBe("快照文件：12");
  });
});
