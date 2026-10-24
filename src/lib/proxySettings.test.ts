/**
 * 代理输入判据（轮72 R-B2）。
 *
 * 钉的是「界面上的说法与 Go 侧实际能力一致」：这些用例每一条都对应一种
 * 「设置页看起来正常、检查更新其实没走代理」的静默失败。
 */
import { describe, expect, it } from "vitest";
import {
  PROXY_FIELDS,
  isSameProxy,
  normalizeNoProxyList,
  readNoProxyField,
  readProxyField,
  readProxyUrlField,
  type ProxyFieldOutcome,
} from "./proxySettings";

/**
 * 取「非法」那一支。判据本身是判别联合（valid:false 才带 issue/detail），
 * 直接 `.detail` 在合法支上不存在——先在这里断一次非法，再让 TS 收窄，
 * 用例才既钉住行为又不至于靠 as 把类型口子撕开。
 */
function asInvalid(outcome: ProxyFieldOutcome) {
  expect(outcome.valid, "这条本该判非法").toBe(false);
  if (outcome.valid) throw new Error("unreachable：上面已经断过 valid === false");
  return outcome;
}

describe("代理地址一框", () => {
  it("首尾空格一律 trim 掉，合法地址原样保留大小写以外的部分", () => {
    expect(readProxyUrlField("  http://127.0.0.1:7890  ")).toEqual({ value: "http://127.0.0.1:7890", valid: true, issue: "" });
    expect(readProxyUrlField("http://user:pass@proxy.internal:3128/base").valid).toBe(true);
  });

  it("空串是「不使用代理」，不是错误", () => {
    expect(readProxyUrlField("")).toEqual({ value: "", valid: true, issue: "" });
    expect(readProxyUrlField("   ")).toEqual({ value: "", valid: true, issue: "" });
  });

  it("协议名归一小写：Go 用 Scheme == \"https\" 决定要不要 CONNECT，HTTP:// 会被当明文转发", () => {
    expect(readProxyUrlField("HTTP://proxy.internal:3128").value).toBe("http://proxy.internal:3128");
    expect(readProxyUrlField("HTTPS://proxy.internal:3128").value).toBe("https://proxy.internal:3128");
  });

  it("缺协议、缺主机名、非 http(s) 协议都拒绝——它们在 Go 里全是静默不走代理", () => {
    for (const raw of ["not-a-url", "127.0.0.1:7890", "http://", "http://:7890", "socks5://127.0.0.1:1080", "ftp://proxy/x"]) {
      const outcome = readProxyUrlField(raw);
      expect(outcome.valid, `${raw} 不该被接受`).toBe(false);
      expect(outcome.issue).toBe("url");
      expect(outcome.value, "被拒绝时把草稿原样带回去，界面才能回显用户写的东西").toBe(raw.trim());
    }
  });

  it("IPv6 与默认端口写法都算有主机名", () => {
    expect(readProxyUrlField("http://[::1]:7890").valid).toBe(true);
    expect(readProxyUrlField("https://proxy.internal").valid).toBe(true);
  });
});

describe("不走代理一框", () => {
  it("逐项 trim、丢掉空项、用逗号拼回", () => {
    expect(normalizeNoProxyList("  localhost , 127.0.0.1 ,  ")).toBe("localhost,127.0.0.1");
    expect(readNoProxyField(" .internal,,10.0.0.0/8 ")).toEqual({ value: ".internal,10.0.0.0/8", valid: true, issue: "" });
    expect(readNoProxyField("").value).toBe("");
  });

  it("*.example.com 在 Go 的 noProxyMatch 里永远匹配不上，提交时归一成 .example.com", () => {
    expect(normalizeNoProxyList("*.example.com,foo")).toBe(".example.com,foo");
  });

  it("带协议前缀或空格的表项拒绝，并点名是哪一项", () => {
    const withScheme = readNoProxyField("localhost,http://127.0.0.1");
    expect(withScheme.issue).toBe("noProxyItem");
    expect(asInvalid(withScheme).detail).toBe("http://127.0.0.1");

    const withSpace = readNoProxyField("local host");
    expect(asInvalid(withSpace).detail).toBe("local host");
  });

  it("CIDR 只拦明显写错的（位数越界、缺前缀），其余交给 Go 判", () => {
    expect(readNoProxyField("10.0.0.0/8,192.168.0.0/16").valid).toBe(true);
    expect(readNoProxyField("10.0.0.0/512").valid).toBe(false);
    expect(readNoProxyField("10.0.0.0/").valid).toBe(false);
    expect(readNoProxyField("*").valid).toBe(true);
  });
});

describe("字段分派与草稿比较", () => {
  it("readProxyField 按字段选判据：代理两框走 URL，noProxy 走列表", () => {
    expect(readProxyField("httpProxy", "not-a-url").issue).toBe("url");
    expect(readProxyField("httpsProxy", "not-a-url").issue).toBe("url");
    expect(readProxyField("noProxy", "not-a-url").valid).toBe(true);
    expect(PROXY_FIELDS).toEqual(["httpProxy", "httpsProxy", "noProxy"]);
  });

  it("isSameProxy 逐字段比：设置页只在已提交值真的变了时才覆盖草稿", () => {
    const base = { httpProxy: "http://a:1", httpsProxy: "", noProxy: "localhost" };
    expect(isSameProxy(base, { ...base })).toBe(true);
    expect(isSameProxy(base, { ...base, httpsProxy: "http://b:2" })).toBe(false);
    // 逐字段比字符串、不做归一：归一是提交时的事，这里只回答「已提交值真的变了没」
    expect(isSameProxy(base, { ...base, noProxy: "localhost," })).toBe(false);
  });
});
