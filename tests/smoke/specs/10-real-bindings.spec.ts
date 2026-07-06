import { expect, pass, test } from "./smokeTest";

test("uses Wails bridge bindings against real Docker Nacos and local snapshots", async ({ page, smoke }) => {
  await page.goto("/");

  const result = await page.evaluate(async (fixtures) => {
    const app = window.go.main.App;
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
    const snapshots = await app.ListSnapshots();
    const strictValidation = await app.ValidateLocalSnapshotDirectory(fixtures.strictPublic);
    const invalidValidation = await app.ValidateLocalSnapshotDirectory(fixtures.invalidEmpty);
    return {
      listed: pageResult.pageItems.length,
      devContent: devDoc.content,
      sandboxContent: sandboxDoc.content,
      directWriteBlocked,
      snapshotId: snapshot.id,
      snapshotCount: snapshots.length,
      strictValid: strictValidation.valid,
      invalidCode: invalidValidation.code,
    };
  }, smoke.fixtures);

  expect(result.listed).toBeGreaterThan(0);
  expect(result.devContent).toContain("feature: true");
  expect(result.sandboxContent).toBe(result.devContent);
  expect(result.directWriteBlocked).toBe(true);
  expect(result.snapshotId).toContain("snap_");
  expect(result.snapshotCount).toBeGreaterThan(0);
  expect(result.strictValid).toBe(true);
  expect(result.invalidCode).toBe("missing_configs");

  pass(smoke, "FS-BIND-01", "Backend bindings", "ConfigCenter list/get used real Docker Nacos through Playwright bridge");
  pass(smoke, "FS-APPLY-01", "ApplyPlan", "Direct writes blocked and ApplyPlan binding wrote sandbox Nacos");
  pass(smoke, "FS-BACKUP-01", "Backup", "CreateSnapshot/ListSnapshots used temporary smoke home");
  pass(smoke, "FS-CONN-02", "Connection Manager", "Strict and invalid local snapshot validations returned expected states");
});
