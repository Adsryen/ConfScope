/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSmokeAppBinding } from "./appBinding";
import { createSmokeWorkspace, type SmokeState } from "../env/workspace";

const roots: string[] = [];

function smokeState(): SmokeState {
  const projectRoot = mkdtempSync(join(tmpdir(), "confscope-smoke-binding-"));
  roots.push(projectRoot);
  const workspace = createSmokeWorkspace({ projectRoot, runId: "20260707-120000" });
  mkdirSync(workspace.appBackupsDir, { recursive: true });
  mkdirSync(workspace.webdavDir, { recursive: true });
  return {
    ...workspace,
    fixtures: {
      strictPublic: join(projectRoot, "strict"),
      legacyPublic: join(projectRoot, "legacy"),
      invalidEmpty: join(projectRoot, "invalid"),
    },
  };
}

describe("createSmokeAppBinding app data backup methods", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes encrypted local app data backups and decrypts them with the correct password", async () => {
    const state = smokeState();
    const invoke = createSmokeAppBinding(state);
    const path = join(state.appBackupsDir, "app.csbackup");
    const plaintext = JSON.stringify({ schemaVersion: 1, data: { connections: [{ password: "secret" }] } });
    const meta = { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" };

    await invoke("WriteAppDataBackupFile", [path, plaintext, "backup-pass", meta]);
    const bytes = readFileSync(path, "utf8");

    expect(bytes).not.toContain("connections");
    expect(bytes).not.toContain("secret");
    await expect(invoke("ReadAppDataBackupFile", [path, "backup-pass"])).resolves.toMatchObject({ plaintextJson: plaintext });
    await expect(invoke("ReadAppDataBackupFile", [path, "wrong-pass"])).rejects.toThrow();
  });
});
