/**
 * 后端报错文案的两条硬约束（轮101）：说得出动作，且不夹带凭据。
 *
 * 这一轮是在真机第 5 步失败后回头扫出来的三类「等于没说」：
 * 1. 源码里的中文被工具写成 ASCII 问号（`internal/nacos/request.go` 的两条解码错误，
 *    自 2026-07-23 起界面就照抄一串 `???????`）；
 * 2. 服务端用 HTTP 成功 + 正文 `false` 表态时，界面上只有「发布失败: false」两个字，
 *    批量写入十几条时连「哪一份没写成」都看不出来；
 * 3. 错误文案里直接抄 `req.URL.RawQuery` —— Nacos v1 的 accessToken 就挂在查询串上，
 *    等于把会话令牌抄进界面、操作历史和用户复制出去的文本。
 *
 * 三条都能静态判，所以立守卫而不是靠自觉：文案是会被改回去的东西（同一判据在多处抄写、
 * 或下次重构时把 sanitizeQuery 当成多余的包装删掉）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const GO_SHAPES = "internal/nacos/error_shapes.go";
const GO_REQUEST = "internal/nacos/request.go";
const GO_CONFIG = "internal/nacos/config.go";
const BRIDGE = "tests/retest/bridge/retestBinding.ts";

/** 写入被拒文案里必须同源的关键短语（Go 与复测桥两边都要有，漂一条就判红）。 */
const SHARED_PHRASES = [
  "这次写入没有被服务端接受",
  "未写成（位置 ",
  "服务端没有给出任何原因",
  "服务端只回了 false，没有给出原因",
  "服务端原话：",
  "接下来依次确认：当前凭据对这个命名空间与分组有没有这项操作的权限",
];

/** 读文件并剥注释：注释里出现旧句式不算违规（那是给人解释历史的）。 */
function read(rel: string): string {
  return stripComments(readFileSync(join(PROJECT_ROOT, rel), "utf8"));
}

/** 递归列出要扫的非测试 Go 文件（含包内子目录，不含 build 产物目录）。 */
function goSources(dir = "internal", acc: string[] = []): string[] {
  const abs = join(PROJECT_ROOT, dir);
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "build" || name === "dist") continue;
    const rel = posix.join(dir, name);
    const child = join(PROJECT_ROOT, rel);
    if (statSync(child).isDirectory()) {
      goSources(rel, acc);
    } else if (name.endsWith(".go") && !name.endsWith("_test.go")) {
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * mojibake 判据：`fmt.Errorf(...)` / `errors.New(...)` 的第一段字面量里不许有 ASCII 问号。
 *
 * 为什么这条能零误报：全仓非测试 Go 代码里带 ASCII 问号的字符串字面量只有那两处坏掉的中文，
 * 其余命中都在 WebDAV 的 ``<?xml`` 反引号原始串里（不是错误文案）。中文界面的疑问句用全角「？」。
 */
function mojibakeProblems(text: string): string[] {
  const problems: string[] = [];
  const pattern = /(?:fmt\.Errorf|errors\.New)\(\s*(?:"([^"]*)"|`([^`]*)`)/g;
  for (const match of text.matchAll(pattern)) {
    const literal = match[1] ?? match[2] ?? "";
    if (literal.includes("?")) {
      problems.push(`错误文案含 ASCII 问号（中文被写成问号了的形态）: ${literal.slice(0, 60)}`);
    }
  }
  return problems;
}

/** 写入被拒只能有一个出口：`writeRefusal.err`，不许再直转述 true/false 正文。 */
function refusalProblems(configText: string, shapesText: string): string[] {
  const problems: string[] = [];
  if (/fmt\.Errorf\("(发布|删除)失败: %s"/.test(configText)) {
    problems.push("config.go 还在直转述写入结果（发布失败/删除失败 + 正文），批量写入时报不出是哪一份");
  }
  const publishCalls = (configText.match(/refusal\.err\(/g) ?? []).length;
  if (publishCalls < 4) {
    problems.push(`写入被拒的出口只剩 ${publishCalls} 处，v1/v3 的发布与删除共需 4 处`);
  }
  if (!/type writeRefusal struct/.test(shapesText)) {
    problems.push("writeRefusal 类型不见了：文案没有单一归属");
  }
  for (const phrase of SHARED_PHRASES) {
    if (!shapesText.includes(phrase)) {
      problems.push(`Go 侧写入被拒文案缺关键短语: ${phrase}`);
    }
  }
  if (/Delete|Remove/.test(shapesText.match(/func \(w writeRefusal\) err[\s\S]*?\n\}/)?.[0] ?? "")) {
    problems.push("writeRefusal 自己不动文件系统：它只负责说话，删除动作在 config.go 的调用点");
  }
  return problems;
}

/** 拒绝分类的顺序与判据形状。 */
function classificationProblems(requestText: string, shapesText: string): string[] {
  const problems: string[] = [];
  const status = requestText.match(/func \(c \*Client\) statusError[\s\S]*?\n\}/)?.[0];
  if (!status) {
    return ["statusError 不见了：非 2xx 的报错出口不能散在各处"];
  }
  const accessKeyAt = status.indexOf("asksForAccessKey(body)");
  const permissionAt = status.indexOf("isPermissionShape(body)");
  if (accessKeyAt < 0 || permissionAt < 0) {
    problems.push("403/401 的两条分类出口少了一条（签名 / 权限）");
  } else if (accessKeyAt > permissionAt) {
    problems.push("权限分类排在签名分类之前：报文里同时有 Forbidden 与 authorization failed 时会把人派去找管理员开权限");
  }
  if (!/statusCode == http\.StatusForbidden \|\| statusCode == http\.StatusUnauthorized/.test(status)) {
    problems.push("分类只认 403 不够：MSE 侧对签名与授权的拒绝并不总用 403 表态");
  }
  if (!/return fmt\.Errorf\("Nacos 返回 %d/.test(status)) {
    problems.push("认不出来时必须保留状态码 + 路径 + 服务端原文兜底，不许擦掉");
  }
  const shape = shapesText.match(/func isPermissionShape[\s\S]*?\n\}/)?.[0] ?? "";
  if (!shape || !shape.includes("denied :=") || !shape.includes("targeted :=")) {
    problems.push("isPermissionShape 的两层指向词结构变了：只命中一层就定性是猜");
  }
  if (!/return denied && targeted/.test(shape)) {
    problems.push("isPermissionShape 必须两层同时命中才定性");
  }
  for (const word of ["permission", "权限", "authoriz", "授权"]) {
    if (!shape.includes(word)) {
      problems.push(`权限指向词缺 ${word}`);
    }
  }
  for (const word of ["denied", "forbidden", "拒绝", "not allowed"]) {
    if (!shape.includes(word)) {
      problems.push(`拒绝指向词缺 ${word}`);
    }
  }
  const advice = shapesText.match(/func permissionAdvice[\s\S]*?\n\}/)?.[0] ?? "";
  if (!/写入权限/.test(advice) || !/读取权限/.test(advice)) {
    problems.push("权限动作要按读/写分叉：写被拒教人开写权限，读被拒教人开读权限");
  }
  if (!advice.includes("重填 AccessKey 不会改变结果")) {
    problems.push("权限不足的动作文案要挡在「回去重填 AccessKey」这条误操作前面");
  }
  return problems;
}

