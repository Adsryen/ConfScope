// 轮42 R42-1：直写入口的计划出路。
// 关键不是 payload 长什么样，而是把它喂给**已有的**计划构建器后，
// dry-run 是否真的产出用户点那个按钮时所期望的动作（覆盖 / 新增 / 删除 / 跳过），
// 以及 freshness 基线是否仍是线上原文（否则本地草稿会静默覆盖别人的改动）。
import { describe, expect, it } from "vitest";
import type { ConfigDocument } from "../api/nacos";
import type { Connection } from "../store/connections";
import { buildApplyPlanFromEntry, type ApplyPlanDraftDeps } from "./applyPlanDraft";
import { buildDirectWriteExitEntry, isWritableConfigTarget, type DirectWriteExitInput } from "./directWriteExit";

function conn(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "dev",
    name: "开发环境",
    baseUrl: "http://127.0.0.1:18848/nacos",
    username: "u",
    password: "p",
    defaultNamespace: "dev",
    provider: "nacos",
    ...overrides,
  } as Connection;
}

const LIVE = "server:\n  port: 8080\n  timeout: 3s\n";
const EDITED = "server:\n  port: 8080\n  timeout: 30s\n";

function input(overrides: Partial<DirectWriteExitInput> = {}): DirectWriteExitInput {
  return {
    conn: conn(),
    t: (key: string) => key,
    namespace: "dev",
    group: "RETEST-PROD",
    dataId: "svc-billing.yaml",
    format: "YAML",
    desiredContent: EDITED,
    intent: "edit",
    ...overrides,
  };
}

/** 目标位置当前线上内容的 fake 读接口；create 用例让它 404。 */
function depsWithLive(document: ConfigDocument | null): ApplyPlanDraftDeps {
  return {
    connections: [conn()],
    getSnapshot: async () => {
      throw new Error("unused");
    },
    getConfigDocument: async () => {
      if (!document) throw new Error("404 config does not exist");
      return document;
    },
  };
}

const liveDoc: ConfigDocument = { content: LIVE, format: "yaml", version: "v7", source: "nacos", updateTime: "2026-10-19T10:00:00Z" };

describe("isWritableConfigTarget（四处入口共用的可写判定）", () => {
  it("普通 nacos 连接可写", () => {
    expect(isWritableConfigTarget(conn())).toBe(true);
  });

  it("只读、本地快照、非 nacos provider 都没有出路", () => {
    expect(isWritableConfigTarget(conn({ readonly: true }))).toBe(false);
    expect(isWritableConfigTarget(conn({ sourceType: "local-snapshot" }))).toBe(false);
    expect(isWritableConfigTarget(conn({ provider: "apollo" }))).toBe(false);
    expect(isWritableConfigTarget(conn({ provider: undefined }))).toBe(true); // 省略 provider 视作 nacos
  });
});

describe("buildDirectWriteExitEntry 的载荷形状（R42-1）", () => {
  it("四个意图都落在同一位置：source 与 target 完全相同，scope=config，key=__document", () => {
    for (const intent of ["edit", "create", "delete", "rollback"] as const) {
      const entry = buildDirectWriteExitEntry(input({ intent, desiredContent: intent === "delete" ? null : EDITED }));
      expect(entry, intent).not.toBeNull();
      expect(entry!.source).toEqual(entry!.target);
      expect(entry!.scope).toBe("config");
      expect(entry!.items).toHaveLength(1);
      expect(entry!.items[0].key).toBe("__document");
      expect(entry!.items[0].sourceRef).toEqual(entry!.items[0].targetRef);
      expect(entry!.origin.returnMode).toBe("browse");
    }
  });

  it("sourceType 只有 manual / rollback 两种（不新增计划来源类型）", () => {
    expect(buildDirectWriteExitEntry(input({ intent: "rollback" }))!.sourceType).toBe("rollback");
    for (const intent of ["edit", "create", "delete"] as const) {
      expect(buildDirectWriteExitEntry(input({ intent }))!.sourceType).toBe("manual");
    }
  });

  it("物化的期望值不带服务器元数据，删除的期望值是「不存在」", () => {
    const edit = buildDirectWriteExitEntry(input())!.items[0].sourceValueOverride!;
    expect(edit.exists).toBe(true);
    expect(edit.content).toBe(EDITED);
    expect(edit.value).toBe(EDITED);
    expect(edit.format).toBe("YAML");
    expect("version" in edit).toBe(false);
    expect("updateTime" in edit).toBe(false);
    expect(edit.fingerprint).toBeTruthy();

    const del = buildDirectWriteExitEntry(input({ intent: "delete", desiredContent: null }))!.items[0].sourceValueOverride!;
    expect(del.exists).toBe(false);
    expect(del.content).toBeUndefined();
  });

  it("group 空串回落 DEFAULT_GROUP，dataId 去空格；不可写目标或空 dataId 直接没有出路", () => {
    expect(buildDirectWriteExitEntry(input({ group: "  " }))!.items[0].group).toBe("DEFAULT_GROUP");
    expect(buildDirectWriteExitEntry(input({ dataId: "  app.yaml " }))!.items[0].dataId).toBe("app.yaml");
    expect(buildDirectWriteExitEntry(input({ dataId: "   " }))).toBeNull();
    expect(buildDirectWriteExitEntry(input({ conn: conn({ readonly: true }) }))).toBeNull();
  });

  it("未指定格式时按 dataId 后缀推断（json→JSON、properties→Properties）", () => {
    expect(buildDirectWriteExitEntry(input({ dataId: "svc-pay.json", format: undefined }))!.items[0].sourceValueOverride!.format).toBe("JSON");
    expect(buildDirectWriteExitEntry(input({ dataId: "svc-pay.properties", format: undefined }))!.items[0].sourceValueOverride!.format).toBe(
      "Properties"
    );
  });
});

