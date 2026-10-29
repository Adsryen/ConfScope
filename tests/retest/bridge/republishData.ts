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

/** 通用发布：POST Nacos v1 后回读比对，确保内容真实落库。 */
export async function publishNacosContent(
  baseUrl: string,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  type = "yaml"
): Promise<void> {
  const form = new URLSearchParams({ dataId, group, tenant: namespace, content, type });
  const res = await fetch(`${baseUrl}/v1/cs/configs`, { method: "POST", body: form });
  const body = await res.text();
  if (!res.ok || body !== "true") throw new Error(`publish ${dataId} failed: ${body}`);
  const qs = new URLSearchParams({ dataId, group, tenant: namespace }).toString();
  // Nacos v1 写入存在最终一致性：POST 返回 true 后读回可能短暂返回旧值
  // （retest 容器单实例，已验证非多实例问题；轮询重试直至一致或超时）。
  let got = "";
  for (let i = 0; i < 10; i++) {
    got = await (await fetch(`${baseUrl}/v1/cs/configs?${qs}`)).text();
    if (got === content) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`readback mismatch for ${dataId} after 5s: ${got.slice(0, 120)}`);
}
