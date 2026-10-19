/**
 * 真机批的 `retest-*` 残留清扫。
 *
 * 为什么必须有（轮44 实测取证）：用例自己负责恢复基线（`restoreBaseline()` / 首尾
 * `republishRetestData()`），但**用例中途红就跳不过去那些收尾**——它造出来的条目留在服务端，
 * 下一批的条数断言立刻被打成假红。探针手顺：往 A/retest-dev 的 RETEST-PROD 投一条
 * `retest-v44-pollution.properties`，T-BR-01 在 1.4s 内 `Expected 13, Received 14`。
 * 排查时这看着像「浏览页列表坏了」，实际是上一条用例的尸体，白烧一轮。
 *
 * 判据只有 dataId 前缀 `retest-`（大小写不敏感）：
 * - 播种数据一律 `svc-*`（scripts/retest-data/gen.py 的 16 对），永不命中；
 * - `RETEST-PROD` / `RETEST-ORDER` / `RETEST-MESSENGE` 是 **group** 名，与 dataId 无关，也不碰。
 *
 * 清扫失败只记 console，绝不判红：它是环境兜底，不是断言。把它变红等于给真机加一个新的假红来源。
 */
import { loadRetestState } from "./state";

/** 残留判据：dataId 前缀。改动它必须同时改 tests/ux/keepAliveScope.test.ts 的守卫。 */
export const STRAY_DATAID_PREFIX = "retest-";

interface SweepTarget {
  label: string;
  baseUrl: string;
  namespace: string;
}

/**
 * 三个落点，与种子数据的真实分布一致：
 * publish.py 只写 A/retest-dev 与 B/retest-qa，A/retest-qa 由晋级（E4）类用例写入。
 * 少扫一个组合 = 那个组合里的残留照样污染下一批。
 */
export function sweepTargets(): SweepTarget[] {
  const s = loadRetestState();
  return [
    { label: "A/dev", baseUrl: s.nacos.a.baseUrl, namespace: s.nacos.a.namespace },
    { label: "A/qa", baseUrl: s.nacos.a.baseUrl, namespace: s.nacos.b.namespace },
    { label: "B/qa", baseUrl: s.nacos.b.baseUrl, namespace: s.nacos.b.namespace },
  ];
}

function isStray(dataId: string): boolean {
  return dataId.toLowerCase().startsWith(STRAY_DATAID_PREFIX);
}

interface ListedConfig {
  dataId: string;
  group: string;
}

/** 精确搜索列出一个 namespace 里的配置（分页取全，最多 10 页 = 3000 条，够复测容器用）。 */
async function listConfigs(target: SweepTarget): Promise<ListedConfig[]> {
  const items: ListedConfig[] = [];
  for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
    const url =
      `${target.baseUrl}/v1/cs/configs?search=accurate&dataId=&group=` +
      `&pageNo=${pageNo}&pageSize=300&tenant=${encodeURIComponent(target.namespace)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`list ${target.label} HTTP ${res.status}`);
    const body = (await res.json()) as { pageItems?: ListedConfig[]; totalCount?: number };
    const page = body.pageItems ?? [];
    items.push(...page.map((i) => ({ dataId: i.dataId, group: i.group })));
    if (page.length === 0 || items.length >= (body.totalCount ?? items.length)) break;
  }
  return items;
}

/**
 * 扫掉三个落点里所有 `retest-` 前缀条目。
 * @returns removed / failed 都是 `label/dataId(group)` 形状，供 console 直接读。
 */
export async function sweepRetestStrays(when: string): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const target of sweepTargets()) {
    let strays: ListedConfig[] = [];
    try {
      strays = (await listConfigs(target)).filter((i) => isStray(i.dataId));
    } catch (error) {
      failed.push(`${target.label} list: ${String(error)}`);
      continue;
    }
    for (const item of strays) {
      const tag = `${target.label}/${item.dataId}(${item.group})`;
      const url =
        `${target.baseUrl}/v1/cs/configs?dataId=${encodeURIComponent(item.dataId)}` +
        `&group=${encodeURIComponent(item.group)}&tenant=${encodeURIComponent(target.namespace)}`;
      try {
        const res = await fetch(url, { method: "DELETE" });
        const body = await res.text();
        if (res.ok && body === "true") removed.push(tag);
        else failed.push(`${tag}: HTTP ${res.status} ${body.slice(0, 60)}`);
      } catch (error) {
        failed.push(`${tag}: ${String(error)}`);
      }
    }
  }
  console.log(
    `[strays:${when}] 清除 ${removed.length} 条 ${JSON.stringify(removed)}` +
      (failed.length ? `；失败 ${failed.length} 条 ${JSON.stringify(failed)}` : "")
  );
  return { removed, failed };
}
