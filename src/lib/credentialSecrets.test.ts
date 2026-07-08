import { describe, expect, it, vi } from "vitest";
import {
  deleteStoredSecret,
  formatStoredSecretRef,
  countMigratableStoredCredentials,
  migrateStoredCredentials,
  resolveSecret,
  writeAndVerifySecret,
  type SecureStoreClient,
  type StoredSecretPointer,
} from "./credentialSecrets";
import { loadConnections } from "../store/connections";
import { loadAppDataBackupState } from "../store/appDataBackup";
import { loadSnapshotWebDAVState } from "../store/snapshotWebDAV";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function makeClient(): SecureStoreClient {
  return {
    write: vi.fn(async (ref, value) => ({
      ref,
      targetName: `ConfScope/${ref.namespace}/${ref.ownerId}/${ref.field}`,
      valueSize: value.length,
      verified: true,
    })),
    read: vi.fn(async () => "secret-value"),
    delete: vi.fn(async () => undefined),
  };
}

describe("credential secrets", () => {
  it("writes a secret through a structured ref and returns a non-sensitive pointer", async () => {
    const client = makeClient();

    const pointer = await writeAndVerifySecret(
      { namespace: "connection", ownerId: "conn-1", field: "password", value: "nacos-secret" },
      { client, now: () => "2026-07-08T00:00:00.000Z" }
    );

    expect(client.write).toHaveBeenCalledWith({ namespace: "connection", ownerId: "conn-1", field: "password" }, "nacos-secret");
    expect(pointer).toEqual({
      ref: "connection.conn-1.password",
      namespace: "connection",
      ownerId: "conn-1",
      field: "password",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
    });
    expect(JSON.stringify(pointer)).not.toContain("nacos-secret");
  });

  it("rejects write results that were not verified", async () => {
    const client = makeClient();
    vi.mocked(client.write).mockResolvedValueOnce({
      ref: { namespace: "connection", ownerId: "conn-1", field: "password" },
      targetName: "ConfScope/connection/conn-1/password",
      valueSize: 12,
      verified: false,
    });

    await expect(
      writeAndVerifySecret({ namespace: "connection", ownerId: "conn-1", field: "password", value: "nacos-secret" }, { client })
    ).rejects.toThrow("系统凭据库写入后未通过读回校验");
  });

  it("resolves and deletes stored pointers through structured refs", async () => {
    const client = makeClient();
    const pointer: StoredSecretPointer = {
      ref: "app-data-webdav.default.password",
      namespace: "app-data-webdav",
      ownerId: "default",
      field: "password",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
    };

    await expect(resolveSecret(pointer, { client })).resolves.toBe("secret-value");
    await expect(deleteStoredSecret(pointer, { client })).resolves.toBeUndefined();

    expect(client.read).toHaveBeenCalledWith({ namespace: "app-data-webdav", ownerId: "default", field: "password" });
    expect(client.delete).toHaveBeenCalledWith({ namespace: "app-data-webdav", ownerId: "default", field: "password" });
  });

  it("reports a clear error when a stored pointer cannot be resolved", async () => {
    const client = makeClient();
    vi.mocked(client.read).mockRejectedValueOnce(new Error("secret not found"));
    const pointer: StoredSecretPointer = {
      ref: "snapshot-webdav.default.password",
      namespace: "snapshot-webdav",
      ownerId: "default",
      field: "password",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
    };

    await expect(resolveSecret(pointer, { client })).rejects.toThrow(
      "凭据已迁移到系统凭据库，但当前系统中找不到 snapshot-webdav.default.password，请重新输入密码或从应用数据备份恢复"
    );
  });

  it("formats stable non-sensitive refs for supported credential namespaces", () => {
    expect(formatStoredSecretRef({ namespace: "connection", ownerId: "conn-1", field: "apolloToken" })).toBe(
      "connection.conn-1.apolloToken"
    );
    expect(formatStoredSecretRef({ namespace: "app-data-webdav", ownerId: "default", field: "password" })).toBe(
      "app-data-webdav.default.password"
    );
    expect(formatStoredSecretRef({ namespace: "snapshot-webdav", ownerId: "default", field: "password" })).toBe(
      "snapshot-webdav.default.password"
    );
  });

  it("migrates provider and WebDAV small credentials while leaving SSH auth plaintext unchanged", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-1",
          name: "dev",
          provider: "apollo",
          baseUrl: "http://apollo.example.com",
          username: "nacos",
          password: "nacos-password",
          defaultNamespace: "order-service",
          apolloToken: "apollo-token",
          sshConfig: {
            host: "jump.example.com",
            port: 22,
            username: "ops",
            authType: "password",
            password: "ssh-secret",
            privateKey: "ssh-private-key",
            passphrase: "ssh-passphrase",
          },
        },
      ])
    );
    localStorage.setItem(
      "cs.appDataBackup",
      JSON.stringify({
        webdav: { enabled: true, url: "https://dav.example.com", username: "ops", password: "app-dav-secret", rootPath: "/confscope" },
        activities: [],
      })
    );
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "snapshot-dav-secret",
          rootPath: "/confscope/snapshots",
        },
        activities: [],
      })
    );
    const client = makeClient();

    const summary = await migrateStoredCredentials({ client, now: () => "2026-07-08T00:00:00.000Z" });

    expect(summary).toMatchObject({ migrated: 4, unsupported: 0, failed: 0 });
    expect(client.write).toHaveBeenCalledTimes(4);
    const [conn] = loadConnections();
    expect(conn.password).toBe("");
    expect(conn.apolloToken).toBe("");
    expect(conn.secretRefs?.password).toMatchObject({ ref: "connection.conn-1.password", status: "stored" });
    expect(conn.secretRefs?.apolloToken).toMatchObject({ ref: "connection.conn-1.apolloToken", status: "stored" });
    expect(conn.sshConfig?.password).toBe("ssh-secret");
    expect(conn.sshConfig?.privateKey).toBe("ssh-private-key");
    expect(conn.sshConfig?.passphrase).toBe("ssh-passphrase");
    expect(loadAppDataBackupState().webdav).toMatchObject({
      password: "",
      passwordSecretRef: { ref: "app-data-webdav.default.password", status: "stored" },
    });
    expect(loadSnapshotWebDAVState().webdav).toMatchObject({
      password: "",
      passwordSecretRef: { ref: "snapshot-webdav.default.password", status: "stored" },
    });
  });

  it("keeps plaintext fields when secure store is unsupported or read-back verification fails", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-unsupported",
          name: "unsupported",
          baseUrl: "http://nacos.example.com",
          username: "nacos",
          password: "nacos-password",
          defaultNamespace: "",
        },
        {
          id: "conn-failed",
          name: "failed",
          provider: "consul",
          baseUrl: "http://consul.example.com",
          username: "",
          password: "",
          defaultNamespace: "dc1",
          consulToken: "consul-token",
        },
      ])
    );
    const client = makeClient();
    vi.mocked(client.write)
      .mockRejectedValueOnce(new Error("unsupported platform"))
      .mockResolvedValueOnce({
        ref: { namespace: "connection", ownerId: "conn-failed", field: "consulToken" },
        targetName: "ConfScope/connection/conn-failed/consulToken",
        valueSize: 12,
        verified: false,
      });

    const summary = await migrateStoredCredentials({ client, now: () => "2026-07-08T00:00:00.000Z" });

    expect(summary).toMatchObject({ migrated: 0, unsupported: 1, failed: 1 });
    const [unsupported, failed] = loadConnections();
    expect(unsupported.password).toBe("nacos-password");
    expect(unsupported.secretRefs?.password).toBeUndefined();
    expect(failed.consulToken).toBe("consul-token");
    expect(failed.secretRefs?.consulToken).toBeUndefined();
  });

  it("counts plaintext small credentials that are still eligible for migration", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-count",
          name: "count",
          baseUrl: "http://nacos.example.com",
          username: "nacos",
          password: "nacos-password",
          accessKeySecret: "mse-secret",
          defaultNamespace: "",
          sshConfig: {
            host: "jump.example.com",
            port: 22,
            username: "ops",
            authType: "password",
            password: "ssh-secret",
          },
        },
      ])
    );
    localStorage.setItem(
      "cs.appDataBackup",
      JSON.stringify({
        webdav: { enabled: true, url: "https://dav.example.com", username: "ops", password: "app-dav-secret", rootPath: "/confscope" },
        activities: [],
      })
    );
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: { enabled: true, url: "https://dav.example.com", username: "ops", password: "", rootPath: "/confscope/snapshots" },
        activities: [],
      })
    );

    expect(countMigratableStoredCredentials()).toBe(3);
  });
});
