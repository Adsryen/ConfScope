/**
 * 本机配置版本历史（R57）在前端的唯一写入口。
 *
 * 为什么要这一层，而不是各读取出口自己调绑定：
 * - 摘要口径只有一份。Go 侧按「规范化换行后的 sha256」判重（internal/revisions），
 *   前端不自己算 sha256——既省掉 crypto.subtle 的 secure context 依赖，也免掉第二套摘要口径。
 * - 失败不许影响业务。记不上这一版是日志问题，读到配置是功能问题，后者不能被前者拖住，
 *   所以这里一律 fire-and-forget 并吞掉所有异常（含纯浏览器 / web 模式下绑定根本不存在）。
 * - 写入点只有两个，由守卫测试钉住（tests/ux/configRevisionWritePointsSingleSource.test.ts）：
 *   读到正文（src/api/nacos.ts 的 getConfigDocument）与写后回读确认（src/lib/applyPlanExecution.ts）。
 *
 * 与服务端历史是并列不是合并：服务端能给的仍走 listHistory，本机这份只说
 * 「本机在什么时刻见过哪一版」，绝不冒充配置中心的发布时间。
 */
import {
  AppendConfigRevision,
  ReadConfigRevisionsForKey,
  type ConfigRevisionInput,
  type ConfigRevisionRecord,
} from "../../wailsjs/go/app/App";
import type { Connection } from "../store/connections";
import { effectiveProvider } from "./configCapabilities";
import { wailsAppBindings } from "./wailsAppBindings";

/** 与 Go 侧 revisions.KindObserved 同值：本机读到过这一版。 */
export const CONFIG_REVISION_KIND_OBSERVED = "observed";
/** 与 Go 侧 revisions.KindConfirmedWrite 同值：本程序写入且回读确认。 */
export const CONFIG_REVISION_KIND_CONFIRMED_WRITE = "confirmed-write";

/** 与 Go 侧 revisions.ContentOmittedTooLarge 同值：正文超单条上限，本机只留下摘要与字节数。 */
export const CONFIG_REVISION_CONTENT_OMITTED_TOO_LARGE = "too-large";

/** 一条版本记录的归属：连接 + 命名空间 + 分组 + dataId（key 级变更也记整篇正文）。 */
export interface ConfigRevisionTarget {
  namespace: string;
  group: string;
  dataId: string;
}

/** 记一版只需要这几个字段，各读取出口的 ConfigDocument 都能对上。 */
export interface LoadedConfigDocument {
  content: string;
  format?: string;
  md5?: string;
}

/**
 * 分组键的分隔符，与 Go 侧 revisions.keySeparator 同值（NUL）。
 * 用 fromCharCode 造而不在源码里写字面量：源文件里塞一个真实的 NUL 会让各种工具链抽搐。
 */
const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * 加速器：本进程已经用服务端 md5 确认过的那一版，不再发第二次 IPC。
 *
 * 只在 md5 非空时生效（nacos / MSE 给的内容级摘要）。Apollo / Consul / 本地快照没有这个字段，
 * 那种情况每次都发 IPC 交给 Go 判重——宁可多打一次绑定，也不能为省一次 IPC 漏掉一版。
 * 它只是省开销：真正的判据在 Go 侧以文件为准，这份内存映射丢了最坏是多一条重复记录。
 */
const lastSeenServerMD5 = new Map<string, string>();

/** 版本记录的归属键：连接 + 命名空间 + 分组 + dataId。 */
export function configRevisionKeyOf(connectionId: string, target: ConfigRevisionTarget): string {
  return [connectionId, target.namespace, target.group, target.dataId].join(KEY_SEPARATOR);
}

/**
 * 清掉加速器里的 md5 记忆。
 *
 * 必须在「清除本机版本历史」（以及换数据根之后）调用：加速器记得的那些 md5 属于上一份文件，
 * 留着它会让同样的正文在清除后重新读到却被跳过，本机历史从此再也攒不起来。
 * Go 侧的内存索引在 Clear/换根时自己重建，不需要前端操心。
 */
export function resetConfigRevisionAccelerator(): void {
  lastSeenServerMD5.clear();
}

/** 当前记住的 md5 条数，仅诊断与测试用。 */
export function configRevisionAcceleratorSize(): number {
  return lastSeenServerMD5.size;
}

