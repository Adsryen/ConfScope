/**
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSnapshotFixtures } from "./snapshots";

const roots: string[] = [];

describe("createLocalSnapshotFixtures", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates strict, legacy, and invalid local snapshot directories", () => {
    const root = mkdtempSync(join(tmpdir(), "confscope-smoke-fixtures-"));
    roots.push(root);

    const fixtures = createLocalSnapshotFixtures({ rootDir: root, runId: "20260707-120000" });
    const metadata = JSON.parse(readFileSync(join(fixtures.strictPublic, "metadata.json"), "utf8")) as {
      schemaVersion: number;
      toolVersion: string;
      id: string;
      source: { provider: string; connectionId: string; connectionName: string; namespace: string; namespaceId: string };
      configs: Array<{ namespace: string; group: string; dataId: string; contentType: string }>;
    };

    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.toolVersion).toBe("confscope");
    expect(metadata.id).toBe("strict-public-20260707-120000");
    expect(metadata.source).toMatchObject({
      provider: "nacos",
      connectionId: "snapshot-source",
      connectionName: "Strict Snapshot",
      namespace: "public",
      namespaceId: "public",
    });
    expect(metadata.configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: "public", group: "DEFAULT_GROUP", dataId: "smoke-app.yaml", contentType: "yaml" }),
        expect.objectContaining({
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "smoke-secret.properties",
          contentType: "properties",
        }),
      ])
    );
    expect(readFileSync(join(fixtures.strictPublic, "configs", "public", "DEFAULT_GROUP", "smoke-app.yaml"), "utf8")).toContain(
      "feature: snapshot"
    );
    expect(readFileSync(join(fixtures.legacyPublic, "manifest.json"), "utf8")).toBe("{}");
    expect(fixtures.invalidEmpty).toContain("invalid-empty");
  });
});
