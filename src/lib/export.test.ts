// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

  it("正确转义逗号、换行、引号并保留空值", () => {
    const envSources = [env("c1", "dev", "开发"), env("c2", "prod", "生产")];
    const r = row({
      dataId: 'app,"quoted".yaml',
      key: "message.text",
      values: {
        "c1:public": { exists: true, value: 'hello,"world"\nnext', updatedAt: '2026-01-01T00:00:00Z' },
        "c2:public": { exists: false },
      },
    });

    const csv = exportAuditCSV([r], envSources, { sanitize: true });

    expect(csv).toContain('"app,""quoted"".yaml",message.text,consistent');
    expect(csv).toContain('"hello,""world""\nnext"');
    expect(csv).toContain("\nnext\",,2026-01-01T00:00:00Z,");
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
    expect(result.rows[0].values["c1:public"].exists).toBe(true);
    expect(result.rows[0].values["c1:public"].updatedAt).toBe("2025-01-01T00:00:00Z");
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

// ── 通用配置导出测试 ──

import { exportConfigs, exportDiff } from "./export";
import type { ConfigItem, DiffItem, ConfigExportOptions, ExportFormat } from "./export";

/** 模拟 Blob */
class MockBlob {
  parts: unknown[];
  options?: unknown;
  constructor(parts: unknown[], options?: unknown) {
    this.parts = parts;
    this.options = options;
  }
}
globalThis.Blob = MockBlob as any;

/** 模拟 URL.createObjectURL */
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let lastBlobUrl = "";
let lastBlob: MockBlob | null = null;

beforeEach(() => {
  lastBlobUrl = "";
  lastBlob = null;
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    lastBlob = blob as unknown as MockBlob;
    lastBlobUrl = "blob:mock-url";
    return lastBlobUrl;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(document.body, "appendChild").mockImplementation(() => null as any);
  vi.spyOn(document.body, "removeChild").mockImplementation(() => null as any);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

function downloadedText(): string {
  expect(lastBlob).not.toBeNull();
  return lastBlob!.parts.map((part) => String(part)).join("");
}

function downloadedJSON<T>(): T {
  return JSON.parse(downloadedText()) as T;
}

describe("exportConfigs", () => {
  const sampleConfigs: ConfigItem[] = [
    {
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      content: "server:\n  port: 8080",
      configType: "yaml",
      namespace: "dev",
      namespaceId: "",
      updateTime: "2024-01-01 10:00:00",
    },
    {
      dataId: "db.properties",
      group: "DEFAULT_GROUP",
      content: "db.url=jdbc:mysql://localhost:3306/test",
      configType: "properties",
      namespace: "dev",
      namespaceId: "",
      updateTime: "2024-01-02 12:00:00",
    },
  ];

  it("CSV 格式导出包含元数据列并正确转义特殊字符", () => {
    const configs: ConfigItem[] = [
      {
        dataId: 'app,"quoted".properties',
        group: "DEFAULT_GROUP",
        content: 'db.password=secret,with,comma\nquote="value"',
        configType: "properties",
        namespace: "public",
        namespaceId: "public",
        updateTime: "",
      },
    ];
    const opts: ConfigExportOptions = { format: "csv", sensitive: false, includeMeta: false };

    exportConfigs(configs, opts);

    const csv = downloadedText();
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(csv).toContain("﻿namespace,group,dataId,configType,content,updateTime");
    expect(csv).toContain('"app,""quoted"".properties"');
    expect(csv).toContain('"db.password=***\nquote=""value"""');
    expect(csv).toContain(",properties,");
  });

  it("JSON 格式导出稳定 metadata、items，并默认隐藏敏感原文", () => {
    const configs: ConfigItem[] = [
      {
        dataId: "secure.properties",
        group: "DEFAULT_GROUP",
        content: "db.password=secret123\nserver.port=8080",
        configType: "properties",
        namespace: "public",
        namespaceId: "public",
        updateTime: "2024-01-01 10:00:00",
      },
    ];
    const opts: ConfigExportOptions = { format: "json", sensitive: false, includeMeta: true };

    exportConfigs(configs, opts);

    const result = downloadedJSON<{
      metadata: { total: number; format: string; sanitized: boolean; exportedAt: string };
      items: ConfigItem[];
    }>();
    expect(result.metadata.total).toBe(1);
    expect(result.metadata.format).toBe("json");
    expect(result.metadata.sanitized).toBe(true);
    expect(new Date(result.metadata.exportedAt).toISOString()).toBe(result.metadata.exportedAt);
    expect(result.items[0]).toMatchObject({
      dataId: "secure.properties",
      group: "DEFAULT_GROUP",
      configType: "properties",
      namespace: "public",
      namespaceId: "public",
      updateTime: "2024-01-01 10:00:00",
    });
    expect(result.items[0].content).toContain("db.password=***");
    expect(result.items[0].content).toContain("server.port=8080");
    expect(JSON.stringify(result)).not.toContain("secret123");
  });

  it("显式允许敏感字段时保留配置原文", () => {
    const opts: ConfigExportOptions = { format: "json", sensitive: true, includeMeta: true };

    exportConfigs(
      [
        {
          dataId: "secure.properties",
          group: "DEFAULT_GROUP",
          content: "db.password=secret123",
          configType: "properties",
          namespace: "public",
          namespaceId: "public",
          updateTime: "",
        },
      ],
      opts
    );

    const result = downloadedJSON<{ metadata: { sanitized: boolean }; items: ConfigItem[] }>();
    expect(result.metadata.sanitized).toBe(false);
    expect(result.items[0].content).toBe("db.password=secret123");
  });

  it("YAML 格式导出不抛错", () => {
    const opts: ConfigExportOptions = { format: "yaml", sensitive: false, includeMeta: true };
    expect(() => exportConfigs(sampleConfigs, opts)).not.toThrow();
  });

  it("Properties 格式导出不抛错", () => {
    const opts: ConfigExportOptions = { format: "properties", sensitive: false, includeMeta: false };
    expect(() => exportConfigs(sampleConfigs, opts)).not.toThrow();
  });

  it("Diff 格式导出默认隐藏敏感原文", () => {
    const opts: ConfigExportOptions = { format: "diff", sensitive: false, includeMeta: false };
    exportConfigs(
      [
        {
          dataId: "secure.properties",
          group: "DEFAULT_GROUP",
          content: "token=tok123\nfeature=true",
          configType: "properties",
          namespace: "public",
          namespaceId: "public",
          updateTime: "",
        },
      ],
      opts
    );

    const text = downloadedText();
    expect(text).toContain("=== public/DEFAULT_GROUP/secure.properties ===");
    expect(text).toContain("token=***");
    expect(text).toContain("feature=true");
    expect(text).not.toContain("tok123");
  });

  it("不支持的格式抛出错误", () => {
    localStorage.setItem("locale", "zh-CN");
    const opts = { format: "unknown" as ExportFormat, sensitive: false, includeMeta: false };
    expect(() => exportConfigs(sampleConfigs, opts)).toThrow("不支持的导出格式");
  });

  it("localizes unsupported export format errors", () => {
    localStorage.setItem("locale", "en-US");
    const opts = { format: "unknown" as ExportFormat, sensitive: false, includeMeta: false };

    expect(() => exportConfigs(sampleConfigs, opts)).toThrow("Unsupported export format: unknown");
  });

  it("空配置列表也能正常导出", () => {
    const opts: ConfigExportOptions = { format: "json", sensitive: false, includeMeta: false };
    expect(() => exportConfigs([], opts)).not.toThrow();
  });
});

describe("exportDiff", () => {
  it("text 格式导出定位信息、左右值并默认隐藏敏感原文", () => {
    exportDiff(
      [
        {
          dataId: "secure.properties",
          group: "DEFAULT_GROUP",
          namespace: "public",
          leftValue: "password=old-secret",
          rightValue: "password=new-secret",
          diffType: "modified",
        },
      ],
      "text"
    );

    const text = downloadedText();
    expect(text).toContain("[~] public/DEFAULT_GROUP/secure.properties");
    expect(text).toContain("← password=***");
    expect(text).toContain("→ password=***");
    expect(text).not.toContain("old-secret");
    expect(text).not.toContain("new-secret");
  });

  it("JSON 格式导出稳定结构并默认隐藏敏感原文", () => {
    exportDiff(
      [
        {
          dataId: "secure.properties",
          group: "DEFAULT_GROUP",
          namespace: "public",
          leftValue: "accessKey=ak-old",
          rightValue: "accessKey=ak-new",
          diffType: "modified",
        },
      ],
      "json"
    );

    const result = downloadedJSON<{
      metadata: { total: number; sanitized: boolean; exportedAt: string };
      items: DiffItem[];
    }>();
    expect(result.metadata.total).toBe(1);
    expect(result.metadata.sanitized).toBe(true);
    expect(new Date(result.metadata.exportedAt).toISOString()).toBe(result.metadata.exportedAt);
    expect(result.items[0]).toMatchObject({
      dataId: "secure.properties",
      group: "DEFAULT_GROUP",
      namespace: "public",
      leftValue: "accessKey=***",
      rightValue: "accessKey=***",
      diffType: "modified",
    });
    expect(JSON.stringify(result)).not.toContain("ak-old");
    expect(JSON.stringify(result)).not.toContain("ak-new");
  });

  it("空差异列表也能正常导出", () => {
    expect(() => exportDiff([], "text")).not.toThrow();
    expect(() => exportDiff([], "json")).not.toThrow();
  });
});
