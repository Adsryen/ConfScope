import type { Locator } from "@playwright/test";
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

  pass(smoke, "FS-APOLLO-CONN-01", "Apollo provider", "Created Apollo OpenAPI connection through Connection Manager form and tested it");
  pass(smoke, "FS-APOLLO-BROWSE-01", "Apollo provider", "Browsed and opened Apollo namespace content from Docker OpenAPI fixture");
  pass(smoke, "FS-APOLLO-DIFF-01", "Apollo provider", "Compared Apollo namespace through Config Compare");
  pass(smoke, "FS-APOLLO-AUDIT-01", "Apollo provider", "Included Apollo namespace in Config Matrix audit");
});

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
