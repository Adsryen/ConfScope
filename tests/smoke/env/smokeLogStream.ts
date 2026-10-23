import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";

/**
 * 打开冒烟运行的日志流（子进程 stdout/stderr 落盘用）。
 *
 * 为什么不能直接用 createWriteStream：
 * `createWriteStream` 的 open 是异步的——它被排到下一个 tick 的线程池任务里。
 * 用例的 afterEach 往往在那之前就把临时目录 `rmSync` 掉了。串行跑时 open 抢在删除前完成，
 * 看不出问题；全量并行跑时线程池排队，open 落到目录删除之后 → ENOENT →
 * 流上 emit 'error' 而无人监听 → Node 抛 uncaughtException → vitest 记一条 unhandled error，
 * 门禁口径就得挂着「Errors 1」跑（轮67 实测：tests/smoke/env/nativeApp.test.ts，只在并行下出现）。
 *
 * 日志写不进去不能影响冒烟结果本身，所以这里替调用方把 error 接住，
 * 并把这条纪律钉在 smokeLogStream.test.ts 的静态守卫里：tests/smoke/env 下只许经此函数开流。
 */
export function openSmokeLogStream(logPath: string): WriteStream {
  const stream = createWriteStream(logPath, { flags: "a" });
  stream.on("error", () => {
    // 故意吞掉：冒烟日志是旁路证据，落盘失败不得掀翻运行
  });
  return stream;
}
