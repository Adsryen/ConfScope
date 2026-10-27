import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  createRetestInvoke,
  resetRetestAppDataDoc,
  resetRetestDataRoot,
  resetRetestContentReadFailures,
  resetRetestPublishRefusals,
  resetRetestRevisions,
  resetRetestSecureSecrets,
  resetRetestUpdateHandoff,
  RETEST_AUDIT_DIR,
  RETEST_AUDIT_FILE,
  setRetestAuditFsHooks,
  setRetestAuditLineSink,
} from "./retestBinding";
import { bumpRetestBridgeBust } from "../specs/ui";
import { createRetestStorageSeed } from "./storageSeed";
import type { RetestState } from "../state";

const WAILS_METHODS = [
  "GetAppInfo",
  // 主数据文档读写（src/lib/appDataDoc.ts 经 go.app.App 调用；桥内内存替身，见 retestBinding）
  "GetAppDataDocument",
  "SaveAppDataDocument",
  "RetestAppDataDocSnapshot",
  "CheckForUpdates",
  "GetCurrentPlatform",
  // 关于页「复制反馈信息」的运行环境事实（src/api/app.ts getFeedbackDiagnostics）。
  // 缺这一名时桥里没有该方法，About 挂载即在 render 阶段抛 TypeError，整棵 #root 被卸载成白屏（轮94 实测）。
  "GetFeedbackDiagnostics",
  "SelectLocalSnapshotDirectory",
  "ValidateLocalSnapshotDirectory",
  "ConfigCenterListNamespaces",
  "ConfigCenterListConfigs",
  "ConfigCenterGetConfig",
  "ConfigCenterPublishConfig",
  "ConfigCenterDeleteConfig",
  // 只列 Go 侧真存在的绑定名：两个 ...RefFromApplyPlan 是历史幻影（App.d.ts 里查无此名，
  // 产品侧调用的是 publishConfigRefFromApplyPlan → ConfigCenter*FromApplyPlan），
  // 留着只会诱导出错误的参数形状（轮72C）。
  "ConfigCenterPublishConfigFromApplyPlan",
  "ConfigCenterDeleteConfigFromApplyPlan",
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
  "ProbeSSHHostKey",
  "TrustSSHHostKey",
  "StopSSHTunnel",
  "StopAllSSHTunnels",
  "GetSSHTunnelLocalPort",
  "GetDownloadProgress",
  "DownloadUpdate",
  "LaunchUpdateInstaller",
  "RevealDownloadedArtifact",
  "AttachUpdateImage",
  "UpdateInstallCommand",
  "ListActiveSSHTunnels",
  "QuitApplication",
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
  // 审计链的另两端：前端 auditBootstrap 经 wailsjs 调 AppendAuditEvent，
  // LogViewer 经 wailsjs 调 ReadAuditLogLines。这两个名字此前只在桥里有 case、没进方法表，
  // 于是 window.go.app.App 上取不到方法 —— 写审计静默降级、日志页永远读不到持久化行。
  "AppendAuditEvent",
  "ReadAuditLogLines",
  "GetDataLocations",
  "OpenDataFolder",
  // 数据根运行形态与换根迁移（轮62）：桥内内存替身，见 retestBinding
  "GetRuntimeLayout",
  "SelectDataRootDirectory",
  "PlanDataRootMigration",
  "MigrateDataRoot",
  "CheckDataRootRollback",
  "RollbackDataRoot",
  // 本机配置版本历史（轮67 R57）：桥内内存替身，见 retestBinding
  "AppendConfigRevision",
  "ReadConfigRevisions",
  "ReadConfigRevisionsForKey",
  "PruneConfigRevisions",
  "ClearConfigRevisions",
  "GetConfigRevisionFacts",
  // 保留策略与钉住（轮99）：桥内内存替身，见 retestBinding 的策略替身说明。缺这三个名字时
  // 设置页存配额、历史面板钉版本都只是被 catch 吞掉的 rejection，页面照常渲染，绿灯是假的。
  "GetConfigRevisionPolicy",
  "SaveConfigRevisionPolicy",
  "SetConfigRevisionPinned",
  // 系统凭据库读写（src/lib/credentialSecrets.ts 经 wailsjs 调用）。缺这三个名字时
  // 「保存密码到系统凭据库」在复测里只是被 catch 吞掉的 rejection，页面照常渲染，绿灯是假的。
  "WriteSecureSecret",
  "ReadSecureSecret",
  "DeleteSecureSecret",
  // 便携快照文件列表/恢复（src/api/appDataBackup.ts，应用数据备份打包与还原用它）
  "ListAppDataSnapshotFiles",
  "RestoreAppDataSnapshotFiles",
  // 配置浏览「导出源文件到目录」（src/components/ConfigBrowser.tsx）
  "SelectConfigSourceExportDirectory",
  "ExportConfigSourceFiles",
  "RetestRevisionsSnapshot",
] as const;

