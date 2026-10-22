/**
 * 「要不要带阿里云 MSE 签名」只许有一个判据，且 Go 与 TS 两条腿同规则（轮65）。
 *
 * 缺陷长什么样：`internal/provider/nacos.go` 里四个消费点
 * （挂不挂签名头、namespace 的 public→空、group 的空→DEFAULT_GROUP、探活走哪个接口）
 * 各自抄了一遍 `distribution==aliyun-mse && authType==aliyun-aksk`。
 * 用户 AK/SK 填了、两个下拉没配对 → 四处一起判 false → 请求匿名发出 →
 * 服务端把 `authorization failed: ... accessKeyId can't be null` 原文甩到界面
 * （2026-10-22 真机第 5 步 403）。抄一遍的代价就是「要改得改四处，漏一处就是另一颗 403」：
 * 签名 resource 与实际发出去的 namespace/group 错开，服务端永远拒。
 *
 * 口径：
 * 1. Go 侧枚举比较只许出现在 `nacosRequestSignRequested` 里一次，四个消费点必须调它；
 * 2. 判据必须含「凭据齐了就签名」这一半（真机形态的成因）；
 * 3. TS 侧同源判据落在 `src/lib/nacosSigning.ts`，`src/api/nacos.ts` 不许再抄枚举比较；
 * 4. 非 2xx 的报错文案只有一个出口 `statusError`，且 403 要 AccessKey 时按
 *    「这次到底签没签」分两条动作，不许把服务端原文当人话转述。
 * 变异对照：把判据拆回两处、删掉凭据那一半、api 层自己抄枚举，都必须判红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const GO_PROVIDER = "internal/provider/nacos.go";
const GO_REQUEST = "internal/nacos/request.go";
const TS_SIGNING_LIB = "src/lib/nacosSigning.ts";
const TS_API = "src/api/nacos.ts";

const PREDICATE = "nacosRequestSignRequested";
/** Go 里那两个枚举的下拉配对比较（判据唯一合法的家）。 */
const GO_ENUM_PAIR = /profile\.Distribution == DistributionAliyunMSE && profile\.AuthType == AuthAliyunAKSK/;
/** 凭据驱动的那一半：AK/SK 都非空即签名。 */
const GO_CREDENTIAL_CLAUSE = /strings\.TrimSpace\(profile\.AccessKeyID\) != "" && strings\.TrimSpace\(profile\.AccessKeySecret\) != ""/;
/** TS 侧同一半的写法（守卫用它做变异对照）。 */
const TS_CREDENTIAL_CLAUSE = /hasCredential\(subject\.accessKeyId\) && hasCredential\(subject\.accessKeySecret\)/;
/** 服务端原文的错误文案形状（只许活在 statusError 里）。 */
const GO_RAW_STATUS_ERROR = /fmt\.Errorf\("Nacos 返回 %d/;
/** TS 里抄枚举的形状：`x === "aliyun-mse"` 或 `x === "aliyun-aksk"`。 */
const TS_ENUM_COMPARISON = /===\s*"aliyun-(mse|aksk)"/g;

function read(rel: string): string {
  return stripComments(readFileSync(join(PROJECT_ROOT, rel), "utf8"));
}

/** 取 Go 顶层函数体（从 `func name(` 到本行顶格的 `}`），找不到返回 null。 */
function goFuncBody(text: string, name: string): string | null {
  const start = text.search(new RegExp(`func (?:\\([^)]*\\) )?${name}\\(`));
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  const close = text.slice(open).search(/\n\}/);
  if (close < 0) return null;
  return text.slice(open, open + close);
}

/** 违规清单：空数组即合格。 */
function providerProblems(text: string): string[] {
  const problems: string[] = [];
  const predicateBody = goFuncBody(text, PREDICATE);
  if (!predicateBody) {
    return [`${GO_PROVIDER} 里没有 ${PREDICATE} 函数：签名判据又散回各消费点了`];
  }
  if (!GO_CREDENTIAL_CLAUSE.test(predicateBody)) {
    problems.push(`${PREDICATE} 缺了「凭据齐了就签名」那一半：填了 AK/SK 但下拉没配对的连接仍会匿名请求`);
  }

  const consumers = ["clientFor", "TestConnection", "normalizeMSERequestNamespace", "normalizeMSERequestGroup"];
  for (const consumer of consumers) {
    const body = goFuncBody(text, consumer);
    if (!body) {
      problems.push(`${GO_PROVIDER} 里找不到 ${consumer}：判据消费点改名了，守卫要同步`);
      continue;
    }
    if (!body.includes(`${PREDICATE}(profile)`)) {
      problems.push(`${consumer} 没有调用 ${PREDICATE}(profile)：会出现「签名 resource 与实际参数错开」的 403`);
    }
  }

  const enumPairs = [...text.matchAll(new RegExp(GO_ENUM_PAIR.source, "g"))];
  if (enumPairs.length !== 1) {
    problems.push(`${GO_ENUM_PAIR.source} 出现 ${enumPairs.length} 处：枚举比较只许写在 ${PREDICATE} 里`);
  }
  return problems;
}

