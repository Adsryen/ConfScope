import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 重新生成并发布 retest 测试数据到 A/B 两个 Nacos 容器（幂等）。
 *  用于在会"写库"的测试（如 T-AP-02 批量执行）开始前恢复干净基线，
 *  保证测试可重复运行：先清空 generated/ 再 gen.py + publish.py。 */
export async function republishRetestData(timeoutMs = 60_000): Promise<void> {
  const scriptDir = path.resolve(here, "../../../scripts/retest-data");
  const cmd =
    'python3 -c "import glob,os; [os.remove(f) for f in glob.glob(\'generated/*\')]" && python3 gen.py && python3 publish.py';
  execSync(cmd, { cwd: scriptDir, timeout: timeoutMs, stdio: "pipe" });
}