/** 凭据不许进错误文案：requestPath 必须走 sanitizeQuery。 */
function credentialProblems(requestText: string): string[] {
  const problems: string[] = [];
  const path = requestText.match(/func requestPath[\s\S]*?\n\}/)?.[0] ?? "";
  if (!path) return ["requestPath 不见了"];
  if (/return req\.URL\.Path \+ "\?" \+ req\.URL\.RawQuery/.test(path)) {
    problems.push("requestPath 直接抄 RawQuery：v1 的 accessToken 会跟着进界面、操作历史和你复制出去的文本");
  }
  if (!path.includes("sanitizeQuery(")) {
    problems.push("requestPath 没走 sanitizeQuery");
  }
  const sanitize = requestText.match(/func sanitizeQuery[\s\S]*?\n\}/)?.[0] ?? "";
  if (!/strings\.Split\(raw, "&"\)/.test(sanitize) || !/key \+ "=\*\*\*"/.test(sanitize)) {
    problems.push("sanitizeQuery 只做值替换：重新编码会把别的参数重排并二次转义");
  }
  const key = requestText.match(/func sensitiveQueryKey[\s\S]*?\n\}/)?.[0] ?? "";
  for (const name of ['"accesstoken"', '"password"', '"secretkey"', '"securitytoken"', '"username"', '"token"']) {
    if (!key.includes(name)) {
      problems.push(`sensitiveQueryKey 少遮 ${name}`);
    }
  }
  if (!/strings\.Contains\(lowered, "token"\)|strings\.Contains\(lowered, "password"\)|strings\.Contains\(lowered, "secret"\)/.test(key)) {
    problems.push("sensitiveQueryKey 要有前缀兜底：命中不了只是少一条线索，命中漏了就是泄露");
  }
  return problems;
}

