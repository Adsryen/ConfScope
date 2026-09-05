import { expect, pass, test } from "./smokeTest";

test("uses Wails bridge bindings against real Docker Nacos and local snapshots", async ({ page, smoke }) => {
  await page.goto("/");

  const result = await page.evaluate(async (state) => {
    const app = window.go.app.App;
    const devProfile = {
      id: "smoke-dev",
      name: "Dev Nacos",
      provider: "nacos",
      distribution: "opensource",
      authType: "none",
      baseUrl: "http://127.0.0.1:18858/nacos",
      accessToken: "",
      apiVersion: "v1",
      accessKeyId: "",
      accessKeySecret: "",
      securityToken: "",
      environment: "Development",
      safetyLevel: "",
      useProxy: false,
    };
    const sandboxProfile = { ...devProfile, id: "smoke-sandbox", name: "Sandbox Nacos", baseUrl: "http://127.0.0.1:18859/nacos" };
    const ref = { provider: "nacos", connectionId: "smoke-dev", namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-app.yaml", key: "" };
    const pageResult = await app.ConfigCenterListConfigs(devProfile, { namespace: "", group: "DEFAULT_GROUP", dataId: "", pageNo: 1, pageSize: 20 });
    const devDoc = await app.ConfigCenterGetConfig(devProfile, ref);
    let directWriteBlocked = false;
    try {
      await app.ConfigCenterPublishConfig(devProfile, { ref, content: "blocked: true\n", format: "yaml" });
    } catch {
      directWriteBlocked = true;
    }
    await app.ConfigCenterPublishConfigFromApplyPlan(sandboxProfile, {
      ref: { ...ref, connectionId: "smoke-sandbox" },
      content: devDoc.content,
      format: "yaml",
    });
    const sandboxDoc = await app.ConfigCenterGetConfig(sandboxProfile, { ...ref, connectionId: "smoke-sandbox" });
    const snapshot = await app.CreateSnapshot(
      { provider: "nacos", connectionId: "smoke-dev", connectionName: "Dev Nacos", namespace: "public", namespaceId: "public" },
      [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "smoke-app.yaml", content: devDoc.content, configType: "yaml", contentType: "yaml" }]
    );
    const apolloProfile = {
      id: "smoke-apollo-apply",
      name: "Apollo Apply",
      provider: "apollo",
      baseUrl: state.apollo.baseUrl,
      accessToken: state.apollo.token,
      apolloEnv: state.apollo.env,
      apolloAppId: state.apollo.appId,
      apolloCluster: state.apollo.cluster,
      apolloNamespaceName: state.apollo.namespaceName,
    };
    const apolloRef = {
      provider: "apollo",
      connectionId: "smoke-apollo-apply",
      namespace: state.apollo.appId,
      group: state.apollo.cluster,
      dataId: state.apollo.namespaceName,
      key: "smoke.apply",
    };
    let apolloDirectWriteBlocked = false;
    try {
      await app.ConfigCenterPublishConfig(apolloProfile, { ref: apolloRef, content: "blocked", format: "properties" });
    } catch {
      apolloDirectWriteBlocked = true;
    }
    await app.ConfigCenterPublishConfigFromApplyPlan(apolloProfile, { ref: apolloRef, content: "ok", format: "properties" });
    const apolloAfterPublish = await app.ConfigCenterGetConfig(apolloProfile, { ...apolloRef, key: "" });
    await app.ConfigCenterDeleteConfigFromApplyPlan(apolloProfile, apolloRef);
    const apolloAfterDelete = await app.ConfigCenterGetConfig(apolloProfile, { ...apolloRef, key: "" });
    const consulProfile = {
      id: "smoke-consul-apply",
      name: "Consul Apply",
      provider: "consul",
      baseUrl: state.consul.baseUrl,
      accessToken: "",
      consulDatacenter: state.consul.datacenter,
      consulKeyPrefix: state.consul.keyPrefix,
    };
    const consulKey = `${state.consul.keyPrefix}smoke-apply-${Date.now()}.yaml`;
    const consulRef = {
      provider: "consul",
      connectionId: "smoke-consul-apply",
      namespace: state.consul.datacenter,
      group: state.consul.keyPrefix,
      dataId: consulKey,
      key: "__document",
    };
    let consulDirectWriteBlocked = false;
    try {
      await app.ConfigCenterPublishConfig(consulProfile, { ref: consulRef, content: "blocked: true\n", format: "yaml" });
    } catch {
      consulDirectWriteBlocked = true;
    }
    await app.ConfigCenterPublishConfigFromApplyPlan(consulProfile, {
      ref: { ...consulRef, expectedVersion: "0" },
      content: "smoke: created\n",
      format: "yaml",
    });
    const consulAfterCreate = await app.ConfigCenterGetConfig(consulProfile, consulRef);
    await app.ConfigCenterPublishConfigFromApplyPlan(consulProfile, {
      ref: { ...consulRef, expectedVersion: String(consulAfterCreate.version || "") },
      content: "smoke: updated\n",
      format: "yaml",
    });
    const consulAfterUpdate = await app.ConfigCenterGetConfig(consulProfile, consulRef);
    let consulStaleBlocked = false;
    try {
      await app.ConfigCenterPublishConfigFromApplyPlan(consulProfile, {
        ref: { ...consulRef, expectedVersion: String(consulAfterCreate.version || "") },
        content: "smoke: stale\n",
        format: "yaml",
      });
    } catch {
      consulStaleBlocked = true;
    }
    await app.ConfigCenterDeleteConfigFromApplyPlan(consulProfile, {
      ...consulRef,
      expectedVersion: String(consulAfterUpdate.version || ""),
    });
    let consulDeleted = false;
    try {
      await app.ConfigCenterGetConfig(consulProfile, consulRef);
    } catch {
      consulDeleted = true;
    }
    const snapshots = await app.ListSnapshots();
    const strictValidation = await app.ValidateLocalSnapshotDirectory(state.fixtures.strictPublic);
    const invalidValidation = await app.ValidateLocalSnapshotDirectory(state.fixtures.invalidEmpty);
    return {
      listed: pageResult.pageItems.length,
      devContent: devDoc.content,
      sandboxContent: sandboxDoc.content,
      directWriteBlocked,
      apolloDirectWriteBlocked,
      apolloPublished: apolloAfterPublish.content.includes("smoke.apply=ok"),
      apolloDeleted: !apolloAfterDelete.content.includes("smoke.apply=ok"),
      consulDirectWriteBlocked,
      consulCreated: String(consulAfterCreate.content || "").includes("smoke: created"),
      consulUpdated: String(consulAfterUpdate.content || "").includes("smoke: updated"),
      consulStaleBlocked,
      consulDeleted,
      snapshotId: snapshot.id,
      snapshotCount: snapshots.length,
      strictValid: strictValidation.valid,
      invalidCode: invalidValidation.code,
    };
  }, smoke);

  expect(result.listed).toBeGreaterThan(0);
  expect(result.devContent).toContain("feature: true");
  expect(result.sandboxContent).toBe(result.devContent);
  expect(result.directWriteBlocked).toBe(true);
  expect(result.apolloDirectWriteBlocked).toBe(true);
  expect(result.apolloPublished).toBe(true);
  expect(result.apolloDeleted).toBe(true);
  expect(result.consulDirectWriteBlocked).toBe(true);
  expect(result.consulCreated).toBe(true);
  expect(result.consulUpdated).toBe(true);
  expect(result.consulStaleBlocked).toBe(true);
  expect(result.consulDeleted).toBe(true);
  expect(result.snapshotId).toContain("snap_");
  expect(result.snapshotCount).toBeGreaterThan(0);
  expect(result.strictValid).toBe(true);
  expect(result.invalidCode).toBe("missing_configs");

  pass(smoke, "FS-BIND-01", "Backend bindings", "ConfigCenter list/get used real Docker Nacos through Playwright bridge");
  pass(smoke, "FS-APPLY-01", "ApplyPlan", "Direct writes blocked and ApplyPlan binding wrote sandbox Nacos");
  pass(smoke, "FS-APOLLO-APPLY-BINDING-01", "Apollo provider", "ApplyPlan binding wrote and deleted an Apollo item through Docker OpenAPI fixture");
  pass(smoke, "FS-CONSUL-APPLY-BINDING-01", "Consul provider", "ApplyPlan binding created, updated, CAS-blocked, and deleted a Consul KV through Docker Consul");
  pass(smoke, "FS-BACKUP-01", "Backup", "CreateSnapshot/ListSnapshots used temporary smoke home");
  pass(smoke, "FS-CONN-02", "Connection Manager", "Strict and invalid local snapshot validations returned expected states");
});
