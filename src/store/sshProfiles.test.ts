import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionSSHConfig,
  loadSSHProfiles,
  sshProfileLabel,
  upsertSSHProfile,
} from "./sshProfiles";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

describe("ssh profile store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("persists reusable SSH profiles", () => {
    const profile = upsertSSHProfile({
      name: "公司堡垒机",
      config: {
        host: "jump.example.com",
        port: 22,
        username: "ops",
        authType: "password",
        password: "secret",
      },
    });

    expect(profile.id).toMatch(/^ssh_/);
    expect(loadSSHProfiles()).toEqual([profile]);
    expect(sshProfileLabel(profile)).toBe("公司堡垒机 (ops@jump.example.com:22)");
  });

  it("resolves connection SSH config from profile before inline config", () => {
    const profile = upsertSSHProfile({
      name: "生产跳板机",
      config: {
        host: "prod-jump.example.com",
        port: 2222,
        username: "deploy",
        authType: "key",
        privateKey: "key",
      },
    });

    expect(connectionSSHConfig({
      sshProfileId: profile.id,
      sshConfig: {
        host: "old.example.com",
        port: 22,
        username: "root",
        authType: "password",
      },
    })).toEqual(expect.objectContaining({
      host: "prod-jump.example.com",
      port: 2222,
      username: "deploy",
      authType: "key",
    }));
  });
});
