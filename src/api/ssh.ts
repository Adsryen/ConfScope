import { ProbeSSHHostKey, TestSSHConnection, TrustSSHHostKey } from "../../wailsjs/go/app/App";
import type { SSHConfig } from "../store/connections";

/** 主机密钥裁决值，与 Go 侧 HostKeyVerdict 的 JSON 取值一致（internal/ssh/knownhosts.go）。 */
export type HostKeyStatusVerdict = "trusted" | "hostKeyUnknown" | "hostKeyChanged" | "hostKeyMismatch";

/**
 * ProbeSSHHostKey 的裁决结果。字段名跟随 Go 侧 HostKeyStatus 的 JSON tag。
 * 类型手写在这里而不是 wailsjs/go/models.ts：生成物里没有这个结构，
 * 写进 models.ts 会随 wails generate 漂移，这里与后端 JSON 口径一一对应即可。
 */
export interface HostKeyStatus {
  status: HostKeyStatusVerdict;
  host: string;
  port: number;
  recordId: string;
  keyType?: string;
  keyBase64?: string;
  fingerprint?: string;
  recordFingerprint?: string;
  knownHostsPath: string;
}

export interface SSHTestResult {
  latencyMs: number;
}

/** 探测主机密钥裁决：不建隧道、不完成认证，只回答「这把钥匙认不认识」。 */
export function probeSSHHostKey(config: SSHConfig): Promise<HostKeyStatus> {
  return ProbeSSHHostKey(config) as Promise<HostKeyStatus>;
}

/** 把用户确认过的主机密钥写入 known_hosts 记录。 */
export function trustSSHHostKey(host: string, port: number, keyType: string, keyBase64: string): Promise<void> {
  return TrustSSHHostKey(host, port, keyType, keyBase64) as Promise<void>;
}

export function testSSHConnection(config: SSHConfig): Promise<SSHTestResult> {
  return TestSSHConnection(config) as Promise<SSHTestResult>;
}
