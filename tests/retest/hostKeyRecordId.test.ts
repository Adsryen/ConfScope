/**
 * 复测桥的主机密钥替身必须与 Go 侧的 known_hosts 记录身份同格式。
 *
 * 立测理由（2026-10-28 复检 r104 前端时发现）：桥的 ProbeSSHHostKey 把记录身份拼成
 * `[host]:port`，TrustSSHHostKey 却写成 `[host:port]`。两侧都在「用户确认后重探一次」
 * 这条链路上，格式一旦分叉，确认后永远查不到已信任记录，界面停在同一句「未信任」上——
 * 真机复测会红，而产品代码其实没问题，取证方向被替身带偏。Go 侧的权威写法在
 * internal/ssh/knownhosts.go 的 recordID()：22 端口写裸主机，非 22 端口一律写
 * `[host]:port`（与 OpenSSH / ssh-keyscan 真机输出一致：方括号只看端口是否为默认值）。
 * 这里把「确认 → 重探直通」和三种身份写法钉成机器判定。
 */
import { describe, expect, it } from "vitest";
import { createRetestInvoke } from "./bridge/retestBinding";
import { loadRetestState } from "./state";

interface HostKeyStatus {
  status: string;
  host: string;
  port: number;
  recordId: string;
  keyType?: string;
  keyBase64?: string;
  fingerprint?: string;
  recordFingerprint?: string;
  knownHostsPath: string;
}

const invoke = createRetestInvoke();
const ssh = loadRetestState().ssh!;

function cfg(host: string, port: number) {
  return { host, port, username: ssh.username, password: ssh.password, authType: "password" };
}

/** 标记放进 username，让 host 保持成 IP 字面量。 */
function cfgIp(host: string, port: number) {
  return { host, port, username: `hk-unknown-${ssh.username}`, password: ssh.password, authType: "password" };
}

async function probe(host: string, port: number): Promise<HostKeyStatus> {
  return (await invoke("ProbeSSHHostKey", [cfg(host, port)])) as unknown as HostKeyStatus;
}

async function probeVec(host: string, port: number): Promise<HostKeyStatus> {
  return (await invoke("ProbeSSHHostKey", [cfgIp(host, port)])) as unknown as HostKeyStatus;
}

async function trust(status: HostKeyStatus) {
  return invoke("TrustSSHHostKey", [status.host, status.port, status.keyType ?? "", status.keyBase64 ?? ""]);
}

describe("主机密钥替身的记录身份与 Go 侧一致", () => {
  it("非 22 端口的主机名写成 [host]:port，确认后重探直通", async () => {
    const host = "hk-unknown-bastion.example.net";
    const first = await probe(host, 2223);
    expect(first.status).toBe("hostKeyUnknown");
    expect(first.recordId).toBe(`[${host}]:2223`);

    await trust(first);
    expect((await probe(host, 2223)).status).toBe("trusted");
  });

  it("非 22 端口的 IP 字面量写成 [ip]:port，确认后重探直通", async () => {
    const host = "10.255.0.7";
    const first = await probeVec(host, 2223);
    expect(first.status).toBe("hostKeyUnknown");
    expect(first.recordId).toBe(`[${host}]:2223`);

    await trust(first);
    expect((await probeVec(host, 2223)).status).toBe("trusted");
  });

  it("22 端口写裸主机名，确认后重探直通", async () => {
    const host = "hk-unknown-default-port.example.com";
    const first = await probe(host, 22);
    expect(first.status).toBe("hostKeyUnknown");
    expect(first.recordId).toBe(host);

    await trust(first);
    expect((await probe(host, 22)).status).toBe("trusted");
  });

  it("指纹变更的 host 确认不掉，重探仍是硬阻断", async () => {
    const host = "hk-changed-bastion.example.net";
    const status = await probe(host, 2223);
    expect(status.status).toBe("hostKeyChanged");
    expect(status.recordFingerprint).toBeTruthy();
    expect(status.recordFingerprint).not.toBe(status.fingerprint);

    await trust(status);
    expect((await probe(host, 2223)).status).toBe("hostKeyChanged");
  });

  it("未确认的主机不允许拨号，确认后才放行；变更的主机永不拨号", async () => {
    const host = "hk-unknown-dial.example.net";
    await expect(invoke("TestSSHConnection", [cfg(host, 2223)])).rejects.toThrow(/未确认/);

    await trust(await probe(host, 2223));
    await expect(invoke("TestSSHConnection", [cfg(host, 2223)])).resolves.toMatchObject({ latencyMs: 15 });

    const changedHost = "hk-changed-dial.example.net";
    await expect(invoke("TestSSHConnection", [cfg(changedHost, 2223)])).rejects.toThrow(/已变更/);
  });

  it("既有替身路径不受影响：127.0.0.1 仍然直通", async () => {
    const status = await probe(ssh.host, ssh.port);
    expect(status.status).toBe("trusted");
    expect(status.recordId).toBe(`[${ssh.host}]:${ssh.port}`);
    await expect(invoke("TestSSHConnection", [cfg(ssh.host, ssh.port)])).resolves.toMatchObject({ latencyMs: 12 });
  });
});
