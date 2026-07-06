import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalSnapshotFixtures {
  strictPublic: string;
  legacyPublic: string;
  invalidEmpty: string;
}

export interface CreateLocalSnapshotFixturesOptions {
  rootDir: string;
  runId: string;
}

export function createLocalSnapshotFixtures(options: CreateLocalSnapshotFixturesOptions): LocalSnapshotFixtures {
  const strictPublic = join(options.rootDir, "strict-public");
  const legacyPublic = join(options.rootDir, "legacy-public");
  const invalidEmpty = join(options.rootDir, "invalid-empty");

  createStrictPublicSnapshot(strictPublic, options.runId);
  createLegacyPublicSnapshot(legacyPublic);
  mkdirSync(invalidEmpty, { recursive: true });

  return { strictPublic, legacyPublic, invalidEmpty };
}

function createStrictPublicSnapshot(root: string, runId: string): void {
  const configDir = join(root, "configs", "public", "DEFAULT_GROUP");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "smoke-app.yaml"), "server:\n  port: 6060\nfeature: snapshot\n", "utf8");
  writeFileSync(join(configDir, "smoke-secret.properties"), "password=snapshot-secret\ntoken=snapshot-token\n", "utf8");

  const timestamp = new Date("2026-07-07T00:00:00.000Z").toISOString();
  const metadata = {
    schemaVersion: 1,
    toolVersion: "confscope",
    id: `strict-public-${runId}`,
    name: `strict-public-${runId}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      provider: "nacos",
      connectionId: "snapshot-source",
      connectionName: "Strict Snapshot",
      namespace: "public",
      namespaceId: "public",
    },
    configs: [
      {
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "smoke-app.yaml",
        contentType: "yaml",
        configType: "yaml",
        updateTime: timestamp,
      },
      {
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "smoke-secret.properties",
        contentType: "properties",
        configType: "properties",
        updateTime: timestamp,
      },
    ],
  };
  writeFileSync(join(root, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
}

function createLegacyPublicSnapshot(root: string): void {
  const configDir = join(root, "configs", "public", "DEFAULT_GROUP");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(root, "manifest.json"), "{}", "utf8");
  writeFileSync(join(configDir, "smoke-app.yaml"), "server:\n  port: 5050\nfeature: legacy\n", "utf8");
}
