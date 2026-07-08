/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeReports, type SmokeCaseResult } from "../env/report";
import { createSmokeWorkspace, type SmokeState } from "../env/workspace";
import { startNativeDockerEnvironment, type NativeDockerEnvironmentDeps } from "./global-setup";

const tempRoots: string[] = [];

describe("native global setup", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts Apollo and Consul containers for native provider smoke coverage", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-native-setup-"));
    tempRoots.push(projectRoot);
    const sshFixtureDir = join(projectRoot, "tests", "smoke", "fixtures", "ssh");
    mkdirSync(sshFixtureDir, { recursive: true });
    writeFileSync(join(sshFixtureDir, "sshd_config"), "AllowTcpForwarding yes\nGatewayPorts no\n", "utf8");
    const state: SmokeState = {
      ...createSmokeWorkspace({ projectRoot, runId: "native-setup" }),
      fixtures: { strictPublic: "", legacyPublic: "", invalidEmpty: "" },
    };
    initializeReports(state);
    const calls: string[] = [];
    const deps: NativeDockerEnvironmentDeps = {
      cleanupSmokeContainers: () => calls.push("cleanup"),
      createSmokeNetwork: () => calls.push("network"),
      startNacosContainer: (endpoint) => calls.push(`nacos:${endpoint.role}`),
      startApolloContainer: (endpoint, serverFile) => calls.push(`apollo:${endpoint.containerName}:${serverFile.replaceAll("\\", "/")}`),
      startConsulContainer: (endpoint) => calls.push(`consul:${endpoint.containerName}`),
      startSSHContainer: (endpoint, configFile) => calls.push(`ssh:${endpoint.containerName}:${configFile.replaceAll("\\", "/")}`),
      startWebDAVContainer: (endpoint) => calls.push(`webdav:${endpoint.containerName}`),
      waitForNacos: async (endpoint) => calls.push(`wait-nacos:${endpoint.role}`),
      cleanupNacosSeed: async (endpoint) => calls.push(`cleanup-seed:${endpoint.role}`),
      seedNacos: async (endpoint) => calls.push(`seed-nacos:${endpoint.role}`),
      waitForApollo: async (endpoint) => calls.push(`wait-apollo:${endpoint.containerName}`),
      seedConsul: async (endpoint) => calls.push(`seed-consul:${endpoint.containerName}`),
      waitForConsul: async (endpoint) => calls.push(`wait-consul:${endpoint.containerName}`),
      waitForSSH: async (endpoint) => calls.push(`wait-ssh:${endpoint.containerName}`),
      waitForWebDAV: async (endpoint) => calls.push(`wait-webdav:${endpoint.containerName}`),
    };

    await startNativeDockerEnvironment(state, deps);

    expect(calls).toContain(`apollo:confscope-smoke-apollo:${projectRoot.replaceAll("\\", "/")}/tests/smoke/fixtures/apollo/server.mjs`);
    expect(calls).toContain("consul:confscope-smoke-consul");
    expect(calls).toContain("wait-apollo:confscope-smoke-apollo");
    expect(calls).toContain("seed-consul:confscope-smoke-consul");
    expect(calls).toContain("wait-consul:confscope-smoke-consul");
    expect(calls).toContain(`ssh:confscope-smoke-sshd:${state.rootDir.replaceAll("\\", "/")}/ssh/sshd_config`);
    expect(readFileSync(join(state.rootDir, "ssh", "sshd_config"), "utf8")).toContain("AllowTcpForwarding yes");
    expect(calls).toContain("wait-ssh:confscope-smoke-sshd");
    const cases = JSON.parse(readFileSync(join(state.reportsDir, "cases.json"), "utf8")) as SmokeCaseResult[];
    expect(cases).toContainEqual(expect.objectContaining({ id: "ENV-APOLLO-01", status: "PASS" }));
    expect(cases).toContainEqual(expect.objectContaining({ id: "ENV-CONSUL-01", status: "PASS" }));
    expect(cases).toContainEqual(expect.objectContaining({ id: "ENV-SSH-01", status: "PASS" }));
  });
});