export async function installRetestBridge(page: Page, state: RetestState): Promise<void> {
  // 每个用例一份干净的文档替身（等价于空数据目录），避免同 worker 内用例互相喂数据。
  resetRetestAppDataDoc();
  // 数据根替身同样每用例重置：避免上一个用例迁移后的 root 泄漏到下一个用例。
  resetRetestDataRoot();
  // 凭据库/导出目录的预置也每用例复位，避免上一条用例驱动的 unsupported 或取消态串味。
  resetRetestSecureSecrets();
  // 升级交接替身同样每用例重置：泄漏的「有新版本」会让下一条用例的关于页直接停在更新面板上。
  resetRetestUpdateHandoff();
  // 本机版本历史替身同样每用例重置：它是「这台机器见过哪几版」，跨用例残留会让
  // 「本机历史（N）」的条数断言读到上一个用例攒下的版本。
  resetRetestRevisions();
  // 写入拒绝注入同样每用例重置：泄漏的「某条 dataId 恒被拒」会让下一条用例的执行
  // 莫名半截失败（轮79 E4 注入，见 retestBinding 里的替身说明）。
  resetRetestPublishRefusals();
  // 正文读取失败注入同样每用例重置：泄漏的「某条 dataId 恒读不到」会让下一条用例的浏览页
  // 莫名停在加载失败弹框上（轮97 K2 注入，见 retestBinding 里的替身说明）。
  resetRetestContentReadFailures();
  // 审计落盘恢复（node 侧）：retestBinding 为浏览器兼容不再直接 import node:fs，
  // 改由本 node 专属文件注入 sink，写回 /tmp 的 audit-trail.jsonl（只追加）。
  setRetestAuditLineSink((line) => {
    try {
      mkdirSync(RETEST_AUDIT_DIR, { recursive: true });
      appendFileSync(RETEST_AUDIT_FILE, `${line.replace(/\n/g, " ")}\n`, "utf8");
    } catch {
      // 审计失败不阻断主流程
    }
  });
  // 审计文件读取/清空（node 侧）：ReadAuditLogLines / ClearAuditTrail 经桥落盘，
  // 与 Go 侧 audit.Read/Clear 行为对齐（清空幂等，文件不存在 no-op）。
  setRetestAuditFsHooks(
    () => {
      try {
        if (!existsSync(RETEST_AUDIT_FILE)) return [];
        return readFileSync(RETEST_AUDIT_FILE, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "");
      } catch {
        return [];
      }
    },
    () => {
      try {
        if (existsSync(RETEST_AUDIT_FILE)) writeFileSync(RETEST_AUDIT_FILE, "", "utf8");
      } catch {
        // 清空失败不阻断主流程
      }
    }
  );
  // vite 5 对 tests/** 下文件只做 mtime 缓存失效（不校验内容 hash），同文件覆盖写后
  // 浏览器端可能拿到旧变换 → 先用 bust URL 强制重新取变换（见 ui.ts bumpRetestBridgeBust）。
  await bumpRetestBridgeBust(page);
  const invoke = createRetestInvoke();
  await page.exposeFunction("__confscopeRetestInvoke", (method: string, args: unknown[]) => invoke(method, args));
  await page.addInitScript(
    ({ methods, storage }) => {
      const target = window as unknown as {
        __confscopeRetestInvoke: (method: string, args: unknown[]) => Promise<unknown>;
        go: { app: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } };
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
      // wailsjs 绑定 import 到的 go.app.App 永远是内联旧版（旧版 TestSSHConnection
      // 直接 throw「SSH 隧道未启用」），retest 桥接管不生效。
      delete (window as unknown as { go?: unknown }).go;
      const app: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const item of methods) {
        app[item] = (...args: unknown[]) => target.__confscopeRetestInvoke(item, args);
      }
      // S7 诊断：包一层 wailsjs 绑定入口，确认 UI 层调用是否到达桥
      target.go = { app: { App: app } };
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
