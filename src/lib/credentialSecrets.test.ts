import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_SECRET_FIELDS,
  deleteStoredSecret,
  formatStoredSecretRef,
  connectionSecretPatch,
  loadConnectionSecretsForEdit,
  loadSSHSecretsForEdit,
  sshSecretPatch,
  settleConnectionSecrets,
  settleSSHSecrets,
  countMigratableStoredCredentials,
  migrateStoredCredentials,
  resolveAppDataBackupPassword,
  resolveConnectionSSHConfig,
  resolveLargeSecret,
  resolveSecret,
  saveAppDataBackupPassword,
  writeAndVerifyLargeSecret,
  writeAndVerifySecret,
  type LargeSecretPointer,
  type SecureStoreClient,
  type StoredSecretPointer,
} from "./credentialSecrets";
import { loadConnections } from "../store/connections";
import { loadSSHProfiles } from "../store/sshProfiles";
import { loadAppDataBackupState } from "../store/appDataBackup";
import { loadSnapshotWebDAVState } from "../store/snapshotWebDAV";

class MemoryStorage {
  private values = new Map<string, string>();

  constructor() {
    // 本文件的断言写的是中文文案。jsdom 里 navigator.language 是 en-US，locale 只能来自
    // localStorage；一旦某个用例把 localStorage 换成内存替身，locale 就没人种了，
    // 后面的中文断言会取决于"谁先跑谁后跑"。这里默认种 zh-CN，把顺序依赖拿掉。
    this.values.set("locale", "zh-CN");
  }

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
    writeLarge: vi.fn(async (ref, value) => ({
      ref,
      storage: "dpapi-file",
      valueSize: value.length,
      verified: true,
    })),
    readLarge: vi.fn(async () => "secret-value"),
    deleteLarge: vi.fn(async () => undefined),
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