function buildInput(
  conn: Connection,
  target: ConfigRevisionTarget,
  doc: LoadedConfigDocument,
  kind: string,
  planId: string
): ConfigRevisionInput | null {
  const connectionId = conn.id.trim();
  const dataId = target.dataId.trim();
  if (!connectionId || !dataId) return null;
  if (typeof doc.content !== "string") return null;
  return {
    kind,
    connectionId,
    connectionName: conn.name ?? "",
    provider: effectiveProvider(conn),
    namespace: target.namespace,
    group: target.group,
    dataId,
    content: doc.content,
    format: doc.format ?? "",
    serverMd5: doc.md5 ?? "",
    planId,
    // 版本号留给 Go 补构建值（binding 层缺失才填）：前端不猜自己该叫什么版本。
    appVersion: "",
  };
}

/** 只发一次绑定调用，结果如何都不许打扰调用方；成功才记住 md5，失败要留着重来的机会。 */
function appendRevision(input: ConfigRevisionInput, memoKey: string): void {
  try {
    void AppendConfigRevision(input)
      .then((result) => {
        // appended / duplicate / promoted 三种结果都意味着「这一版已在文件里」，此时才可以记住 md5。
        if (!result || typeof result !== "object") return;
        if (input.serverMd5) lastSeenServerMD5.set(memoKey, input.serverMd5);
      })
      .catch(() => {
        /* 记不上这一版不该影响任何功能 */
      });
  } catch {
    /* 纯浏览器 / web 模式下绑定不存在 */
  }
}

/** 读到正文 = 本机见过这一版。fire-and-forget，永不抛。 */
export function observeLoadedDocument(conn: Connection, target: ConfigRevisionTarget, doc: LoadedConfigDocument): void {
  try {
    const input = buildInput(conn, target, doc, CONFIG_REVISION_KIND_OBSERVED, "");
    if (!input) return;
    const memoKey = configRevisionKeyOf(input.connectionId, target);
    const md5 = input.serverMd5;
    // 服务端 md5 是内容级摘要：与上次相同就是同一版，这一版已经在历史里，不用再发 IPC。
    if (md5 && lastSeenServerMD5.get(memoKey) === md5) return;
    appendRevision(input, memoKey);
  } catch {
    /* 观测失败不影响这次读取 */
  }
}

/**
 * 写后回读确认 = 这一版是本程序写的，并把 planId 一起挂上去。fire-and-forget，永不抛。
 *
 * 这里不走 md5 加速器：正文与刚才那次回读观测完全相同时，Go 侧要做的不是判重丢弃，
 * 而是把那一版的来历就地升级为 confirmed-write（promote），否则「这版是本程序写的、
 * 对应哪个计划」这条最可靠的事实会被省掉一次 IPC 的动作永久抹掉。
 */
export function recordConfirmedWrite(conn: Connection, target: ConfigRevisionTarget, doc: LoadedConfigDocument, planId: string): void {
  try {
    const input = buildInput(conn, target, doc, CONFIG_REVISION_KIND_CONFIRMED_WRITE, planId);
    if (!input) return;
    appendRevision(input, configRevisionKeyOf(input.connectionId, target));
  } catch {
    /* 写入确认记不上，不影响已经完成的写入 */
  }
}

/**
 * 本机版本历史的读出口在当前运行时可达吗。
 *
 * 只有桌面运行时（Wails 注入 window.go.app.App）才有机身文件；纯浏览器 / web 模式拿不到绑定，
 * 那时「本机历史」这一档必须整个不出现——挂着一个永远读不出内容的分段比少一个入口更糟。
 * 命名空间探测只走 wailsAppBindings()（守卫 tests/ux/wailsBindingNamespaceIsSingleSource 钉死）。
 */
export function localRevisionStoreAvailable(): boolean {
  const bindings = wailsAppBindings<LocalRevisionBindings>();
  return typeof bindings?.ReadConfigRevisionsForKey === "function";
}

/** 界面需要的那一颗读绑定；只按存在性判断，调用仍走本文件的 listRevisionsForKey。 */
interface LocalRevisionBindings {
  ReadConfigRevisionsForKey(
    connectionID: string,
    namespace: string,
    group: string,
    dataID: string,
    limit: number
  ): Promise<ConfigRevisionRecord[]>;
}

/**
 * 某个配置键的本机版本历史（最新的在前）。
 *
 * 读失败要如实抛给界面：这里返回空数组和「真的没历史」是两回事，
 * 把失败说成空等于告诉用户「这一版没被本机记过」，是假话。
 */
export async function listRevisionsForKey(conn: Connection, target: ConfigRevisionTarget, limit = 0): Promise<ConfigRevisionRecord[]> {
  const records = await ReadConfigRevisionsForKey(conn.id, target.namespace, target.group, target.dataId, limit);
  return records ?? [];
}
