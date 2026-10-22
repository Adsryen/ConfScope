/**
 * nacosSigning 判据单测（轮65）。
 *
 * 用例形状直接对着真机 403 与轮60 的回归：
 * 「标记齐了但凭据空」不能退化成匿名，「凭据齐了但标记没配」必须签名。
 */
import { describe, expect, it } from "vitest";
import { nacosAuthUsesAccessKey, nacosRequestSignRequested } from "./nacosSigning";

const AKSK = { accessKeyId: "ak-test", accessKeySecret: "sk-test" };

describe("nacosRequestSignRequested", () => {
  it("声明 MSE + AK/SK 时要求签名，即使凭据还没填（交给后端报缺凭据，不许匿名）", () => {
    expect(nacosRequestSignRequested({ distribution: "aliyun-mse", authType: "aliyun-aksk" })).toBe(true);
  });

  it("声明齐、凭据也齐：签名", () => {
    expect(nacosRequestSignRequested({ distribution: "aliyun-mse", authType: "aliyun-aksk", ...AKSK })).toBe(true);
  });

  it("真机 403 的形态：没标记 MSE，但 AK/SK 都填了 → 一样要签名", () => {
    expect(nacosRequestSignRequested({ distribution: "opensource", authType: "none", ...AKSK })).toBe(true);
    expect(nacosRequestSignRequested({ distribution: "opensource", authType: "aliyun-aksk", ...AKSK })).toBe(true);
    expect(nacosRequestSignRequested({ ...AKSK })).toBe(true);
  });

  it("凭据只填一半签不出来，保持匿名", () => {
    expect(nacosRequestSignRequested({ accessKeyId: "ak-test" })).toBe(false);
    expect(nacosRequestSignRequested({ accessKeySecret: "sk-test" })).toBe(false);
  });

  it("空白字符串按没填处理", () => {
    expect(nacosRequestSignRequested({ accessKeyId: "  ", accessKeySecret: "\t" })).toBe(false);
  });

  it("开源 Nacos 的账号密码连接不签名", () => {
    expect(nacosRequestSignRequested({ distribution: "opensource", authType: "nacos-password" })).toBe(false);
  });

  it("只选了发行版没选认证方式（且无凭据）：不是 AK/SK 通路", () => {
    expect(nacosRequestSignRequested({ distribution: "aliyun-mse", authType: "none" })).toBe(false);
  });
});

describe("nacosAuthUsesAccessKey", () => {
  it("认证方式选了 AK/SK 就不该去走 Nacos 用户名登录，哪怕凭据为空", () => {
    expect(nacosAuthUsesAccessKey({ distribution: "opensource", authType: "aliyun-aksk" })).toBe(true);
  });

  it("没选 AK/SK 但填齐凭据（真机形态）也认 AccessKey 通路", () => {
    expect(nacosAuthUsesAccessKey({ distribution: "opensource", authType: "none", ...AKSK })).toBe(true);
  });

  it("账号密码连接仍走登录", () => {
    expect(nacosAuthUsesAccessKey({ distribution: "opensource", authType: "nacos-password" })).toBe(false);
    expect(nacosAuthUsesAccessKey({ distribution: "opensource", authType: "none" })).toBe(false);
  });
});
