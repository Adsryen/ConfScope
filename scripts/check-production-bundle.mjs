#!/usr/bin/env node
/**
 * 生产构建守卫：dist/ 中不得包含任何 retest/manual-bridge 测试脚手架痕迹。
 *
 * 背景：public/manual-bridge-*.js 是 retest 复测的临时浏览器桥（gitignore 文件），
 * 历史上曾被 index.html 引用并打进生产构建，在用户 profile 首启时写入测试数据，
 * 覆盖真实用户数据（见 .trellis/tasks/09-04-production-bundle-guard/prd.md）。
 *
 * 本脚本在 frontend:build（pnpm build:web）之后运行，发现违禁字符串即退出码 1，
 * 阻断 wails build 产出 exe。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "dist");

const FORBIDDEN = [
  { label: "manual-bridge 桥文件引用", pattern: /\/manual-bridge-(sync|hook|binding)\.js/ },
  { label: "retest 播种标记", pattern: /retest\.manual\.marker/ },
  { label: "retest 测试连接 id", pattern: /\bretest-[ab]\b/ },
  { label: "retest 桥日志前缀", pattern: /retest-bridge/ },
  { label: "retest 测试项目名", pattern: /Retest Nacos [AB]/ },
  { label: "retest 测试命名空间", pattern: /retest-(dev|qa)\b/ },
];

const SKIP_EXTENSIONS = new Set([".png", ".ico", ".icns", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".ttf", ".eot"]);
const MAX_SCAN_BYTES = 20 * 1024 * 1024;

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

let distExists = true;
let scanned = 0;
const hits = [];

try {
  for (const file of walk(distDir, [])) {
    const rel = relative(repoRoot, file);
    const ext = extname(file).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;
    const info = statSync(file);
    if (info.size > MAX_SCAN_BYTES) {
      console.warn(`[check:bundle] 跳过超大文件: ${rel}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    scanned += 1;
    const lines = text.split("\n");
    FORBIDDEN.forEach(({ label, pattern }) => {
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push({ file: rel, line: index + 1, label, snippet: line.trim().slice(0, 120) });
        }
      });
    });
  }
} catch (error) {
  if (error && error.code === "ENOENT") distExists = false;
  else throw error;
}

if (!distExists) {
  console.error("[check:bundle] 未找到 dist/ 目录。请先运行 pnpm build:web。");
  process.exit(1);
}

if (hits.length > 0) {
  console.error(`[check:bundle] 失败：dist/ 中发现 ${hits.length} 处测试脚手架痕迹（生产构建必须干净）：`);
  for (const hit of hits) {
    console.error(`  - ${hit.file}:${hit.line} [${hit.label}]`);
    console.error(`      ${hit.snippet}`);
  }
  console.error("");
  console.error("处理方式：从 index.html 移除对应 <script> 引用，删除 public/manual-bridge-*.js 后重新构建。");
  console.error("说明：retest 桥只允许通过 vite dev server + Playwright chromium 使用，禁止进入 dist/。");
  process.exit(1);
}

console.log(`[check:bundle] 通过：扫描 ${scanned} 个文件，未发现测试脚手架痕迹。`);