  it("stores and resolves the app-data backup encryption password through its dedicated ref", async () => {
    const client = makeClient();
    const pointer = await saveAppDataBackupPassword("backup-pass", { client, now: () => "2026-08-11T00:00:00.000Z" });

    expect(pointer).toMatchObject({
      ref: "app-data-backup.default.encryption-password",
      namespace: "app-data-backup",
      ownerId: "default",
      field: "encryption-password",
    });
    await expect(resolveAppDataBackupPassword(pointer, { client })).resolves.toBe("secret-value");
    await expect(saveAppDataBackupPassword("   ", { client })).rejects.toThrow("备份密码不能为空");
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

  it("migrates provider, WebDAV and SSH credentials into the system secure store", async () => {
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
            privateKey: "ssh-private-key-material-0123456789",
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
    localStorage.setItem(
      "cs.sshProfiles",
      JSON.stringify([
        {
          id: "ssh-p1",
          name: "jump",
          config: {
            host: "jump.example.com",
            port: 22,
            username: "ops",
            authType: "password",
            password: "profile-ssh-secret",
          },
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ])
    );
    const client = makeClient();

    const summary = await migrateStoredCredentials({ client, now: () => "2026-07-08T00:00:00.000Z" });

    expect(summary).toMatchObject({ migrated: 8, unsupported: 0, failed: 0 });
    expect(client.write).toHaveBeenCalledTimes(4);
    expect(client.writeLarge).toHaveBeenCalledTimes(4);
    const [conn] = loadConnections();
    expect(conn.password).toBe("");
    expect(conn.apolloToken).toBe("");
    expect(conn.secretRefs?.password).toMatchObject({ ref: "connection.conn-1.password", status: "stored" });
    expect(conn.secretRefs?.apolloToken).toMatchObject({ ref: "connection.conn-1.apolloToken", status: "stored" });
    expect(conn.sshConfig?.password).toBe("");
    expect(conn.sshConfig?.privateKey).toBe("");
    expect(conn.sshConfig?.passphrase).toBe("");
    expect(conn.sshSecretRefs?.password).toMatchObject({ ref: "connection-ssh.conn-1.password", status: "stored" });
    expect(conn.sshSecretRefs?.privateKey).toMatchObject({
      ref: "connection-ssh.conn-1.privateKey",
      status: "stored",
      storage: "dpapi-file",
    });
    expect(conn.sshSecretRefs?.passphrase).toMatchObject({ ref: "connection-ssh.conn-1.passphrase", status: "stored" });
    expect(loadAppDataBackupState().webdav).toMatchObject({
      password: "",
      passwordSecretRef: { ref: "app-data-webdav.default.password", status: "stored" },
    });
    expect(loadSnapshotWebDAVState().webdav).toMatchObject({
      password: "",
      passwordSecretRef: { ref: "snapshot-webdav.default.password", status: "stored" },
    });
    const [profile] = loadSSHProfiles();
    expect(profile.config.password).toBe("");
    expect(profile.sshSecretRefs?.password).toMatchObject({
      ref: "ssh-profile.ssh-p1.password",
      status: "stored",
      storage: "dpapi-file",
    });

    const serialized = JSON.stringify({
      connections: loadConnections(),
      sshProfiles: loadSSHProfiles(),
      appDataBackup: loadAppDataBackupState(),
      snapshotWebDAV: loadSnapshotWebDAVState(),
    });
    const key = "ssh-private-key-material-0123456789";
    for (let i = 0; i + 16 <= key.length; i += 1) {
      expect(serialized.includes(key.slice(i, i + 16))).toBe(false);
    }
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

    expect(countMigratableStoredCredentials()).toBe(4);
  });

  it("writes a large secret through a structured ref and returns a non-sensitive pointer", async () => {
    const client = makeClient();

    const pointer = await writeAndVerifyLargeSecret(
      { namespace: "connection-ssh", ownerId: "conn-1", field: "privateKey", value: "ssh-private-key-material-0123456789" },
      { client, now: () => "2026-07-08T00:00:00.000Z" }
    );

    expect(client.writeLarge).toHaveBeenCalledWith(
      { namespace: "connection-ssh", ownerId: "conn-1", field: "privateKey" },
      "ssh-private-key-material-0123456789"
    );
    expect(pointer).toEqual({
      ref: "connection-ssh.conn-1.privateKey",
      namespace: "connection-ssh",
      ownerId: "conn-1",
      field: "privateKey",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
      storage: "dpapi-file",
    });
    expect(JSON.stringify(pointer)).not.toContain("ssh-private-key-material");
  });

  it("keeps SSH credentials plaintext when the large store is unsupported", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-ssh-unsupported",
          name: "ssh",
          baseUrl: "http://nacos.example.com",
          username: "nacos",
          password: "",
          defaultNamespace: "",
          sshConfig: {
            host: "jump.example.com",
            port: 22,
            username: "ops",
            authType: "key",
            privateKey: "ssh-private-key-material-0123456789",
          },
        },
      ])
    );
    const client = makeClient();
    vi.mocked(client.writeLarge).mockRejectedValueOnce(new Error("系统凭据库（secret service）不可用，当前环境不支持"));

    const summary = await migrateStoredCredentials({ client, now: () => "2026-07-08T00:00:00.000Z" });

