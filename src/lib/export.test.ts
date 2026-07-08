// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { exportAuditCSV, exportAuditJSON } from "./export";
import type { AuditRow } from "./audit";
import type { EnvSource } from "../components/AuditView";
import type { Connection, ProviderType } from "../store/connections";

/** 生成测试用 EnvSource */
function env(id: string, name: string, envName: string, provider: ProviderType = "nacos"): EnvSource {
  const namespace = provider === "apollo" ? "order-service" : provider === "consul" ? "dc1" : "public";
  const group = provider === "consul" ? "apps/order/" : provider === "apollo" ? "default" : "DEFAULT_GROUP";
  const conn: Connection = {
    id,
    name,
    provider,
    environmentName: envName,
    projectName: "Smoke Project",
    sourceName: `${provider}-source`,
    sourceType: provider === "local" ? "local-snapshot" : "nacos",
    baseUrl: `http://${provider}.example.test`,
    username: "",
    password: "",
    defaultNamespace: namespace,
  };
  return {
    conn,
    namespace,
    group,
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
    expect(lines[0]).toContain("﻿providerType,namespace,group,dataId,key,status");
    expect(lines[0]).toContain("nacos:Smoke Project/开发/nacos-source/dev/public/DEFAULT_GROUP_value");
    expect(lines[0]).toContain("nacos:Smoke Project/生产/nacos-source/prod/public/DEFAULT_GROUP_value");

    // 第二行数据
    expect(lines[1]).toContain("nacos,public,DEFAULT_GROUP,app.yaml,server.port,consistent");
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
    expect(lines[1]).toContain("nacos,public,DEFAULT_GROUP,app.yaml,server.port,consistent");
    expect(lines[1]).toContain(",8080,,true,false,");
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
    expect(csv).toContain("\nnext\",,true,false,2026-01-01T00:00:00Z,");
  });

  it("导出 provider/source 列、存在状态、更新时间和原始 dataId", () => {
    const envSources = [env("consul-1", "consul-dev", "DEV", "consul"), env("consul-2", "consul-prod", "PRO", "consul")];
    const csv = exportAuditCSV(
      [
        row({
          providerType: "consul",
          namespace: "dc1",
          group: "apps/order/",
          dataId: "apps/order/app.yaml",
          originalDataIds: {
            "consul-1:dc1": "apps/order/app.yaml",
            "consul-2:dc1": "apps/order/app.yaml",
          },
          values: {
            "consul-1:dc1": { exists: true, value: "feature: true", updatedAt: "2026-01-01T00:00:00Z" },
            "consul-2:dc1": { exists: false },
          },
        }),
      ],
      envSources,
      { sanitize: true }
    );

    const lines = csv.split("\n");
    expect(lines[0]).toContain("﻿providerType,namespace,group,dataId,key,status,ignoreReason,originalDataIds");
    expect(lines[0]).toContain("consul:Smoke Project/DEV/consul-source/consul-dev/dc1/apps/order/_value");
    expect(lines[0]).toContain("_exists");
    expect(lines[0]).toContain("_updatedAt");
    expect(lines[0]).toContain("_originalDataId");
    expect(lines[1]).toContain("consul,dc1,apps/order/,apps/order/app.yaml,server.port,consistent");
    expect(lines[1]).toContain("2026-01-01T00:00:00Z");
    expect(lines[1]).toContain("apps/order/app.yaml");
  });

  it("转义 provider/source 表头中的用户输入字符", () => {
    const envSources = [env("c1", 'dev,"quoted"', "Development")];
    const csv = exportAuditCSV([row()], envSources, { sanitize: true });
    const header = csv.split("\n")[0];

    expect(header).toContain('"nacos:Smoke Project/Development/nacos-source/dev,""quoted""/public/DEFAULT_GROUP_value"');
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

  it("导出 JSON provider/source 元数据和原始 dataId", () => {
    const envSources = [env("apollo-1", "apollo-dev", "DEV", "apollo"), env("apollo-2", "apollo-prod", "PRO", "apollo")];
    const result = exportAuditJSON(
      [
        row({
          providerType: "apollo",
          namespace: "order-service",
          group: "default",
          dataId: "application",
          originalDataIds: { "apollo-1:order-service": "application", "apollo-2:order-service": "application" },
          values: {
            "apollo-1:order-service": { exists: true, value: "true", updatedAt: "2026-01-01T00:00:00Z" },
            "apollo-2:order-service": { exists: true, value: "false", updatedAt: "2026-01-02T00:00:00Z" },
          },
        }),
      ],
      envSources,
      { sanitize: true }
    );

    expect(result.metadata).toMatchObject({ schemaVersion: 2, envCount: 2, rowCount: 1, sanitized: true });
    expect(result.sources[0]).toMatchObject({
      envId: "apollo-1:order-service",
      provider: "apollo",
      connectionId: "apollo-1",
      connectionName: "apollo-dev",
      projectName: "Smoke Project",
      environmentName: "DEV",
      sourceName: "apollo-source",
      namespace: "order-service",
      group: "default",
    });
    expect(result.rows[0]).toMatchObject({
      providerType: "apollo",
      namespace: "order-service",
      group: "default",
      dataId: "application",
      key: "server.port",
      originalDataIds: {
        "apollo-1:order-service": "application",
        "apollo-2:order-service": "application",
      },
    });
    expect(result.rows[0].values["apollo-1:order-service"]).toMatchObject({
      exists: true,
      value: "true",
      updatedAt: "2026-01-01T00:00:00Z",
      originalDataId: "application",
    });
  });

  it.each([
    ["db.password", "secret-password"],
    ["apollo.token", "secret-token"],
    ["credentials.accessKeyId", "ak-id"],
    ["credentials.accessKeySecret", "ak-secret"],
    ["credentials.securityToken", "sts-secret"],
    ["credentials.ak", "ak-secret"],
    ["credentials.sk", "sk-secret"],
    ["ssh.privateKey", "PRIVATE KEY"],
    ["ssh.passphrase", "key-pass"],
    ["webdav.password", "dav-pass"],
  ])("脱敏审计敏感 key %s", (key, rawSecret) => {
    const result = exportAuditJSON(
      [
        row({
          key,
          values: {
            "c1:public": { exists: true, value: rawSecret },
            "c2:public": { exists: true, value: rawSecret },
          },
        }),
      ],
      [env("c1", "dev", "Development"), env("c2", "prod", "Production")],
      { sanitize: true }
    );

    expect(result.rows[0].values["c1:public"].value).toBe("***");
    expect(JSON.stringify(result)).not.toContain(rawSecret);
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
