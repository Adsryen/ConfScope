import { describe, expect, it } from "vitest";
import { buildAuditMatrix, type AuditSource } from "./audit";

function source(env: string, entries: Record<string, string>): AuditSource {
  return {
    envId: env,
    label: env.toUpperCase(),
    providerType: "nacos",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    entries: Object.entries(entries).map(([key, value]) => ({
      key,
      value,
      valueType: "string",
      sourcePath: key,
      parseStatus: "ok",
    })),
  };
}

describe("buildAuditMatrix", () => {
  it("marks rows consistent when all environments have the same value", () => {
    const rows = buildAuditMatrix([source("dev", { "server.port": "8080" }), source("prod", { "server.port": "8080" })]);

    expect(rows).toEqual([
      expect.objectContaining({
        id: "public|DEFAULT_GROUP|app.yaml|server.port",
        key: "server.port",
        status: "consistent",
        values: {
          dev: expect.objectContaining({ value: "8080", exists: true }),
          prod: expect.objectContaining({ value: "8080", exists: true }),
        },
      }),
    ]);
  });

  it("marks rows inconsistent when every environment exists but values differ", () => {
    const rows = buildAuditMatrix([source("dev", { "server.port": "8080" }), source("prod", { "server.port": "9090" })]);

    expect(rows[0].status).toBe("inconsistent");
  });

  it("marks rows partial when at least two values match and another differs", () => {
    const rows = buildAuditMatrix([
      source("dev", { "server.port": "8080" }),
      source("test", { "server.port": "8080" }),
      source("prod", { "server.port": "9090" }),
    ]);

    expect(rows[0].status).toBe("partial");
  });

  it("marks rows missing when any selected environment lacks the key", () => {
    const rows = buildAuditMatrix([source("dev", { "server.port": "8080" }), source("prod", {})]);

    expect(rows[0].status).toBe("missing");
    expect(rows[0].values.prod).toEqual({ exists: false });
  });

  it("marks rows parse_error when a source entry failed to parse", () => {
    const rows = buildAuditMatrix([
      {
        ...source("dev", {}),
        entries: [
          {
            key: "__document",
            value: "{",
            valueType: "text",
            sourcePath: "__document",
            parseStatus: "error",
            parseError: "JSON parse failed",
          },
        ],
      },
      source("prod", { "__document": "{}" }),
    ]);

    expect(rows[0].status).toBe("parse_error");
  });

  it("marks ignored rows when an ignore rule matches", () => {
    const rows = buildAuditMatrix(
      [source("dev", { "server.port": "8080" }), source("prod", { "server.port": "9090" })],
      {
        ignoreRules: [
          {
            namespace: "public",
            group: "DEFAULT_GROUP",
            dataId: "app.*",
            key: "server.*",
            reason: "environment specific",
          },
        ],
      }
    );

    expect(rows[0].status).toBe("ignored");
    expect(rows[0].ignoreReason).toBe("environment specific");
  });

  it("normalizes dataId before grouping rows", () => {
    const rows = buildAuditMatrix(
      [
        { ...source("dev", { "server.port": "8080" }), dataId: "dev-app.yaml" },
        { ...source("prod", { "server.port": "8080" }), dataId: "prod-app.yaml" },
      ],
      {
        normalizeName: (name) => name.replace(/^(dev|prod)-/, ""),
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].dataId).toBe("app.yaml");
    expect(rows[0].originalDataIds).toEqual({ dev: "dev-app.yaml", prod: "prod-app.yaml" });
  });
});