    expect(summary).toMatchObject({ migrated: 0, unsupported: 1, failed: 0 });
    const [conn] = loadConnections();
    expect(conn.sshConfig?.privateKey).toBe("ssh-private-key-material-0123456789");
    expect(conn.sshSecretRefs).toBeUndefined();
  });

  it("reports a clear error when a stored large secret pointer cannot be resolved", async () => {
    const client = makeClient();
    vi.mocked(client.readLarge).mockRejectedValueOnce(new Error("secret not found"));
    const pointer: LargeSecretPointer = {
      ref: "connection-ssh.conn-1.privateKey",
      namespace: "connection-ssh",
      ownerId: "conn-1",
      field: "privateKey",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
      storage: "dpapi-file",
    };

    await expect(resolveLargeSecret(pointer, { client })).rejects.toThrow(
      "凭据已迁移到系统凭据库，但当前系统中找不到 connection-ssh.conn-1.privateKey，请重新输入密码或从应用数据备份恢复"
    );
  });

  it("hydrates SSH config fields from large secret pointers without touching filled values", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-1",
          name: "dev",
          baseUrl: "http://nacos.example.com",
          username: "nacos",
          password: "",
          defaultNamespace: "",
          sshConfig: {
            host: "jump.example.com",
            port: 22,
            username: "ops",
            authType: "key",
            passphrase: "inline-passphrase",
          },
          sshSecretRefs: {
            privateKey: {
              ref: "connection-ssh.conn-1.privateKey",
              namespace: "connection-ssh",
              ownerId: "conn-1",
              field: "privateKey",
              migratedAt: "2026-07-08T00:00:00.000Z",
              status: "stored",
              storage: "dpapi-file",
            },
          },
        },
      ])
    );
    const client = makeClient();
    const [conn] = loadConnections();

    const resolved = await resolveConnectionSSHConfig(conn, { client });

    expect(resolved?.privateKey).toBe("secret-value");
    expect(resolved?.passphrase).toBe("inline-passphrase");
    expect(client.readLarge).toHaveBeenCalledWith({
      namespace: "connection-ssh",
      ownerId: "conn-1",
      field: "privateKey",
    });
  });
});

const pointer = (namespace: string, ownerId: string, field: string): StoredSecretPointer => ({
  ref: `${namespace}.${ownerId}.${field}`,
  namespace: namespace as StoredSecretPointer["namespace"],
  ownerId,
  field,
  migratedAt: "2026-07-08T00:00:00.000Z",
  status: "stored",
});

const largePointer = (namespace: "connection-ssh" | "ssh-profile", ownerId: string, field: string): LargeSecretPointer => ({
  ref: `${namespace}.${ownerId}.${field}`,
  namespace,
  ownerId,
  field: field as LargeSecretPointer["field"],
  migratedAt: "2026-07-08T00:00:00.000Z",
  status: "stored",
  storage: "dpapi-file",
});

