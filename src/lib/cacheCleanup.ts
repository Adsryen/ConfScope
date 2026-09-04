import { rehydrateFromAppDataDoc } from "./appDataDoc";
// 开发者“清理缓存”：清掉本机应用缓存（localStorage 的 cs.* 键）+ 审计记录
// （audit-trail.jsonl，经 Go 绑定 ClearAuditTrail）。
//
// 注意：localStorage 现在是主数据文件（app-data/confscope-data.json）的热缓存，
// 清理后从数据文件重新水合，主数据文件本身绝不触碰。
//
// 设计约定：
//   - 只清“本地缓存/记录”，绝不动已连接 Nacos/Apollo/Consul 的服务端数据
//   - 审计文件走 Go 绑定 truncate（原生）/ retest 桥（web 手动桥经 vite 中间件
//     /__retest_audit_clear 落盘）；绑定缺失（极少数降级场景）时静默跳过，不抛错
//   - 返回各部分结果供设置页展示成功/失败文案
export interface CacheCleanupResult {
  /** 被移除的 localStorage cs.* 键数量。 */
  removedStorageKeys: number;
  /** 审计文件是否被清空（true=清空；false=绑定缺失/无文件/失败）。 */
  auditCleared: boolean;
}

const LOCAL_STORAGE_PREFIX = "cs.";

export function clearLocalCacheStorage(): number {
  const keys = Object.keys(window.localStorage).filter((key) => key.startsWith(LOCAL_STORAGE_PREFIX));
  for (const key of keys) window.localStorage.removeItem(key);
  return keys.length;
}

async function clearAuditTrailWeb(): Promise<boolean> {
  try {
    const res = await fetch("/__retest_audit_clear", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearAuditTrail(): Promise<boolean> {
  try {
    // web 手动桥（retest）：Go 绑定是 no-op，改用 vite 中间件真实 truncate
    const win = window as Window & { __retestBinding?: unknown; __wails?: unknown };
    if (win.__retestBinding && !win.__wails) {
      return await clearAuditTrailWeb();
    }
    // 原生：走 Go 绑定
    const { ClearAuditTrail } = await import("../../wailsjs/go/main/App");
    await ClearAuditTrail();
    return true;
  } catch {
    // 绑定缺失（极少数降级场景）：静默跳过，不阻断清理流程
    return false;
  }
}

export async function clearAppCache(): Promise<CacheCleanupResult> {
  const removedStorageKeys = clearLocalCacheStorage();
  const auditCleared = await clearAuditTrail();
  // 清理的是缓存：从主数据文件重新水合，保证用户数据不丢
  await rehydrateFromAppDataDoc();
  return { removedStorageKeys, auditCleared };
}
