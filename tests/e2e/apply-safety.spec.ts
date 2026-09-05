import { expect, test, type Page } from "@playwright/test";

interface ApplySafetyDebug {
  calls: {
    applyWrites: Array<{ binding: string; connectionId: string; namespace: string; group: string; dataId: string; content?: string }>;
    directWrites: Array<{ binding: string; args: unknown[] }>;
    snapshots: Array<{ id: string; source: unknown; configs: unknown[] }>;
  };
  configs: Array<{ key: string; content: string }>;
  historyTypes: string[];
}

async function installApplySafetyMock(page: Page) {
  await page.addInitScript(() => {
    const connections = [
      {
        id: "conn-dev",
        name: "Dev",
        projectName: "Order",
        environmentName: "Development",
        sourceName: "LAN",
        sourceType: "nacos",
        provider: "nacos",
        distribution: "opensource",
        authType: "none",
        baseUrl: "http://dev.example.com/nacos",
        username: "",
        password: "",
        defaultNamespace: "public",
      },
      {
        id: "conn-sandbox",
        name: "Sandbox",
        projectName: "Order",
        environmentName: "Sandbox",
        sourceName: "Sandbox Nacos",
        sourceType: "nacos",
        provider: "nacos",
        distribution: "opensource",
        authType: "none",
        baseUrl: "http://sandbox.example.com/nacos",
        username: "",
        password: "",
        defaultNamespace: "public",
      },
      {
        id: "conn-prod",
        name: "Production",
        projectName: "Order",
        environmentName: "Production",
        sourceName: "Prod Nacos",
        sourceType: "nacos",
        provider: "nacos",
        distribution: "opensource",
        authType: "none",
        baseUrl: "http://prod.example.com/nacos",
        username: "",
        password: "",
        defaultNamespace: "public",
      },
    ];

    const calls = {
      applyWrites: [] as Array<{ binding: string; connectionId: string; namespace: string; group: string; dataId: string; content?: string }>,
      directWrites: [] as Array<{ binding: string; args: unknown[] }>,
      snapshots: [] as Array<{ id: string; source: unknown; configs: unknown[] }>,
    };
    const baseUrlToId = new Map(connections.map((conn) => [conn.baseUrl, conn.id]));
    const configs = new Map<
      string,
      { connectionId: string; namespace: string; group: string; dataId: string; content: string; format: string; version: string; updateTime: string }
    >();
    const snapshots = new Map<
      string,
      {
        id: string;
        path: string;
        name: string;
        description: string;
        createdAt: string;
        updatedAt: string;
        source: { provider: string; connectionId: string; connectionName: string; namespace: string; namespaceId: string };
        configs: Array<{ namespace: string; dataId: string; group: string; content: string; configType: string; updateTime: string }>;
      }
    >();
    let snapshotSeq = 0;
    let writeSeq = 0;

    const normalizeNamespace = (namespace: string) => namespace || "public";
    const normalizeGroup = (group: string) => group || "DEFAULT_GROUP";
    const configKey = (connectionId: string, namespace: string, group: string, dataId: string) =>
      [connectionId, normalizeNamespace(namespace), normalizeGroup(group), dataId].join("|");
    const putConfig = (connectionId: string, namespace: string, group: string, dataId: string, content: string, format = "yaml") => {
      writeSeq += 1;
      configs.set(configKey(connectionId, namespace, group, dataId), {
        connectionId,
        namespace: normalizeNamespace(namespace),
        group: normalizeGroup(group),
        dataId,
        content,
        format,
        version: `${connectionId}-v${writeSeq}`,
        updateTime: `2026-07-06T00:00:${String(writeSeq).padStart(2, "0")}.000Z`,
      });
    };
    const getStoredConfig = (connectionId: string, namespace: string, group: string, dataId: string) => {
      const stored = configs.get(configKey(connectionId, namespace, group, dataId));
      if (!stored) throw new Error(`404 not found: ${connectionId}/${normalizeNamespace(namespace)}/${normalizeGroup(group)}/${dataId}`);
      return stored;
    };
    const snapshotByPath = (path: string) => {
      for (const snapshot of snapshots.values()) {
        if (snapshot.path === path) return snapshot;
      }
      throw new Error(`snapshot path not found: ${path}`);
    };
    const snapshotConfig = (path: string, namespace: string, group: string, dataId: string) => {
      const snapshot = snapshotByPath(path);
      const stored = snapshot.configs.find(
        (item) => normalizeNamespace(item.namespace) === normalizeNamespace(namespace) && normalizeGroup(item.group) === normalizeGroup(group) && item.dataId === dataId
      );
      if (!stored) throw new Error(`404 not found in snapshot: ${path}/${normalizeNamespace(namespace)}/${normalizeGroup(group)}/${dataId}`);
      return { snapshot, stored };
    };
    const configDocument = (profile: { id: string; provider: string; baseUrl: string }, ref: { namespace: string; group: string; dataId: string }) => {
      if (profile.provider === "local") {
        const { stored } = snapshotConfig(profile.baseUrl, ref.namespace, ref.group, ref.dataId);
        return {
          ref,
          content: stored.content,
          format: stored.configType,
          version: `${profile.baseUrl}:${stored.updateTime}`,
          source: "local",
          updateTime: stored.updateTime,
        };
      }
      const stored = getStoredConfig(profile.id, ref.namespace, ref.group, ref.dataId);
      return {
        ref,
        content: stored.content,
        format: stored.format,
        version: stored.version,
        source: "nacos",
        updateTime: stored.updateTime,
      };
    };
    const rejectDirectWrite = (binding: string, args: unknown[]) => {
      calls.directWrites.push({ binding, args });
      return Promise.reject(new Error("direct write should require ApplyPlan"));
    };
    const publishFromApplyPlan = (binding: string, connectionId: string, namespace: string, dataId: string, group: string, content: string, configType: string) => {
      calls.applyWrites.push({ binding, connectionId, namespace: normalizeNamespace(namespace), group: normalizeGroup(group), dataId, content });
      putConfig(connectionId, namespace, group, dataId, content, configType || "yaml");
      return Promise.resolve();
    };
    const deleteFromApplyPlan = (binding: string, connectionId: string, namespace: string, dataId: string, group: string) => {
      calls.applyWrites.push({ binding, connectionId, namespace: normalizeNamespace(namespace), group: normalizeGroup(group), dataId });
      configs.delete(configKey(connectionId, namespace, group, dataId));
      return Promise.resolve();
    };

    putConfig("conn-dev", "public", "DEFAULT_GROUP", "app.yaml", "server:\n  port: 8080\nfeature: true\n");
    putConfig("conn-sandbox", "public", "DEFAULT_GROUP", "app.yaml", "server:\n  port: 9090\nfeature: false\n");
    putConfig("conn-prod", "public", "DEFAULT_GROUP", "app.yaml", "server:\n  port: 7070\nfeature: false\n");

    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.connections", JSON.stringify(connections));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "diff", connId: "conn-dev", sidebarCollapsed: false }));
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
        update: { skipVersion: "", lastCheckAt: "2026-07-06T00:00:00.000Z", lastSeenVersion: "" },
        compare: { sortConnections: true, sortNamespaces: true },
        startup: {
          lastOpenedVersion: "1.4.0-e2e",
          lastShownWelcomeVersion: "1.4.0-e2e",
          lastShownChangelogVersion: "1.4.0-e2e",
        },
      })
    );

    const app = {
      GetAppInfo: () => Promise.resolve({ name: "ConfScope", version: "1.4.0-e2e", updateSources: [] }),
      CheckForUpdates: () =>
        Promise.resolve({
          currentVersion: "1.4.0-e2e",
          latestVersion: "1.4.0-e2e",
          hasUpdate: false,
          sourceName: "",
          sourceUrl: "",
          downloadUrl: "",
          releaseNotes: "",
          publishedAt: "",
          sha256: "",
          mandatory: false,
          checkedAt: "2026-07-06T00:00:00.000Z",
          error: "",
        }),
      DownloadUpdate: () => Promise.resolve(""),
      GetDownloadProgress: () => Promise.resolve({ downloaded: 0, total: 0, percent: 0, done: true, error: "" }),
      InstallAndRestart: () => Promise.resolve(),
      GetCurrentPlatform: () => Promise.resolve("windows"),
      SelectLocalSnapshotDirectory: () => Promise.resolve(""),
      ValidateLocalSnapshotDirectory: () => Promise.resolve({ valid: true, path: "", code: "", message: "", configCount: 0 }),
      ConfigCenterListNamespaces: (profile: { id: string }) =>
        Promise.resolve([{ id: "public", name: "public", configCount: [...configs.keys()].filter((key) => key.startsWith(`${profile.id}|public|`)).length, kind: 0 }]),
      ConfigCenterListConfigs: (profile: { id: string }, request: { namespace: string; group: string; dataId: string; pageNo: number }) => {
        const items = [...configs.values()].filter(
          (item) =>
            item.connectionId === profile.id &&
            item.namespace === normalizeNamespace(request.namespace) &&
            (!request.group || item.group === normalizeGroup(request.group)) &&
            (!request.dataId || item.dataId === request.dataId)
        );
        return Promise.resolve({
          totalCount: items.length,
          pageNumber: request.pageNo,
          pagesAvailable: 1,
          pageItems: items.map((item) => ({
            ref: { provider: "nacos", connectionId: profile.id, namespace: item.namespace, group: item.group, dataId: item.dataId, key: "" },
            content: "",
            format: item.format,
            updateTime: item.updateTime,
          })),
        });
      },
      ConfigCenterGetConfig: configDocument,
      ConfigCenterPublishConfig: (...args: unknown[]) => rejectDirectWrite("ConfigCenterPublishConfig", args),
      ConfigCenterDeleteConfig: (...args: unknown[]) => rejectDirectWrite("ConfigCenterDeleteConfig", args),
      ConfigCenterPublishConfigFromApplyPlan: (
        profile: { id: string },
        request: { ref: { namespace: string; group: string; dataId: string }; content: string; format: string }
      ) =>
        publishFromApplyPlan(
          "ConfigCenterPublishConfigFromApplyPlan",
          profile.id,
          request.ref.namespace,
          request.ref.dataId,
          request.ref.group,
          request.content,
          request.format
        ),
      ConfigCenterDeleteConfigFromApplyPlan: (profile: { id: string }, ref: { namespace: string; group: string; dataId: string }) =>
        deleteFromApplyPlan("ConfigCenterDeleteConfigFromApplyPlan", profile.id, ref.namespace, ref.dataId, ref.group),
      ConfigCenterListHistory: () => Promise.resolve({ totalCount: 0, pageNumber: 1, pagesAvailable: 1, pageItems: [] }),
      ConfigCenterGetHistoryDetail: () => Promise.reject(new Error("history detail not used")),
      ConfigCenterTestConnection: () => Promise.resolve(),
      NacosDetectVersion: () => Promise.resolve("v1"),
      NacosLogin: () => Promise.resolve({ accessToken: "", tokenTtl: 18000, globalAdmin: false }),
      NacosNamespaces: () => Promise.resolve([{ namespace: "public", namespaceShowName: "public", configCount: 1, kind: 0 }]),
      NacosListConfigs: () => Promise.reject(new Error("legacy NacosListConfigs should not be used in this flow")),
      NacosGetConfig: () => Promise.reject(new Error("legacy NacosGetConfig should not be used in this flow")),
      NacosHistoryList: () => Promise.resolve({ totalCount: 0, pageNumber: 1, pagesAvailable: 1, pageItems: [] }),
      NacosHistoryDetail: () => Promise.reject(new Error("legacy history detail not used")),
      NacosPublishConfig: (...args: unknown[]) => rejectDirectWrite("NacosPublishConfig", args),
      NacosDeleteConfig: (...args: unknown[]) => rejectDirectWrite("NacosDeleteConfig", args),
      NacosPublishConfigFromApplyPlan: (
        baseUrl: string,
        _accessToken: string,
        _apiVersion: string,
        namespace: string,
        dataId: string,
        group: string,
        content: string,
        configType: string
      ) => publishFromApplyPlan("NacosPublishConfigFromApplyPlan", baseUrlToId.get(baseUrl) || baseUrl, namespace, dataId, group, content, configType),
      NacosDeleteConfigFromApplyPlan: (
        baseUrl: string,
        _accessToken: string,
        _apiVersion: string,
        namespace: string,
        dataId: string,
        group: string
      ) => deleteFromApplyPlan("NacosDeleteConfigFromApplyPlan", baseUrlToId.get(baseUrl) || baseUrl, namespace, dataId, group),
      CreateSSHTunnel: () => Promise.resolve(18848),
      TestSSHConnection: () => Promise.resolve({ ok: true }),
      StopSSHTunnel: () => Promise.resolve(),
      StopAllSSHTunnels: () => Promise.resolve(),
      GetSSHTunnelLocalPort: () => Promise.resolve(18848),
      CreateSnapshot: (
        source: { provider: string; connectionId: string; connectionName: string; namespace: string; namespaceId: string },
        snapshotConfigs: Array<{ namespace: string; dataId: string; group: string; content: string; configType: string; updateTime: string }>
      ) => {
        snapshotSeq += 1;
        const id = `snap-${snapshotSeq}`;
        const snapshot = {
          id,
          path: `mock://snapshot/${id}`,
          name: `${source.connectionName}_before_apply_${snapshotSeq}`,
          description: "",
          createdAt: `2026-07-06T00:01:${String(snapshotSeq).padStart(2, "0")}.000Z`,
          updatedAt: `2026-07-06T00:01:${String(snapshotSeq).padStart(2, "0")}.000Z`,
          source,
          configs: snapshotConfigs.map((item) => ({ ...item, namespace: normalizeNamespace(item.namespace) })),
        };
        snapshots.set(id, snapshot);
        calls.snapshots.push({ id, source, configs: snapshot.configs });
        return Promise.resolve(snapshot);
      },
      GetSnapshot: (id: string) => {
        const snapshot = snapshots.get(id);
        return snapshot ? Promise.resolve(snapshot) : Promise.reject(new Error(`snapshot ${id} not found`));
      },
      ListSnapshots: () => Promise.resolve([...snapshots.values()]),
      DeleteSnapshot: (id: string) => {
        snapshots.delete(id);
        return Promise.resolve();
      },
      ValidateSnapshot: (path: string) => {
        snapshotByPath(path);
        return Promise.resolve();
      },
    };

    (window as unknown as { go: { app: { App: typeof app } }; __applySafetyDebug: () => ApplySafetyDebug }).go = {
      app: { App: app },
    };
    (window as unknown as { __applySafetyDebug: () => ApplySafetyDebug }).__applySafetyDebug = () => ({
      calls,
      configs: [...configs.entries()].map(([key, value]) => ({ key, content: value.content })),
      historyTypes: JSON.parse(localStorage.getItem("cs.operationHistory") || "[]").map((record: { type: string }) => record.type),
    });
  });
}