describe("计划构建器对四种意图给出的动作（本轮的核心风险）", () => {
  it("编辑正文 → 覆盖，afterValue 写的是用户改后的正文", async () => {
    const entry = buildDirectWriteExitEntry(input())!;
    const result = await buildApplyPlanFromEntry(entry, depsWithLive(liveDoc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.plan.items[0];
    expect(item.action).toBe("overwrite");
    expect(item.afterValue.content).toBe(EDITED);
    expect(result.plan.summary.overwrite).toBe(1);
  });

  it("正文与线上一致 → 跳过（计划里一处都不写，UI 据此提前告知用户无需生成）", async () => {
    const entry = buildDirectWriteExitEntry(input({ desiredContent: LIVE }))!;
    const result = await buildApplyPlanFromEntry(entry, depsWithLive(liveDoc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.items[0].action).toBe("skip");
  });

  it("删除 → 计划的删除动作，且执行前快照取的是线上原文", async () => {
    const entry = buildDirectWriteExitEntry(input({ intent: "delete", desiredContent: null }))!;
    const result = await buildApplyPlanFromEntry(entry, depsWithLive(liveDoc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.items[0].action).toBe("delete");
    expect(result.plan.summary.delete).toBe(1);
    // 目标现值必须仍来自服务器：物化 override 不能冒充目标快照
    expect(result.plan.items[0].targetValue.content).toBe(LIVE);
    expect(result.plan.items[0].targetValue.version).toBe("v7");
  });

  it("新建（目标不存在）→ 新增", async () => {
    const entry = buildDirectWriteExitEntry(input({ intent: "create", desiredContent: "a: 1\n" }))!;
    const result = await buildApplyPlanFromEntry(entry, depsWithLive(null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.items[0].action).toBe("create");
    expect(result.plan.summary.create).toBe(1);
  });

  it("历史回滚 → 用该版本正文覆盖线上", async () => {
    const entry = buildDirectWriteExitEntry(input({ intent: "rollback", desiredContent: LIVE }))!;
    const result = await buildApplyPlanFromEntry(entry, depsWithLive({ ...liveDoc, content: EDITED }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.items[0].action).toBe("overwrite");
    expect(result.plan.items[0].afterValue.content).toBe(LIVE);
  });

  it("freshness 基线是线上原文，而不是物化的本地意图（否则本地草稿会误判「未变化」）", async () => {
    const entry = buildDirectWriteExitEntry(input())!;
    const result = await buildApplyPlanFromEntry(entry, depsWithLive(liveDoc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.plan.items[0];
    expect(item.sourceFingerprint).not.toBe(item.sourceValue.fingerprint);
    // 基线指纹只可能来自实时读到的线上正文：内容变了它才变
    const changedDoc = { ...liveDoc, content: LIVE.replace("8080", "9090") };
    const rebuilt = await buildApplyPlanFromEntry(entry, depsWithLive(changedDoc));
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.plan.items[0].sourceFingerprint).not.toBe(item.sourceFingerprint);
  });
});
