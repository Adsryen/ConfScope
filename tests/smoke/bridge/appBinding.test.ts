/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    vi.unstubAllGlobals();
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

  it("parses WebDAV multistatus XML with generic namespace prefixes", async () => {
    const state = smokeState();
    const invoke = createSmokeAppBinding(state);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/confscope/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection /></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/confscope/confscope-app-data-20260707-102829.csbackup</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>7147</D:getcontentlength>
        <D:getlastmodified>Tue, 07 Jul 2026 10:28:29 GMT</D:getlastmodified>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`,
          { status: 207, headers: { "Content-Type": "application/xml" } }
        )
      )
    );

    await expect(
      invoke("ListAppDataWebDAVBackups", [
        {
          enabled: true,
          url: state.webdav.baseUrl,
          username: state.webdav.username,
          password: state.webdav.password,
          rootPath: state.webdav.rootPath,
        },
      ])
    ).resolves.toEqual([
      {
        name: "confscope-app-data-20260707-102829.csbackup",
        path: "/confscope/confscope-app-data-20260707-102829.csbackup",
        size: 7147,
        modifiedAt: "Tue, 07 Jul 2026 10:28:29 GMT",
      },
    ]);
  });
});
