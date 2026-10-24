#!/usr/bin/env node
/**
 * 安装包字符串体检：证明「界面上的中文」在编译产物里真的是正确的 UTF-16，
 * 而不是 UTF-8 字节被当成单字节码页读出来的乱码。
 *
 * 为什么需要这一支（轮70，v1.9.9 线上事故）：
 *   project.nsi 缺 UTF-8 BOM 时，Windows 上的 makensis 按宿主 ANSI 码页（en-US = CP1252）
 *   解释脚本源码，Unicode true 只保证运行时用 UTF-16，救不了源码阶段的解码。
 *   于是「等待 ConfScope 退出」被编成 「ç­å¾… ConfScope é‡å°º」这类形态，
 *   用户在安装进度页看到乱码。
 *   而我们的语法闸门（check-windows-installer.sh）跑在 ubuntu：POSIX 侧的 makensis
 *   恒按 UTF-8 读脚本，C.UTF-8 / C / ISO-8859-1 四种 locale 下产物 sha256 全等
 *   —— 这一类缺陷在 Linux 侧**原理上不可见**，只能验产物。
 *
 * 做法：NSIS 的头部数据块跟在 "NullsoftInst" 签名后面，块头是
 *   flags(4) / compressed_size(4，最高位=压缩标志) / real_size(4)，
 * 压缩块是 raw deflate。解出来之后扫 UTF-16LE 文本串：
 *   任一串若能「按 CP1252/Latin-1 编回字节 → 再按 UTF-8 解出中日韩」，它就是乱码，判红。
 * 这是负向判据：不依赖 NSIS 版本，也不依赖内置语言表里正确的中文。
 *
 * 用法：node scripts/check-installer-strings.mjs build/bin/confscope-windows-amd64-installer.exe
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

// CP1252 与 Latin-1 只在 0x80–0x9F 这 27 个位置不同；0x81/0x8D/0x8F/0x90/0x9D
// 在 Windows 上是「未定义」，MultiByteToWideChar 通常原样透成 U+0081 这类码位，
// 所以编码时把 <0x100 的字符一律当成对应字节，再叠加这张差异表。
const CP1252_TO_BYTE = new Map(
  [
    [0x80, "\u20ac"], [0x82, "\u201a"], [0x83, "\u0192"], [0x84, "\u201e"], [0x85, "\u2026"],
    [0x86, "\u2020"], [0x87, "\u2021"], [0x88, "\u02c6"], [0x89, "\u2030"], [0x8a, "\u0160"],
    [0x8b, "\u2039"], [0x8c, "\u0152"], [0x8e, "\u017d"], [0x91, "\u2018"], [0x92, "\u2019"],
    [0x93, "\u201c"], [0x94, "\u201d"], [0x95, "\u2022"], [0x96, "\u2013"], [0x97, "\u2014"],
    [0x98, "\u02dc"], [0x99, "\u2122"], [0x9a, "\u0161"], [0x9b, "\u203a"], [0x9c, "\u0153"],
    [0x9e, "\u017e"], [0x9f, "\u0178"],
  ].map(([b, ch]) => [ch, b]),
);

const MAGIC = Buffer.from("NullsoftInst", "latin1");
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3001\u3002\uff01-\uff5e]/;

function charToByte(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x100) return code;
  return CP1252_TO_BYTE.get(ch) ?? null;
}

/** 把一串「看起来像 UTF-8 被单字节码页读过的乱码」还原回去；还原不出合法中文就返回 null。 */
function demojibake(s) {
  const bytes = [];
  for (const ch of s) {
    const b = charToByte(ch);
    if (b === null) return null;
    bytes.push(b);
  }
  const buf = Buffer.from(bytes);
  try {
    const back = buf.toString("utf8");
    // toString 不会因非法序列报错，坏字节会变成 U+FFFD；用它当严格校验
    if (back.includes("\uFFFD")) return null;
    return CJK.test(back) ? back : null;
  } catch {
    return null;
  }
}

/**
 * 解出签名后面的头部块。实测（v1.9.9 线上包与本地包都验过）签名后依次是
 *   F0=本块解压后长度  F1=数据区总长  F2=压缩长度（最高位=1 表示 deflate）
 * 压缩流紧跟在 F2 之后，是 raw deflate。两个数都对不上就丢弃这块——
 * 判据宁可少看一段，也不要把没解对的数据当成结论。
 */
