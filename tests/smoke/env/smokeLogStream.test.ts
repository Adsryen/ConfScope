/**
 * @vitest-environment node
 *
 * 冒烟日志流的三条纪律（轮67 R67-WP4 门禁收口）。
 *
 * 现场：全量并行跑 vitest 时固定出现 1 条 unhandled error
 * `ENOENT: no such file or directory, open '/tmp/confscope-native-launch-XXXXXX/.tmp/full-smoke-20260707-120000/reports/native-app.log'`
 * （nativeApp.test.ts 单独跑 8 例全绿，只有并行下复现）。根因是 createWriteStream 的 open
 * 排在下一个 tick 的线程池任务里，afterEach 的 rmSync 常常先执行；线程池一排队，open 就落到删除之后。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stripComments } from "../../ux/scanUtils";
import { openSmokeLogStream } from "./smokeLogStream";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function drainTicks(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("smoke log stream", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("开流时就把 error 接住，流上报错不得同步抛出", () => {
    const root = tempRoot("confscope-smoke-log-handler-");
    const stream = openSmokeLogStream(join(root, "app.log"));

    // 无监听者时 EventEmitter 对 'error' 是同步抛出（Node 约定），这里必须不抛
    expect(() => stream.emit("error", new Error("boom"))).not.toThrow();
    expect(stream.listenerCount("error")).toBeGreaterThan(0);
    stream.destroy();
  });

  it("临时目录抢在异步 open 之前被删掉时，不得冒泡成未处理异常", async () => {
    const root = tempRoot("confscope-smoke-log-race-");
    const reportsDir = join(root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const logPath = join(reportsDir, "native-app.log");

    const uncaught: string[] = [];
    const record = (error: Error): void => {
      uncaught.push(String(error));
    };
    process.on("uncaughtException", record);
    try {
      const stream = openSmokeLogStream(logPath);
      // 复刻用例现场：afterEach 在 open 落地前把整棵临时目录删干净
      rmSync(root, { recursive: true, force: true });
      stream.write("late line\n");
      stream.end();
      await drainTicks();
    } finally {
      process.removeListener("uncaughtException", record);
      rmSync(root, { recursive: true, force: true });
    }

    expect(uncaught, "日志落盘失败只是丢证据，不该掀翻整个冒烟运行").toEqual([]);
  });

  it("tests/smoke/env 下只许经 openSmokeLogStream 开日志流", () => {
    const envDir = fileURLToPath(new URL(".", import.meta.url));
    const offenders = readdirSync(envDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "smokeLogStream.ts")
      .filter((name) => /\bcreateWriteStream\s*\(/.test(stripComments(readFileSync(join(envDir, name), "utf8"))))
      .sort();

    expect(offenders, "裸 createWriteStream 的异步 open 会竞态出未处理异常").toEqual([]);

    // 防永真：拿修前的原样喂探测器，量不到说明扫描口径漂了
    const preFixSample = 'const logStream = createWriteStream(logPath, { flags: "a" });';
    expect(/\bcreateWriteStream\s*\(/.test(stripComments(preFixSample))).toBe(true);
    // 注释里的示例不算代码
    expect(/\bcreateWriteStream\s*\(/.test(stripComments("// const s = createWriteStream(logPath);"))).toBe(false);
  });
});
