import { describe, expect, it } from "vitest";
import {
  applyEntryId,
  applyEntryRiskSummary,
  applyEntryTargetCount,
  type ApplyEntryItem,
  type ApplyEntryPayload,
} from "./applyEntry";

const source = {
  provider: "nacos",
  connectionId: "conn-dev",
  connectionName: "dev",
  namespace: "public",
  label: "Dev / public",
} satisfies ApplyEntryPayload["source"];

const target = {
  provider: "nacos",
  connectionId: "conn-prod",
  connectionName: "prod",
  namespace: "public",
  label: "Prod / public",
} satisfies ApplyEntryPayload["target"];

function item(dataId: string, key = "__document"): ApplyEntryItem {
  return {
    provider: "nacos",
    connectionId: "conn-prod",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    key,
  };
}

function payload(scope: ApplyEntryPayload["scope"], items: ApplyEntryItem[]): ApplyEntryPayload {
  return {
    sourceType: scope === "key" ? "audit" : "diff",
    scope,
    source,
    target,
    items,
    rangeSummary: applyEntryRiskSummary(items),
    origin: { mode: scope === "key" ? "audit" : "diff" },
  };
}

describe("apply entry payload helpers", () => {
  it("creates stable ids and target counts for key, config and batch payloads", () => {
    const keyPayload = payload("key", [item("app.yaml", "server.port")]);
    const configPayload = payload("config", [item("app.yaml")]);
    const batchPayload = payload("batch", [item("app.yaml"), item("db.yaml")]);

    expect(applyEntryId(keyPayload)).toBe("audit|key|conn-dev|conn-prod|public|DEFAULT_GROUP|app.yaml|server.port");
    expect(applyEntryId({ ...keyPayload, rangeSummary: { ...keyPayload.rangeSummary } })).toBe(applyEntryId(keyPayload));
    expect(applyEntryId(configPayload)).toBe("diff|config|conn-dev|conn-prod|public|DEFAULT_GROUP|app.yaml|__document");
    expect(applyEntryTargetCount(batchPayload)).toBe(2);
  });

  it("summarizes batch count, skipped items and risk level", () => {
    expect(applyEntryRiskSummary([item("app.yaml")])).toEqual({
      count: 1,
      skippedCount: 0,
      riskLevel: "low",
      riskReasons: [],
    });
    expect(applyEntryRiskSummary([item("a.yaml"), item("b.yaml"), item("c.yaml")], 1)).toEqual({
      count: 3,
      skippedCount: 1,
      riskLevel: "medium",
      riskReasons: ["batch_apply", "has_skipped_items"],
    });
  });
});
