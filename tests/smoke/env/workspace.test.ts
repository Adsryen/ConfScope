/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { createSmokeWorkspace } from "./workspace";

describe("createSmokeWorkspace", () => {
  it("creates a deterministic workspace under .tmp for a provided run id", () => {
    const workspace = createSmokeWorkspace({ projectRoot: "C:/repo/ConfScope", runId: "20260707-120000" });

    expect(workspace.runId).toBe("20260707-120000");
    expect(workspace.rootDir.replaceAll("\\", "/")).toBe("C:/repo/ConfScope/.tmp/full-smoke-20260707-120000");
    expect(workspace.homeDir.replaceAll("\\", "/")).toBe("C:/repo/ConfScope/.tmp/full-smoke-20260707-120000/home");
    expect(workspace.localSnapshotsDir.replaceAll("\\", "/")).toBe("C:/repo/ConfScope/.tmp/full-smoke-20260707-120000/local-snapshots");
    expect(workspace.appBackupsDir.replaceAll("\\", "/")).toBe("C:/repo/ConfScope/.tmp/full-smoke-20260707-120000/app-backups");
    expect(workspace.webdavDir.replaceAll("\\", "/")).toBe("C:/repo/ConfScope/.tmp/full-smoke-20260707-120000/webdav");
    expect(workspace.reportsDir.replaceAll("\\", "/")).toBe("C:/repo/ConfScope/.tmp/full-smoke-20260707-120000/reports");
    expect(workspace.nacos.dev.baseUrl).toBe("http://127.0.0.1:18858/nacos");
    expect(workspace.nacos.sandbox.baseUrl).toBe("http://127.0.0.1:18859/nacos");
    expect(workspace.nacos.prod.baseUrl).toBe("http://127.0.0.1:18860/nacos");
    expect(workspace.apollo.baseUrl).toBe("http://127.0.0.1:18862");
    expect(workspace.apollo.token).toBe("apollo-smoke-token");
    expect(workspace.apollo.env).toBe("DEV");
    expect(workspace.apollo.appId).toBe("order-service");
    expect(workspace.apollo.cluster).toBe("default");
    expect(workspace.apollo.namespaceName).toBe("application");
    expect(workspace.consul.baseUrl).toBe("http://127.0.0.1:18863");
    expect(workspace.consul.datacenter).toBe("dc1");
    expect(workspace.consul.keyPrefix).toBe("apps/order/");
    expect(workspace.ssh.host).toBe("127.0.0.1");
    expect(workspace.ssh.hostPort).toBe(18864);
    expect(workspace.ssh.username).toBe("smoke");
    expect(workspace.ssh.password).toBe("smoke-pass");
    expect(workspace.webdav.baseUrl).toBe("http://127.0.0.1:18861");
    expect(workspace.webdav.username).toBe("smoke");
    expect(workspace.webdav.password).toBe("smoke-pass");
  });
});