function requestProblems(text: string): string[] {
  const problems: string[] = [];
  const statusError = goFuncBody(text, "statusError");
  if (!statusError) {
    return [`${GO_REQUEST} 里没有 statusError：非 2xx 又变成两处各自拼文案了`];
  }
  if (!statusError.includes("ErrAccessKeyRejected")) {
    problems.push("statusError 没把「服务端在要 AccessKey」翻译成 ErrAccessKeyRejected，界面会继续转述服务端原文");
  }
  for (const site of ["getTextOnce", "sendFormOnce"]) {
    const body = goFuncBody(text, site);
    if (!body) {
      problems.push(`${GO_REQUEST} 里找不到 ${site}：请求出口改名了，守卫要同步`);
      continue;
    }
    if (!body.includes("c.statusError(")) {
      problems.push(`${site} 没走 statusError，403 的 AccessKey 报文会绕过翻译`);
    }
    if (GO_RAW_STATUS_ERROR.test(body)) {
      problems.push(`${site} 自己拼 "Nacos 返回 %d" 原文：报错出口只能有一个`);
    }
  }
  const advice = goFuncBody(readFileSync(join(PROJECT_ROOT, "internal/nacos/mse_auth.go"), "utf8"), "accessKeyAdvice");
  return problems.concat(advice === null ? ["mse_auth.go 里没有 accessKeyAdvice：分不清这次到底签没签"] : []);
}

function apiProblems(text: string): string[] {
  const problems: string[] = [];
  if (TS_ENUM_COMPARISON.test(text)) {
    problems.push(`${TS_API} 里还有自己抄的下拉枚举比较：判据必须来自 ${TS_SIGNING_LIB}`);
  }
  if (!/from "\.\.\/lib\/nacosSigning"/.test(text)) {
    problems.push(`${TS_API} 没有引用 ${TS_SIGNING_LIB}`);
  }
  return problems;
}

function signingLibProblems(text: string): string[] {
  const problems: string[] = [];
  if (!/subject\.distribution === "aliyun-mse" && subject\.authType === "aliyun-aksk"/.test(text)) {
    problems.push(`${TS_SIGNING_LIB} 的下拉配对判据与 Go 不一致了`);
  }
  if (!TS_CREDENTIAL_CLAUSE.test(text)) {
    problems.push(`${TS_SIGNING_LIB} 缺了凭驱动的那一半，前后端会判出两种连接`);
  }
  return problems;
}

describe("阿里云 MSE 签名判据 stays single source（轮65）", () => {
  it("Go provider：四个消费点共用一个判据", () => {
    expect(providerProblems(read(GO_PROVIDER))).toEqual([]);
  });

  it("Go request：报错只有一个出口，403 按签没签分两条动作", () => {
    expect(requestProblems(read(GO_REQUEST))).toEqual([]);
  });

  it("TS：api 层不抄枚举，判据落在 lib 且与 Go 同规则", () => {
    expect(apiProblems(read(TS_API))).toEqual([]);
    expect(signingLibProblems(read(TS_SIGNING_LIB))).toEqual([]);
  });

  it("变异对照：判据拆成两处／凭据那一半被删／api 自己抄枚举，都必须判红", () => {
    const provider = read(GO_PROVIDER);
    const duplicated = provider.replace(
      "func normalizeMSERequestGroup(profile ConnectionProfile, group string) string {",
      "func normalizeMSERequestGroup(profile ConnectionProfile, group string) string {\n\tif profile.Distribution == DistributionAliyunMSE && profile.AuthType == AuthAliyunAKSK {\n\t\t// 抄了一份判据\n\t}"
    );
    expect(providerProblems(duplicated).length).toBeGreaterThan(0);

    const withoutCredentials = provider.replace(GO_CREDENTIAL_CLAUSE, "false");
    expect(providerProblems(withoutCredentials).length).toBeGreaterThan(0);

    const predicateRemoved = provider.replace(new RegExp(`func ${PREDICATE}\\(`), "func renamedPredicate(");
    expect(providerProblems(predicateRemoved).length).toBeGreaterThan(0);

    const api = read(TS_API);
    expect(apiProblems(api.replace("nacosRequestSignRequested(profile)", 'conn.distribution === "aliyun-mse"')).length).toBeGreaterThan(0);
    expect(apiProblems(api.replace(/from "\.\.\/lib\/nacosSigning"/, 'from "../lib/somewhereElse"')).length).toBeGreaterThan(0);

    const lib = read(TS_SIGNING_LIB);
    expect(signingLibProblems(lib.replace(TS_CREDENTIAL_CLAUSE, "false")).length).toBeGreaterThan(0);

    const request = read(GO_REQUEST);
    expect(requestProblems(request.replace("c.statusError(resp.StatusCode, req, text)", 'fmt.Errorf("boom")')).length).toBeGreaterThan(0);
    expect(
      requestProblems(request.replace(/func \(c \*Client\) statusError\(/, "func (c *Client) renamedStatusError(")).length
    ).toBeGreaterThan(0);
  });
});
