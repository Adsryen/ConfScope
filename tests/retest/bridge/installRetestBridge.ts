import type { Page } from "@playwright/test";
import { createRetestInvoke, RETEST_AUDIT_FILE } from "./retestBinding";
import { bumpRetestBridgeBust } from "../specs/ui";
import { createRetestStorageSeed } from "./storageSeed";
import type { RetestState } from "../state";

const WAILS_METHODS = [
  "GetAppInfo",
  "CheckForUpdates",
  "GetCurrentPlatform",
  "SelectLocalSnapshotDirectory",
  "ValidateLocalSnapshotDirectory",
  "ConfigCenterListNamespaces",
  "ConfigCenterListConfigs",
  "ConfigCenterGetConfig",
  "ConfigCenterPublishConfig",
  "ConfigCenterDeleteConfig",
  "ConfigCenterPublishConfigFromApplyPlan",
  "ConfigCenterPublishConfigRefFromApplyPlan",
  "ConfigCenterDeleteConfigFromApplyPlan",
  "ConfigCenterDeleteConfigRefFromApplyPlan",
  "ConfigCenterListHistory",
  "ConfigCenterGetHistoryDetail",
  "ConfigCenterTestConnection",
  "NacosDetectVersion",
  "NacosLogin",
  "NacosNamespaces",
  "NacosListConfigs",
  "NacosGetConfig",
  "NacosHistoryList",
  "NacosHistoryDetail",
  "NacosPublishConfig",
  "NacosPublishConfigFromApplyPlan",
  "NacosDeleteConfig",
  "NacosDeleteConfigFromApplyPlan",
  "CreateSSHTunnel",
  "TestSSHConnection",
  "StopSSHTunnel",
  "StopAllSSHTunnels",
  "GetSSHTunnelLocalPort",
  "GetDownloadProgress",
  "DownloadUpdate",
  "InstallAndRestart",
  "CreateSnapshot",
  "GetSnapshot",
  "ListSnapshots",
  "DeleteSnapshot",
  "ValidateSnapshot",
  "SelectAppDataBackupSaveFile",
  "SelectAppDataBackupOpenFile",
  "WriteAppDataBackupFile",
  "ReadAppDataBackupFile",
  "CreateAppDataRecoveryPoint",
  "TestAppDataWebDAV",
  "ListAppDataWebDAVBackups",
  "UploadAppDataWebDAVBackup",
  "DownloadAppDataWebDAVBackup",
  "TestSnapshotWebDAV",
  "ListSnapshotWebDAVPackages",
  "UploadSnapshotWebDAVPackage",
  "ImportSnapshotWebDAVPackage",
  "ClearAuditTrail",
] as const;

export async function installRetestBridge(page: Page, state: RetestState): Promise<void> {
  // vite 5 对 tests/** 下文件只做 mtime 缓存失效（不校验内容 hash），同文件覆盖写后
  // 浏览器端可能拿到旧变换 → 先用 bust URL 强制重新取变换（见 ui.ts bumpRetestBridgeBust）。
  await bumpRetestBridgeBust(page);
  const invoke = createRetestInvoke();
  await page.exposeFunction("__confscopeRetestInvoke", (method: string, args: unknown[]) => invoke(method, args));
  await page.addInitScript(
    ({ methods, storage }) => {
      const target = window as unknown as {
        __confscopeRetestInvoke: (method: string, args: unknown[]) => Promise<unknown>;
        go: { main: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } };
        runtime: {
          EventsOn: (eventName: string, callback: (payload: unknown) => void) => void;
          EventsOff: (eventName: string, callback: (payload: unknown) => void) => void;
        };
      };
      if (window.localStorage.getItem("retest.bridge.marker") !== "1") {
        // 每次新浏览器上下文（spec 文件级 page）强制刷新播种数据：
        // 复测容器是持久化的，跨 run 残留的 cs.* 状态会污染历史/审计/任务断言
        window.localStorage.clear();
      }
      // manual-bridge-sync.js（index.html head 内联）只在自己 marker 缺失时播种；
      // 它在本 init script 之前执行，可能已用旧版 seed（缺 defaultGroup）写入 cs.*。
      // 这里无条件覆写 retest seed：storage 是模块单例（createRetestStorageSeed 每次
      // 安装重新生成），保证 defaultGroup 等字段一定存在，不受页面脚本时序影响。
      for (const item of storage) {
        window.localStorage.setItem(item.key, item.value);
      }
      window.localStorage.setItem("retest.bridge.marker", "1");
      // 关键：manual-bridge-sync.js（head classic script）在页面上下文先于本 init script 的
      // 页面脚本阶段执行，若它已内联安装 window.go，必须在覆盖前清掉——否则 UI 的
      // wailsjs 绑定 import 到的 go.main.App 永远是内联旧版（旧版 TestSSHConnection
      // 直接 throw「SSH 隧道未启用」），retest 桥接管不生效。
      delete (window as Record<string, unknown>).go;
      const app: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const item of methods) {
        app[item] = (...args: unknown[]) => target.__confscopeRetestInvoke(item, args);
      }
      // S7 诊断：包一层 wailsjs 绑定入口，确认 UI 层调用是否到达桥
      target.go = { main: { App: app } };
      // 审计桥：前端 auditBootstrap 安装 window.__auditBridge（web 手动桥模式同样注入）。
      // retest 桥在这里接管 AppendAuditEvent → /tmp 的 audit-trail.jsonl（只追加，跨 run 保留）。
      (target as { __auditBridge?: unknown }).__auditBridge = {
        appendAuditEvent: (payload: unknown) => {
          const raw = JSON.stringify(payload);
          void target.__confscopeRetestInvoke("AppendAuditEvent", [raw]);
        },
      };
      target.runtime = {
        EventsOn: () => undefined,
        EventsOff: () => undefined,
      };
    },
    { methods: [...WAILS_METHODS], storage: createRetestStorageSeed(state) }
  );
}

export const RETEST_BRIDGE_MARKER = "retest.bridge.marker";
export { RETEST_AUDIT_FILE };