export function headerBlocks(buf) {
  const out = [];
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) {
    if (i + 24 > buf.length) continue;
    const realSize = buf.readUInt32LE(i + 12);
    const cszField = buf.readUInt32LE(i + 20);
    const size = cszField & 0x7fffffff;
    if (realSize <= 0 || realSize > 8 * 1024 * 1024 || size <= 0 || i + 24 + size > buf.length) continue;
    const slice = buf.subarray(i + 24, i + 24 + size);
    if (!(cszField & 0x80000000)) {
      out.push({ at: i, realSize, data: Buffer.from(slice) });
      continue;
    }
    try {
      const data = inflateRawSync(slice, { maxOutputLength: realSize + 4096 });
      if (data.length === realSize) out.push({ at: i, realSize, data });
    } catch {
      /* 不是预期的 deflate 流：跳过 */
    }
  }
  return out;
}

/** 从二进制里抽 UTF-16LE 文本串（长度 >= 4 个码元）。 */
export function utf16Runs(buf, minLength = 4) {
  const runs = [];
  let cur = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    const textish = code >= 0x20 && code !== 0xfffd && code < 0xd800;
    if (textish) {
      cur += String.fromCharCode(code);
    } else {
      if (cur.length >= minLength) runs.push(cur);
      cur = "";
    }
  }
  if (cur.length >= minLength) runs.push(cur);
  return runs;
}

export function audit(buf) {
  const blocks = headerBlocks(buf);
  const bad = [];
  let cjk = 0;
  for (const b of blocks) {
    for (const run of utf16Runs(b.data)) {
      if (CJK.test(run)) cjk += 1;
      const restored = demojibake(run);
      if (restored) bad.push({ run, restored });
    }
  }
  return { blocks: blocks.length, cjkRuns: cjk, bad };
}


/** 造一个只有头部块的假安装包，用来证明「乱码判据本身有效」。 */
export function fakeInstaller(strings) {
  const payload = Buffer.concat(strings.map((s) => Buffer.concat([Buffer.from(s, "utf16le"), Buffer.from([0, 0])])));
  const block = deflateRawSync(payload);
  const header = Buffer.alloc(24);
  header.write("NullsoftInst", 0, "latin1");
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(block.length, 16);
  header.writeUInt32LE(block.length + 0x80000000, 20);
  return Buffer.concat([Buffer.from("MZstub"), header, block, Buffer.alloc(4)]);
}

function selfTest() {
  const good = "ConfScope 已退出，继续覆盖安装";
  const mangled = [...Buffer.from(good, "utf8")].map((b) => String.fromCharCode(b)).join("");
  const cases = [
    { name: "正确中文不该判红", buf: fakeInstaller([good, "Installation complete", "\n"]), expectBad: 0 },
    { name: "CP1252 形态的乱码必须判红", buf: fakeInstaller([mangled]), expectBad: 1 },
    { name: "解不出头部块必须判红（不许静默跳过）", buf: Buffer.alloc(4096), expectBlocks: 0 },
  ];
  let failed = 0;
  for (const c of cases) {
    const r = audit(c.buf);
    const okBlocks = c.expectBlocks === undefined || r.blocks === c.expectBlocks;
    const okBad = c.expectBad === undefined || r.bad.length === c.expectBad;
    const pass = okBlocks && okBad;
    if (!pass) failed += 1;
    console.log(`${pass ? "ok  " : "FAIL"} ${c.name}（blocks=${r.blocks} bad=${r.bad.length}）`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

// 直接执行才跑 CLI（被 import 时不跑）。Windows 上 process.argv[1] 是 D:\a\... 而 import.meta.url
// 是 file:///D:/a/...，逐字比对会恒假——CI 里这一步就会静默退出 0，闸门变成空气。
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv.includes("--self-test")) selfTest();
  const target = process.argv[2];
  if (!target) {
    console.error("用法：node scripts/check-installer-strings.mjs <安装包路径>");
    process.exit(2);
  }
  const result = audit(readFileSync(target));
  console.log(`安装包：${target}`);
  console.log(`  头部块 ${result.blocks} 段，其中含中文的 UTF-16LE 串 ${result.cjkRuns} 条`);
  if (result.blocks === 0) {
    console.error("  判红：解析不到 NSIS 头部块，无法证明字符串编码正确（别指望跳过这一步）");
    process.exit(1);
  }
  if (result.bad.length > 0) {
    console.error(`  判红：${result.bad.length} 条字符串是「UTF-8 被当单字节码页读」的乱码形态：`);
    for (const { run, restored } of result.bad.slice(0, 8)) {
      console.error(`    产物里 ${JSON.stringify(run.slice(0, 48))}  →  本应是 ${JSON.stringify(restored.slice(0, 48))}`);
    }
    console.error("  根因方向：脚本源码缺 UTF-8 BOM，Windows 侧 makensis 会按宿主 ANSI 码页解释源码。");
    process.exit(1);
  }
  console.log("  通过：没有乱码形态的字符串。");
}