describe("编辑回显与保存三路结算（轮142 C）", () => {
  it("reads migrated connection fields back for the edit form and records them as baseline", async () => {
    const client = makeClient();
    const conn = {
      password: "",
      accessKeyId: "",
      accessKeySecret: "",
      securityToken: "",
      apolloToken: "",
      consulToken: "",
      secretRefs: {
        password: pointer("connection", "conn-1", "password"),
        apolloToken: pointer("connection", "conn-1", "apolloToken"),
      },
    };

    const snapshot = await loadConnectionSecretsForEdit(conn, { client });

    expect(snapshot.values.password).toBe("secret-value");
    expect(snapshot.values.apolloToken).toBe("secret-value");
    expect(snapshot.baseline).toEqual(snapshot.values);
    expect(snapshot.unavailable).toEqual([]);
    // 没迁移过的字段不该多读一趟库
    expect(client.read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(snapshot)).not.toContain("secret-value-should-not-leak");
  });

  it("prefers inline plaintext over the pointer for records that were never migrated", async () => {
    const client = makeClient();

    const snapshot = await loadConnectionSecretsForEdit(
      { password: "inline-value", accessKeyId: "", accessKeySecret: "", securityToken: "", apolloToken: "", consulToken: "", secretRefs: undefined },
      { client }
    );

    expect(snapshot.values.password).toBe("inline-value");
    expect(client.read).not.toHaveBeenCalled();
  });

  it("keeps the form usable when a pointer cannot be resolved, and says which field is stale", async () => {
    const client = makeClient();
    vi.mocked(client.read).mockRejectedValueOnce(new Error("secret not found"));

    const snapshot = await loadConnectionSecretsForEdit(
      {
        password: "",
        accessKeyId: "",
        accessKeySecret: "",
        securityToken: "",
        apolloToken: "",
        consulToken: "",
        secretRefs: { password: pointer("connection", "conn-1", "password") },
      },
      { client }
    );

    expect(snapshot.values.password).toBe("");
    expect(snapshot.unavailable).toHaveLength(1);
    expect(snapshot.unavailable[0]).toMatchObject({ field: "password", ref: "connection.conn-1.password" });
  });

  it("writes nothing back to the vault for fields the user did not touch", async () => {
    const client = makeClient();
    const refs = { password: pointer("connection", "conn-1", "password") };
    const baseline = { password: "secret-value", accessKeyId: "" };

    const settled = await settleConnectionSecrets({
      ownerId: "conn-1",
      draft: { ...baseline, username: "changed" } as never,
      baseline,
      refs,
      deps: { client },
    });

    expect(settled.inline.password).toBe("");
    expect(settled.pointers.password).toEqual(refs.password);
    expect(client.write).not.toHaveBeenCalled();
    expect(settled.notices).toEqual([]);
  });

  it("re-stores a field the user changed and clears the inline copy", async () => {
    const client = makeClient();
    const refs = { password: pointer("connection", "conn-1", "password") };

    const settled = await settleConnectionSecrets({
      ownerId: "conn-1",
      draft: { password: "brand-new-secret" },
      baseline: { password: "secret-value" },
      refs,
      deps: { client, now: () => "2026-10-30T00:00:00.000Z" },
    });

    expect(client.write).toHaveBeenCalledWith({ namespace: "connection", ownerId: "conn-1", field: "password" }, "brand-new-secret");
    expect(settled.inline.password).toBe("");
    expect(settled.pointers.password).toMatchObject({ ref: "connection.conn-1.password", migratedAt: "2026-10-30T00:00:00.000Z" });
    // 落盘的两块（内联值 / 指针）不许出现明文；baseline 只活在组件内存里，正是靠它记住草稿值。
    expect(JSON.stringify({ inline: settled.inline, pointers: settled.pointers })).not.toContain("brand-new-secret");
    expect(settled.baseline.password).toBe("brand-new-secret");
  });

  it("deletes the vault entry when the user clears a field", async () => {
    const client = makeClient();

    const settled = await settleConnectionSecrets({
      ownerId: "conn-1",
      draft: { password: "" },
      baseline: { password: "secret-value" },
      refs: { password: pointer("connection", "conn-1", "password") },
      deps: { client },
    });

    expect(client.delete).toHaveBeenCalledWith({ namespace: "connection", ownerId: "conn-1", field: "password" });
    expect(settled.pointers.password).toBeUndefined();
    expect(settled.inline.password).toBe("");
  });

  it("drops the pointer even when the vault entry could not be deleted", async () => {
    const client = makeClient();
    vi.mocked(client.delete).mockRejectedValueOnce(new Error("keyring locked"));

    const settled = await settleConnectionSecrets({
      ownerId: "conn-1",
      draft: { password: "" },
      baseline: { password: "secret-value" },
      refs: { password: pointer("connection", "conn-1", "password") },
      deps: { client },
    });

    expect(settled.pointers.password).toBeUndefined();
    expect(settled.notices).toHaveLength(1);
  });

  it("falls back to inline storage quietly when the secure store is unavailable", async () => {
    const client = makeClient();
    vi.mocked(client.write).mockRejectedValueOnce(new Error("secure storage unsupported on this platform"));

    const settled = await settleConnectionSecrets({
      ownerId: "conn-1",
      draft: { password: "typed-by-hand" },
      baseline: { password: "" },
      refs: {},
      deps: { client },
    });

    expect(settled.inline.password).toBe("typed-by-hand");
    expect(settled.pointers.password).toBeUndefined();
    expect(settled.notices).toEqual([]);
  });

  it("reports a real write failure instead of pretending the secret is safe", async () => {
    const client = makeClient();
    vi.mocked(client.write).mockRejectedValueOnce(new Error("access denied"));

    const settled = await settleConnectionSecrets({
      ownerId: "conn-1",
      draft: { password: "typed-by-hand" },
      baseline: { password: "secret-value" },
      refs: { password: pointer("connection", "conn-1", "password") },
      deps: { client },
    });

    expect(settled.inline.password).toBe("typed-by-hand");
    expect(settled.notices[0]).toMatchObject({ field: "password", ref: "connection.conn-1.password" });
  });

  it("hydrates SSH profile secrets through the large store and settles them the same way", async () => {
    const client = makeClient();
    const config = { host: "jump", port: 22, username: "ops", authType: "password" as const, password: "", privateKey: "", passphrase: "" };
    const refs = { password: largePointer("ssh-profile", "ssh-1", "password") };

    const snapshot = await loadSSHSecretsForEdit(config, refs, { client });
    expect(snapshot.values.password).toBe("secret-value");
    expect(client.readLarge).toHaveBeenCalledWith({ namespace: "ssh-profile", ownerId: "ssh-1", field: "password" });

    const settled = await settleSSHSecrets({
      namespace: "ssh-profile",
      ownerId: "ssh-1",
      draft: { ...config, password: "new-ssh-secret" },
      baseline: snapshot.baseline,
      refs,
      deps: { client },
    });

    expect(client.writeLarge).toHaveBeenCalledWith({ namespace: "ssh-profile", ownerId: "ssh-1", field: "password" }, "new-ssh-secret");
    expect(settled.inline.password).toBe("");
    expect(settled.pointers.password).toMatchObject({ namespace: "ssh-profile", field: "password" });

    const untouched = await settleSSHSecrets({
      namespace: "ssh-profile",
      ownerId: "ssh-1",
      draft: { ...config, password: "secret-value" },
      baseline: snapshot.baseline,
      refs,
      deps: { client },
    });
    expect(untouched.inline.password).toBe("");
    expect(untouched.pointers.password).toEqual(refs.password);
  });

  it("covers every secret field on both stores so no field is silently skipped", async () => {
    const client = makeClient();
    const inline = {} as Record<(typeof CONNECTION_SECRET_FIELDS)[number], string>;
    const refs = {} as Record<(typeof CONNECTION_SECRET_FIELDS)[number], StoredSecretPointer>;
    for (const field of CONNECTION_SECRET_FIELDS) {
      inline[field] = "";
      refs[field] = pointer("connection", "conn-1", field);
    }

    const snapshot = await loadConnectionSecretsForEdit({ ...inline, secretRefs: refs }, { client });

    expect(Object.keys(snapshot.values).sort()).toEqual([...CONNECTION_SECRET_FIELDS].sort());

    const sshSnapshot = await loadSSHSecretsForEdit(
      { host: "h", port: 22, username: "u", authType: "key", password: "", privateKey: "", passphrase: "" },
      {
        password: largePointer("connection-ssh", "conn-1", "password"),
        privateKey: largePointer("connection-ssh", "conn-1", "privateKey"),
        passphrase: largePointer("connection-ssh", "conn-1", "passphrase"),
      },
      { client }
    );

    expect(Object.keys(sshSnapshot.values).sort()).toEqual(["passphrase", "password", "privateKey"]);
  });

  it("铺回字段的映射覆盖全部声明的凭据字段（轮142 C）", () => {
    // 页面靠这两个函数把 Record<string,string> 铺回具体字段：少一个键就是「看不见也存不上」的凭据。
    expect(Object.keys(connectionSecretPatch({})).sort()).toEqual([...CONNECTION_SECRET_FIELDS].sort());
    expect(Object.keys(sshSecretPatch({})).sort()).toEqual(["passphrase", "password", "privateKey"]);
    expect(connectionSecretPatch({ password: "p" })).toEqual({
      accessKeyId: "",
      accessKeySecret: "",
      apolloToken: "",
      consulToken: "",
      password: "p",
      securityToken: "",
    });
    expect(sshSecretPatch({ privateKey: "pem" }).privateKey).toBe("pem");
  });
});
