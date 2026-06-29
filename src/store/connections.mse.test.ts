import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConnections, upsertConnection } from "./connections";

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

describe("MSE Nacos connection store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.223344);
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("defaults old Nacos connections to open-source password auth", () => {
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "legacy",
          name: "dev",
          baseUrl: "http://localhost:8848/nacos",
          username: "nacos",
          password: "secret",
          defaultNamespace: "public",
        },
      ])
    );

    expect(loadConnections()).toEqual([
      {
        id: "legacy",
        name: "dev",
        provider: "nacos",
        distribution: "opensource",
        authType: "nacos-password",
        baseUrl: "http://localhost:8848/nacos",
        username: "nacos",
        password: "secret",
        defaultNamespace: "public",
      },
    ]);
  });

  it("persists Aliyun MSE Nacos AK/SK fields", () => {
    const created = upsertConnection({
      name: "mse-dev",
      provider: "nacos",
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      baseUrl: "https://mse.example.com/nacos",
      username: "",
      password: "",
      accessKeyId: "ak-test",
      accessKeySecret: "sk-test",
      securityToken: "sts-token",
      defaultNamespace: "public",
    });

    expect(loadConnections()).toEqual([created]);
    expect(loadConnections()[0]).toMatchObject({
      provider: "nacos",
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      accessKeyId: "ak-test",
      accessKeySecret: "sk-test",
      securityToken: "sts-token",
    });
  });
});
