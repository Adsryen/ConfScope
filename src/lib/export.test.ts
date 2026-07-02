import { describe, expect, it } from "vitest";
import { exportAuditCSV, exportAuditJSON } from "./export";
import type { AuditRow } from "./audit";
import type { EnvSource } from "../components/AuditView";

/** 生成测试用 EnvSource */
function env(id: string, name: string, envName: string): EnvSource {
  return {
    conn: { id, name, environmentName: envName, sourceName: "lan", sourceType: "nacos-online" } as any,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataIdFilter: "",
  };
}

/** 生成测试用 AuditRow */
function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "public|DEFAULT_GROUP|app.yaml|server.port",
    providerType: "nacos",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    key: "server.port",
    status: "consistent",
    values: {
      "c1:public": { exists: true, value: "8080", updatedAt: "2025-01-01T00:00:00Z" },
      "c2:public": { exists: true, value: "9090", updatedAt: "2025-01-02T00:00:00Z" },
    },
    originalDataIds: { "c1:public": "app.yaml", "c2:public": "app.yaml" },
    ...overrides,
  };
}

describe("exportAuditCSV", () => {
  it("生成正确的 CSV 列头和数据行", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const rows = [row()];
    const csv = exportAuditCSV(rows, envSources, { sanitize: false });
    const lines = csv.split("\n");

    // 第一行 BOM + header
    expect(lines[0]).toContain("﻿dataId,key,status");
    expect(lines[0]).toContain("开发/dev/public");
    expect(lines[0]).toContain("生产/prod/public");

    // 第二行数据
    expect(lines[1]).toContain("app.yaml,server.port,consistent");
    expect(lines[1]).toContain("8080");
    expect(lines[1]).toContain("9090");
  });

  it("缺失的环境值为空字符串", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const r = row({
      values: {
        "c1:public": { exists: true, value: "8080" },
        "c2:public": { exists: false },
      },
    });
    const csv = exportAuditCSV([r], envSources, { sanitize: false });
    const lines = csv.split("\n");
    // 第二行：最后一个环境值缺失
    const dataFields = lines[1].split(",");
    expect(dataFields[2]).toBe("consistent");
    // dev 有值，prod 缺失
    expect(dataFields[3]).toBe("8080");
  });

  it("脱敏时敏感字段替换为 ***", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const r = row({ key: "db.password", values: {
      "c1:public": { exists: true, value: "secret123" },
      "c2:public": { exists: true, value: "secret456" },
    }});
    const csv = exportAuditCSV([r], envSources, { sanitize: true });
    expect(csv).toContain("***");
    expect(csv).not.toContain("secret123");
    expect(csv).not.toContain("secret456");
  });

  it("脱敏时正常字段保持原值", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const r = row({ key: "server.port", values: {
      "c1:public": { exists: true, value: "8080" },
      "c2:public": { exists: true, value: "9090" },
    }});
    const csv = exportAuditCSV([r], envSources, { sanitize: true });
    expect(csv).toContain("8080");
    expect(csv).toContain("9090");
  });
});

describe("exportAuditJSON", () => {
  it("生成正确的 JSON 结构", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const rows = [row()];
    const result = exportAuditJSON(rows, envSources, { sanitize: false });

    expect(result.metadata.envCount).toBe(2);
    expect(result.metadata.rowCount).toBe(1);
    expect(result.metadata.sanitized).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].dataId).toBe("app.yaml");
    expect(result.rows[0].key).toBe("server.port");
    expect(result.rows[0].status).toBe("consistent");
    expect(result.rows[0].values["c1:public"].value).toBe("8080");
    expect(result.rows[0].values["c2:public"].value).toBe("9090");
  });

  it("脱敏时敏感字段替换为 ***", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const r = row({ key: "db.token", values: {
      "c1:public": { exists: true, value: "tok123" },
      "c2:public": { exists: true, value: "tok456" },
    }});
    const result = exportAuditJSON([r], envSources, { sanitize: true });
    expect(result.metadata.sanitized).toBe(true);
    expect(result.rows[0].values["c1:public"].value).toBe("***");
    expect(result.rows[0].values["c2:public"].value).toBe("***");
  });

  it("metadata 含 exportedAt 时间戳", () => {
    const envSources = [env("c1", "dev", "开发")];
    const result = exportAuditJSON([], envSources, { sanitize: false });
    expect(result.metadata.exportedAt).toBeTruthy();
    // 验证是合法的 ISO 时间
    expect(new Date(result.metadata.exportedAt).toISOString()).toBe(result.metadata.exportedAt);
  });
});
