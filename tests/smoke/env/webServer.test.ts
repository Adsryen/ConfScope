/**
 * @vitest-environment node
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  smokeWebServerLogPath,
  smokeWebServerPidPath,
  startSmokeWebServer,
  stopSmokeWebServer,
  type SmokeSpawnedProcess,
} from "./webServer";
import { createSmokeWorkspace, ensureSmokeWorkspace } from "./workspace";

const roots: string[] = [];

class FakeChild extends EventEmitter implements SmokeSpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(readonly pid: number) {
    super();
  }
}

describe("smoke web server", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts Vite on the fixed smoke port and records pid/log paths", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-smoke-web-"));
    roots.push(projectRoot);
    const workspace = ensureSmokeWorkspace(createSmokeWorkspace({ projectRoot, runId: "20260707-120000" }));
    const child = new FakeChild(4242);
    const spawnProcess = vi.fn(() => child);
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("connection refused")).mockResolvedValueOnce(new Response("ok"));

    await startSmokeWebServer(workspace, {
      fetchFn,
      sleepFn: async () => undefined,
      spawnProcess,
      timeoutMs: 100,
      pollMs: 1,
    });

    try {
      expect(spawnProcess).toHaveBeenCalledWith(
        "pnpm",
        ["dev:web", "--host", "127.0.0.1", "--port", "15174", "--strictPort"],
        expect.objectContaining({ cwd: projectRoot, shell: true, windowsHide: true })
      );
      expect(readFileSync(smokeWebServerPidPath(workspace), "utf8")).toBe("4242");
      expect(existsSync(smokeWebServerLogPath(workspace))).toBe(true);
    } finally {
      child.emit("exit", 0, null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("refuses to start when the smoke port already responds", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-smoke-web-"));
    roots.push(projectRoot);
    const workspace = ensureSmokeWorkspace(createSmokeWorkspace({ projectRoot, runId: "20260707-120000" }));
    const spawnProcess = vi.fn(() => new FakeChild(4242));

    await expect(
      startSmokeWebServer(workspace, {
        fetchFn: async () => new Response("other app"),
        sleepFn: async () => undefined,
        spawnProcess,
        timeoutMs: 100,
        pollMs: 1,
      })
    ).rejects.toThrow("already responds");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("stops the recorded Vite process tree and removes the pid file", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-smoke-web-"));
    roots.push(projectRoot);
    const workspace = ensureSmokeWorkspace(createSmokeWorkspace({ projectRoot, runId: "20260707-120000" }));
    writeFileSync(smokeWebServerPidPath(workspace), "4242", "utf8");
    const killTree = vi.fn();

    stopSmokeWebServer(workspace, { killTree });

    expect(killTree).toHaveBeenCalledWith(4242);
    expect(existsSync(smokeWebServerPidPath(workspace))).toBe(false);
  });
});
