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
import { translate } from "../locales";

import {
  AppendConfigRevision,
  GetConfigRevisionPolicy,
  PruneConfigRevisions,
  ReadConfigRevisionsForKey,
  SaveConfigRevisionPolicy,
  SetConfigRevisionPinned,
  type ConfigRevisionInput,
  type ConfigRevisionPinResult,
  type ConfigRevisionPolicyView,
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

/**
 * 生效配额的来源档，与 Go 侧 revisions.KeepSource* 同值（policy.go）。
 *
 * 界面按这几档说实话（「还没设过」不许念成「你设的值生效了」）；档位字符串在前端
 * 只许从这里出，散落的字面量就是第二个事实源。区间与默认值不在这里——那些随
 * ConfigRevisionPolicyView 从 Go 回，抄一份常量就多一条 bug 线。
 */
export const CONFIG_REVISION_KEEP_SOURCE_POLICY = "policy";
export const CONFIG_REVISION_KEEP_SOURCE_MISSING = "default-missing";
export const CONFIG_REVISION_KEEP_SOURCE_UNREADABLE = "default-unreadable";
export const CONFIG_REVISION_KEEP_SOURCE_OUT_OF_RANGE = "default-out-of-range";

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

/** 保留策略读出口要摸的那几颗绑定（存在性判断用，调用仍走本函数下面的出口）。 */
interface RevisionPolicyBindings {
  GetConfigRevisionPolicy(): Promise<ConfigRevisionPolicyView>;
  SaveConfigRevisionPolicy(keepPerKey: number): Promise<ConfigRevisionPolicyView>;
  SetConfigRevisionPinned(
    connectionID: string,
    namespace: string,
    group: string,
    dataID: string,
    hash: string,
    pinned: boolean
  ): Promise<ConfigRevisionPinResult>;
}

/**
 * 保留策略与钉住的读出口在当前运行时可达吗。
 *
 * 与 localRevisionStoreAvailable 同一个理由：纯浏览器 / web 模式拿不到绑定，
 * 那时配额编辑器与每行的钉住开关都必须整个不出现，而不是点了报错。
 */
export function revisionPolicyStoreAvailable(): boolean {
  const bindings = wailsAppBindings<RevisionPolicyBindings>();
  return typeof bindings?.GetConfigRevisionPolicy === "function" && typeof bindings?.SetConfigRevisionPinned === "function";
}

/**
 * 当前生效的保留策略：配额、来源档、合法区间与钉住清单都由 Go 侧回（policy.go 的 PolicyView）。
 *
 * 前端不抄区间常量——第二个判据源就是第二条 bug 线（守卫 tests/ux 的单源钉）。
 * 读失败要如实抛：把「读不出策略」说成「默认 50」会让设置页在一个不存在的事实上让用户保存。
 */
export async function getConfigRevisionPolicy(): Promise<ConfigRevisionPolicyView> {
  const view = await GetConfigRevisionPolicy();
  if (!view || typeof view !== "object") throw new Error(translate("configRevisions.policyUnreadable"));
  return view;
}

/**
 * 保存每键保留数。回的是磁盘回读后的事实，不是刚才那个入参：
 * 越界的值带 default-out-of-range 档回来，界面必须把「钳回了默认值」这句话原样说出来。
 */
export async function saveRevisionKeepPerKey(keepPerKey: number): Promise<ConfigRevisionPolicyView> {
  const view = await SaveConfigRevisionPolicy(keepPerKey);
  if (!view || typeof view !== "object") throw new Error(translate("configRevisions.policyUnreadableAfterSave"));
  return view;
}

/**
 * 钉住 / 取消钉住「某个键的某一版正文」。
 *
 * 身份是键四元组 + 正文摘要（不是时间戳：observed 会被就地升级成 confirmed-write 换掉整行含 ts，
 * 钉 ts 的钉会在那一刻静默失效）。Go 侧如实回 pinned 与 hits：hits=0 且 pinned=false 不是错误，
 * 是「本机已经没有这一版正文可钉」，界面要把这句话原样说出来。
 */
export async function toggleRevisionPinned(
  conn: Connection,
  target: ConfigRevisionTarget,
  hash: string,
  pinned: boolean
): Promise<ConfigRevisionPinResult> {
  const connectionId = conn.id.trim();
  const dataId = target.dataId.trim();
  const revisionHash = hash.trim();
  if (!connectionId || !dataId || !revisionHash) {
    throw new Error(translate("configRevisions.pinIdentityMissing"));
  }
  // 三段身份都在这里钳过空格再上 wire：Go 侧 SetPinned 也会钳一次（幂等），
  // 但界面上「钉没钉」的对照走的是 isRevisionPinned，那份对照用的是钳过的值——
  // 发出去的和比回来的必须是同一种形状，否则钉住了却显示没钉。
  return SetConfigRevisionPinned(connectionId, target.namespace, target.group, dataId, revisionHash, pinned);
}

/**
 * 按新上限清理一次（设置页「按新上限清理」）。
 *
 * Go 侧 Prune 不收参数：配额只有一个钳制点，多一个入参就等于多一条绕过策略直接删数据的路。
 * 返回删掉的条数，钉住的行永远不在删除之列。
 */
export async function pruneConfigRevisionsByPolicy(): Promise<number> {
  return PruneConfigRevisions();
}

/**
 * 这一版（键 + 正文摘要）在不在钉住清单里。
 *
 * 身份匹配只在这一处：界面不自己拼键分隔符、不自己比字段，避免第二套归属判据。
 * Go 侧存的就是钳过空格的四元组 + hash（SetPinned 里 TrimSpace），这里逐字段对照即可。
 */
export function isRevisionPinned(
  policy: ConfigRevisionPolicyView,
  connectionId: string,
  target: ConfigRevisionTarget,
  hash: string
): boolean {
  const conn = connectionId.trim();
  const dataId = target.dataId.trim();
  return (policy.pinned ?? []).some(
    (ref) =>
      ref.connectionId === conn &&
      ref.namespace === target.namespace &&
      ref.group === target.group &&
      ref.dataId === dataId &&
      ref.hash === hash
  );
}
