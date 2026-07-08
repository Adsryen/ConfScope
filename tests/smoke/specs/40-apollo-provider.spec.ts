import type { Locator } from "@playwright/test";
import { downloadAuditJSON } from "./auditExport";
import { expect, pass, test } from "./smokeTest";

test("creates and reads an Apollo OpenAPI connection through the UI", async ({ page, smoke }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Add Source" }).click();
  await page.getByRole("combobox", { name: /Project/ }).selectOption("Smoke Project");
  await page.getByRole("combobox", { name: "Config Center" }).selectOption("apollo");
  await page.getByLabel("Source Name").fill("Apollo OpenAPI");
  await page.getByLabel("Target Address").fill(smoke.apollo.baseUrl);
  await page.getByLabel("Apollo Token").fill(smoke.apollo.token);
  await page.getByLabel("Apollo Env").fill(smoke.apollo.env);
  await page.getByLabel("Apollo App ID").fill(smoke.apollo.appId);
  await page.getByLabel("Apollo Cluster").fill(smoke.apollo.cluster);
  await page.getByLabel("Apollo Namespace").fill(smoke.apollo.namespaceName);

  await page.getByRole("button", { name: "Test Connection" }).click();
  await expect(page.getByText("Connection test succeeded")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.locator(".conn-item").filter({ hasText: "Apollo OpenAPI" })).toBeVisible();

  await page.getByRole("button", { name: "Config Browser" }).click();
  await pickSelect(page.locator(".browse-header .page-actions"), 0, "Apollo OpenAPI");
  await expect(page.locator(".browser-item").filter({ hasText: smoke.apollo.namespaceName })).toBeVisible({ timeout: 30_000 });
  await page.locator(".browser-item").filter({ hasText: smoke.apollo.namespaceName }).click();
  await expect(page.locator(".browser-detail")).toContainText("feature.enabled=true", { timeout: 20_000 });

  await page.getByRole("button", { name: "Config Compare" }).click();
  await pickApolloDiffSource(page.locator(".source-picker").nth(0), smoke.apollo.namespaceName);
  await pickApolloDiffSource(page.locator(".source-picker").nth(1), smoke.apollo.namespaceName);
  await page.getByRole("button", { name: "Load & Compare" }).click();
  await expect(page.locator(".diff-result")).toContainText("feature.enabled=true", { timeout: 30_000 });
  await expect(page.locator(".diff-result")).toContainText("Both sides are identical", { timeout: 30_000 });

  await page.getByRole("button", { name: "Config Matrix" }).click();
  await page.getByRole("button", { name: "Run Audit" }).click();
  await expect(page.locator(".audit-matrix")).toContainText(smoke.apollo.namespaceName, { timeout: 30_000 });
  await expect(page.locator(".audit-matrix")).toContainText("server.port", { timeout: 30_000 });
  const auditJson = await downloadAuditJSON(page);
  expect(auditJson.metadata).toMatchObject({ schemaVersion: 2, sanitized: true });
  expect(auditJson.sources.some((source) => source.provider === "apollo" && source.connectionName === "Apollo OpenAPI")).toBe(true);
  expect(auditJson.rows.some((row) => row.providerType === "apollo" && row.dataId === smoke.apollo.namespaceName)).toBe(true);
  expect(JSON.stringify(auditJson)).not.toContain(smoke.apollo.token);

  await page.getByRole("button", { name: "Config Compare" }).click();
  await pickLocalDiffSource(page.locator(".source-picker").nth(0), `${smoke.apollo.namespaceName}.properties`);
  await pickApolloDiffSource(page.locator(".source-picker").nth(1), smoke.apollo.namespaceName);
  await page.getByRole("button", { name: "Load & Compare" }).click();
  await expect(page.locator(".diff-result")).toContainText("feature.enabled", { timeout: 30_000 });
  await expect(page.locator(".diff-result")).toContainText("false", { timeout: 30_000 });
  await page.getByRole("button", { name: "Generate Apply Plan" }).click();
  await expect(page.getByRole("heading", { name: "Apply Plan" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-count-strip")).toContainText("Overwrite 1", { timeout: 30_000 });
  await page.getByLabel("I reviewed this dry-run plan and understand it will write to the target.").check();
  await page.getByRole("button", { name: "Execute apply" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async (apollo) => {
          const profile = {
            id: "smoke-apollo",
            name: "Apollo OpenAPI",
            provider: "apollo",
            baseUrl: apollo.baseUrl,
            accessToken: apollo.token,
            apolloEnv: apollo.env,
            apolloAppId: apollo.appId,
            apolloCluster: apollo.cluster,
            apolloNamespaceName: apollo.namespaceName,
          };
          const doc = await window.go.main.App.ConfigCenterGetConfig(profile, {
            provider: "apollo",
            connectionId: "smoke-apollo",
            namespace: apollo.appId,
            group: apollo.cluster,
            dataId: apollo.namespaceName,
            key: "",
          });
          return String((doc as { content?: string }).content ?? "");
        }, smoke.apollo),
      { timeout: 30_000 }
    )
    .toContain("feature.enabled=false");

  await page.getByRole("button", { name: "Config Browser" }).click();
  await pickSelect(page.locator(".browse-header .page-actions"), 0, "Apollo OpenAPI");
  await page.locator(".browser-item").filter({ hasText: smoke.apollo.namespaceName }).click();
  await expect(page.locator(".browser-detail")).toContainText("feature.enabled=false", { timeout: 20_000 });

  pass(smoke, "FS-APOLLO-CONN-01", "Apollo provider", "Created Apollo OpenAPI connection through Connection Manager form and tested it");
  pass(smoke, "FS-APOLLO-BROWSE-01", "Apollo provider", "Browsed and opened Apollo namespace content from Docker OpenAPI fixture");
  pass(smoke, "FS-APOLLO-DIFF-01", "Apollo provider", "Compared Apollo namespace through Config Compare");
  pass(smoke, "FS-APOLLO-AUDIT-01", "Apollo provider", "Included Apollo namespace in Config Matrix audit");
  pass(smoke, "FS-APOLLO-AUDIT-EXPORT-01", "Apollo provider", "Exported Apollo audit JSON through the visible Config Matrix UI with provider/source metadata");
  pass(smoke, "FS-APOLLO-APPLY-01", "Apollo provider", "Generated and executed an ApplyPlan from local snapshot to Docker Apollo, then read back the released item");
});

async function pickLocalDiffSource(sourcePicker: Locator, dataId: string): Promise<void> {
  await pickSelect(sourcePicker, 0, "Local");
  await pickSelect(sourcePicker, 1, "Strict Snapshot");
  await pickCombobox(sourcePicker.locator(".combo").nth(0), dataId);
}

async function pickApolloDiffSource(sourcePicker: Locator, namespaceName: string): Promise<void> {
  await pickSelect(sourcePicker, 1, "Apollo OpenAPI");
  await pickCombobox(sourcePicker.locator(".combo").nth(0), namespaceName);
}

async function pickSelect(scope: Locator, index: number, optionText: string): Promise<void> {
  const select = scope.locator(".sel").nth(index);
  await select.getByRole("button").click();
  await select.locator(".sel-option").filter({ hasText: optionText }).first().click();
}

async function pickCombobox(combo: Locator, optionText: string): Promise<void> {
  await combo.locator("input").click();
  const option = combo.locator(".combo-option").filter({ hasText: optionText }).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.click();
}
