import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

/** Web 手动桥（public/manual-bridge-sync.js）的审计落盘端点：
 *  浏览器侧 __auditBridge 把 AppendAuditEvent POST 到这里，
 *  与 Go 侧 AppendAuditEvent → audit-trail.jsonl 行为一致（只追加）。 */
const AUDIT_DIR = "/tmp/confscope-retest/audit";
const AUDIT_FILE = `${AUDIT_DIR}/audit-trail.jsonl`;
function retestAuditPlugin() {
  return {
    name: "retest-audit-append",
    configureServer(server: any) {
      server.middlewares.use("/__retest_audit_append", (req: any, res: any) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            mkdirSync(AUDIT_DIR, { recursive: true });
            const line = Buffer.concat(chunks).toString("utf8").trim();
            if (line) appendFileSync(AUDIT_FILE, `${line}\n`, "utf8");
          } catch {
            // 审计失败不阻断
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
        });
      });
      // 开发者“清理缓存”：truncate 审计文件（与 Go ClearAuditTrail 行为一致，幂等）
      server.middlewares.use("/__retest_audit_clear", (req: any, res: any) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let ok = true;
        try {
          mkdirSync(AUDIT_DIR, { recursive: true });
          if (existsSync(AUDIT_FILE)) writeFileSync(AUDIT_FILE, "", "utf8");
        } catch {
          ok = false;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), retestAuditPlugin()],
  clearScreen: false,
  server: {
    host: '127.0.0.1', // 强制用 IPv4
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/build/**", "**/tests/retest/**", "**/results/**", "**/test-results/**", "**/local-backups/**"],
    },
    optimizeDeps: {
      // 扫描范围锁死在真正的入口 html。默认值是「全项目 *.html」，会一路爬进
      // local-backups/ 里的 WebView 备份（那底下有一整份 Chromium 扩展）和任务目录的
      // 取证页，撞上扩展里 typescript.js import 的 source-map-support 就报「依赖没装」
      // 并让 dev server 直接退出——1420 上一次莫名 404、真机批全批空手而归就是这个。
      entries: ["index.html"],
      exclude: ["**/local-backups/**"],
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tests/e2e/**",
      "tests/smoke/specs/**",
      "tests/smoke/native/specs/**",
      "tests/retest/specs/**",
      // README 截图取证也是 Playwright spec。vitest 默认 include 覆盖 *.spec.ts，
      // 不收进 exclude 就会把它当单测收集：里面用的是 @playwright/test 的 test()，
      // 直接报错，还会把 shots/out/ 的产物路径逻辑跑进单测链路。
      "tests/retest/shots/**",
      "tests/smoke/bridge/**",
      "tests/smoke/global-teardown.test.ts",
      "tests/smoke/native/global-setup.test.ts",
      "tests/smoke/native/global-teardown.test.ts",
      ".tmp/**",
      // 任务目录里的取证/试验 spec 也是 Playwright 文件（r112 落过一次坑：
      // .trellis/tasks/**/research/99-t*.spec.ts 被当单测收集，import ./retestTest 直接解析失败，
      // 283 个文件里红 2 个）。任务草稿不进单测链路。
      ".trellis/**",
    ],
  },
});
