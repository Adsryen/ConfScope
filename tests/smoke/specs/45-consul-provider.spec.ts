import type { Locator } from "@playwright/test";
import { downloadAuditCSV } from "./auditExport";
import { expect, pass, test } from "./smokeTest";

test("creates and reads a Consul KV connection through the UI", async ({ page, smoke }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Add Source" }).click();
  await page.getByRole("combobox", { name: /Project/ }).selectOption("Smoke Project");
  await page.getByRole("combobox", { name: "Config Center" }).selectOption("consul");
  await page.getByLabel("Source Name").fill("Consul KV");
  await page.getByLabel("Target Address").fill(smoke.consul.baseUrl);
  await page.getByLabel("Consul Datacenter").fill(smoke.consul.datacenter);
  await page.getByLabel("Consul Key Prefix").fill(smoke.consul.keyPrefix);

  await page.getByRole("button", { name: "Test Connection" }).click();
  await expect(page.getByText("Connection test succeeded")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.locator(".conn-item").filter({ hasText: "Consul KV" })).toBeVisible();

  await page.getByRole("button", { name: "Config Browser" }).click();
  await pickSelect(page.locator(".browse-header .page-actions"), 0, "Consul KV");
  await expect(page.locator(".browser-item").filter({ hasText: "apps/order/app.yaml" })).toBeVisible({ timeout: 30_000 });
  await page.locator(".browser-item").filter({ hasText: "apps/order/app.yaml" }).click();
  await expect(page.locator(".browser-detail")).toContainText("feature: true", { timeout: 20_000 });

  await page.getByRole("button", { name: "Config Compare" }).click();
  await pickConsulDiffSource(page.locator(".source-picker").nth(0), "apps/order/app.yaml");
  await pickConsulDiffSource(page.locator(".source-picker").nth(1), "apps/order/app.yaml");
  await page.getByRole("button", { name: "Load & Compare" }).click();
  await expect(page.locator(".diff-result")).toContainText("feature: true", { timeout: 30_000 });
  await expect(page.locator(".diff-result")).toContainText("Both sides are identical", { timeout: 30_000 });

  await page.getByRole("button", { name: "Config Matrix" }).click();
  await page.getByRole("button", { name: "Run Audit" }).click();
  await expect(page.locator(".audit-matrix")).toContainText("apps/order/app.yaml", { timeout: 30_000 });
  await expect(page.locator(".audit-matrix")).toContainText("feature", { timeout: 30_000 });
  const auditCsv = await downloadAuditCSV(page);
  expect(auditCsv).toContain("providerType,namespace,group,dataId,key,status");
  expect(auditCsv).toContain("consul");
  expect(auditCsv).toContain("apps/order/app.yaml");
  expect(auditCsv).toContain("feature");
  expect(auditCsv).toContain("db.password");
  expect(auditCsv).toContain("***");
  expect(auditCsv).not.toContain("consul-secret");
  expect(auditCsv).not.toContain(smoke.consul.baseUrl);

  await page.getByRole("button", { name: "Config Compare" }).click();
  await pickLocalDiffSource(page.locator(".source-picker").nth(0), "smoke-app.yaml");
  await pickConsulDiffSource(page.locator(".source-picker").nth(1), "apps/order/app.yaml");
  await page.getByRole("button", { name: "Load & Compare" }).click();
  await expect(page.locator(".diff-result")).toContainText("snapshot", { timeout: 30_000 });
  await page.getByRole("button", { name: "Generate Apply Plan" }).click();
  await expect(page.getByRole("heading", { name: "Apply Plan" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-count-strip")).toContainText("Overwrite", { timeout: 30_000 });
  await page.getByLabel("I reviewed this dry-run plan and understand it will write to the target.").check();
  await page.getByRole("button", { name: "Execute apply" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async (consul) => {
          const profile = {
            id: "smoke-consul",
            name: "Consul KV",
            provider: "consul",
            baseUrl: consul.baseUrl,
            accessToken: "",
            consulDatacenter: consul.datacenter,
            consulKeyPrefix: consul.keyPrefix,
          };
          const doc = await window.go.app.App.ConfigCenterGetConfig(profile, {
            provider: "consul",
            connectionId: "smoke-consul",
            namespace: consul.datacenter,
            group: consul.keyPrefix,
            dataId: "apps/order/app.yaml",
            key: "",
          });
          return String((doc as { content?: string }).content ?? "");
        }, smoke.consul),
      { timeout: 30_000 }
    )
    .toContain("feature: snapshot");

  await page.getByRole("button", { name: "Config Browser" }).click();
  await pickSelect(page.locator(".browse-header .page-actions"), 0, "Consul KV");
  await page.locator(".browser-item").filter({ hasText: "apps/order/app.yaml" }).click();
  await expect(page.locator(".browser-detail")).toContainText("feature: snapshot", { timeout: 20_000 });

  pass(smoke, "FS-CONSUL-CONN-01", "Consul provider", "Created Consul KV connection through Connection Manager form and tested it");
  pass(smoke, "FS-CONSUL-BROWSE-01", "Consul provider", "Browsed and opened Consul KV content from Docker Consul");
  pass(smoke, "FS-CONSUL-DIFF-01", "Consul provider", "Compared Consul KV document through Config Compare");
  pass(smoke, "FS-CONSUL-AUDIT-01", "Consul provider", "Included Consul KV document in Config Matrix audit");
  pass(smoke, "FS-CONSUL-AUDIT-EXPORT-01", "Consul provider", "Exported Consul audit CSV through the visible Config Matrix UI with provider/source metadata and masked secrets");
  pass(smoke, "FS-CONSUL-APPLY-01", "Consul provider", "Generated and executed an ApplyPlan from local snapshot to Docker Consul, then read back the CAS-protected KV");
});

async function pickLocalDiffSource(sourcePicker: Locator, dataId: string): Promise<void> {
  await pickSelect(sourcePicker, 0, "Local");
  await pickSelect(sourcePicker, 1, "Strict Snapshot");
  await pickCombobox(sourcePicker.locator(".combo").nth(0), dataId);
}

async function pickConsulDiffSource(sourcePicker: Locator, dataId: string): Promise<void> {
  await pickSelect(sourcePicker, 1, "Consul KV");
  await pickCombobox(sourcePicker.locator(".combo").nth(0), dataId);
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