/** Go ⇄ 复测桥同源：桥量到的必须是真机上那句话。 */
function bridgeProblems(bridgeText: string): string[] {
  const problems: string[] = [];
  if (/throw new Error\(`(发布|删除)失败: \$\{text\}`\)/.test(bridgeText)) {
    problems.push("复测桥还在用旧句式抛写入被拒，复测量到的不是真机文案");
  }
  for (const phrase of SHARED_PHRASES) {
    if (!bridgeText.includes(phrase)) {
      problems.push(`复测桥缺与 Go 同源的关键短语: ${phrase}`);
    }
  }
  const asserted = (bridgeText.match(/assertWriteAccepted\(/g) ?? []).length;
  if (asserted < 5) {
    problems.push(`写入检查只剩 ${asserted - 1} 处调用点，provider 与 nacos 两条腿的发布/删除共需 4 处`);
  }
  if (!/function describeWriteRefusal/.test(bridgeText)) {
    problems.push("复测桥的写入被拒文案没有单一归属");
  }
  return problems;
}

describe("mojibake 闸门：后端错误文案里不许出现 ASCII 问号（轮101）", () => {
  it("非测试 Go 代码里的每一条错误文案都读得出人话", () => {
    const offenders: string[] = [];
    for (const rel of [...goSources(), "main.go"]) {
      for (const problem of mojibakeProblems(read(rel))) {
        offenders.push(`${rel}: ${problem}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("变异对照：中文被写成问号必须判红", () => {
    const clean = read(GO_REQUEST);
    expect(mojibakeProblems(clean)).toEqual([]);
    const mutated = clean.replace("无法按响应声明的编码 %q 解码响应体", "??????? %q ??");
    expect(mutated).not.toBe(clean);
    expect(mojibakeProblems(mutated)).not.toEqual([]);
  });
});

describe("写入被拒只有一个出口，且说得出位置与动作（轮101）", () => {
  it("v1 的 true/false 与 v3 的信封都走 writeRefusal", () => {
    expect(refusalProblems(read(GO_CONFIG), read(GO_SHAPES))).toEqual([]);
  });

  it("变异对照：改回直转述正文 / 关键短语漂走都判红", () => {
    const config = read(GO_CONFIG);
    const shapes = read(GO_SHAPES);
    const backToRaw = config.replace("return refusal.err(text)", 'return fmt.Errorf("发布失败: %s", truncate(text))');
    expect(backToRaw).not.toBe(config);
    expect(refusalProblems(backToRaw, shapes)).not.toEqual([]);

    const drifted = shapes.replace("这次写入没有被服务端接受", "写入未成功");
    expect(drifted).not.toBe(shapes);
    expect(refusalProblems(config, drifted)).not.toEqual([]);
  });
});

describe("403/401 的分类顺序与「认不出来就留原文」的兜底（轮101）", () => {
  it("签名先于权限，两层指向词同时命中才定性，兜底原样转述", () => {
    expect(classificationProblems(read(GO_REQUEST), read(GO_SHAPES))).toEqual([]);
  });

  it("变异对照：权限抢在签名前 / 单层指向词就定性都判红", () => {
    const request = read(GO_REQUEST);
    const shapes = read(GO_SHAPES);
    const statusBody = request.match(/func \(c \*Client\) statusError[\s\S]*?\n\}/)?.[0] ?? "";
    const keyBlock = statusBody.match(/\n\t\tif asksForAccessKey\(body\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
    const permBlock = statusBody.match(/\n\t\tif isPermissionShape\(body\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
    expect(keyBlock).not.toBe("");
    expect(permBlock).not.toBe("");
    const flipped = request.replace(
      statusBody,
      statusBody.replace(keyBlock + permBlock, () => permBlock + keyBlock)
    );
    expect(flipped).not.toBe(request);
    expect(classificationProblems(flipped, shapes)).not.toEqual([]);

    const oneLayer = shapes.replace("return denied && targeted", "return denied || targeted");
    expect(oneLayer).not.toBe(shapes);
    expect(classificationProblems(request, oneLayer)).not.toEqual([]);
  });
});

describe("错误文案不夹带凭据（轮101）", () => {
  it("requestPath 遮掉 token 类参数，其余线索一条不少", () => {
    expect(credentialProblems(read(GO_REQUEST))).toEqual([]);
  });

  it("变异对照：抄回 RawQuery / 少遮一类键都判红", () => {
    const request = read(GO_REQUEST);
    const raw = request.replace("return req.URL.Path + \"?\" + sanitizeQuery(req.URL.RawQuery)", 'return req.URL.Path + "?" + req.URL.RawQuery');
    expect(raw).not.toBe(request);
    expect(credentialProblems(raw)).not.toEqual([]);

    const halfBlind = request.replace('"secretkey", ', "");
    expect(halfBlind).not.toBe(request);
    expect(credentialProblems(halfBlind)).not.toEqual([]);
  });
});

describe("复测桥与 Go 的写入被拒文案同源（轮101）", () => {
  it("桥里抛出的就是真机上用户看到的那句", () => {
    expect(bridgeProblems(read(BRIDGE))).toEqual([]);
  });

  it("变异对照：桥改回旧句式 / 关键短语单边漂都判红", () => {
    const bridge = read(BRIDGE);
    const oldPhrase = bridge.replace(
      "return `${WRITE_REFUSAL_PREFIX}：${action}未写成（位置 ${location}）。${reason}${WRITE_REFUSAL_CHECKS}`;",
      'return `${action}失败: ${body}`;'
    );
    expect(oldPhrase).not.toBe(bridge);
    expect(bridgeProblems(oldPhrase)).not.toEqual([]);

    const drifted = bridge.replace("接下来依次确认：当前凭据对这个命名空间与分组有没有这项操作的权限", "接下来请检查权限");
    expect(drifted).not.toBe(bridge);
    expect(bridgeProblems(drifted)).not.toEqual([]);
  });
});