async function debugState(page: Page): Promise<ApplySafetyDebug> {
  return page.evaluate(() => (window as unknown as { __applySafetyDebug: () => ApplySafetyDebug }).__applySafetyDebug());
}

async function waitForApplyWriteCount(page: Page, count: number) {
  await page.waitForFunction((expected) => (window as unknown as { __applySafetyDebug: () => ApplySafetyDebug }).__applySafetyDebug().calls.applyWrites.length >= expected, count);
}

async function chooseSourceBEnvironment(page: Page, environment: string) {
  const sourceB = page.locator(".source-picker").filter({ hasText: "Source B (Right)" });
  await sourceB.locator("label.field").filter({ hasText: "Environment" }).getByRole("button").click();
  await sourceB.locator(".sel-option", { hasText: environment }).click();
}

async function confirmProtectedApply(page: Page) {
  const text = (await page.locator(".apply-confirmation-code").textContent())?.trim();
  expect(text).toBeTruthy();
  await page.getByLabel("Confirmation text").fill(text || "");
}

test("diff to sandbox, promote to production, then rollback through ApplyPlan-only writes", async ({ page }) => {
  await installApplySafetyMock(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Config Compare" })).toBeVisible();
  await chooseSourceBEnvironment(page, "Sandbox");
  await page.getByRole("button", { name: "Load & Compare" }).click();
  await page.getByRole("button", { name: "Compare Selected (1)" }).click();
  await expect(page.getByText("Generated 1 file comparisons")).toBeVisible();
  await page.getByRole("button", { name: "Generate Batch Apply Plan" }).click();

  await expect(page.getByRole("button", { name: "Execute apply" })).toBeVisible();
  await page.getByLabel("I reviewed this dry-run plan and understand it will write to the target.").check();
  await page.getByRole("button", { name: "Execute apply" }).click();
  await waitForApplyWriteCount(page, 1);

  await page.getByRole("button", { name: "Operation History" }).click();
  await page.locator(".history-item", { hasText: "Apply plan" }).filter({ hasText: "app.yaml" }).first().click();
  await expect(page.getByRole("button", { name: "Promote to selected target" })).toBeDisabled();
  await page.getByLabel("Production target").selectOption("conn-prod");
  await page.getByRole("button", { name: "Mark sandbox verified" }).click();
  await expect(page.getByRole("button", { name: "Promote to selected target" })).toBeEnabled();
  await page.getByRole("button", { name: "Promote to selected target" }).click();

  await confirmProtectedApply(page);
  await page.getByRole("button", { name: "Execute apply" }).click();
  await waitForApplyWriteCount(page, 2);

  await page.getByRole("button", { name: "Operation History" }).click();
  await page.locator("select.history-filter-select").nth(1).selectOption("promote");
  await page.locator(".history-item", { hasText: "Promote" }).filter({ hasText: "app.yaml" }).first().click();
  await page.getByRole("button", { name: "Generate rollback plan" }).click();

  await confirmProtectedApply(page);
  await page.getByRole("button", { name: "Execute apply" }).click();
  await waitForApplyWriteCount(page, 3);

  const state = await debugState(page);
  expect(state.calls.directWrites).toHaveLength(0);
  expect(state.calls.applyWrites.map((call) => call.binding)).toEqual([
    "NacosPublishConfigFromApplyPlan",
    "NacosPublishConfigFromApplyPlan",
    "NacosPublishConfigFromApplyPlan",
  ]);
  expect(state.historyTypes).toEqual(expect.arrayContaining(["apply", "promote", "restore"]));
  expect(state.configs).toEqual(
    expect.arrayContaining([
      {
        key: "conn-sandbox|public|DEFAULT_GROUP|app.yaml",
        content: "server:\n  port: 8080\nfeature: true\n",
      },
      {
        key: "conn-prod|public|DEFAULT_GROUP|app.yaml",
        content: "server:\n  port: 7070\nfeature: false\n",
      },
    ])
  );
});
