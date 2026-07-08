import { expect, pass, test } from "./smokeTest";

test("replays local operation history records created by smoke UI workflows", async ({ page, smoke }) => {
  await page.goto("/");
  await expect(page.getByText("smoke-app.yaml")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Create current list snapshot" }).click();
  await expect(page.getByText(/Snapshot created:/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Operation History" }).click();
  const historyItem = page.locator(".history-item").filter({ hasText: "Create snapshot" }).first();
  await expect(historyItem).toBeVisible({ timeout: 15_000 });
  await expect(historyItem).toContainText("Success");
  await expect(historyItem).toContainText("Dev Nacos");
  await expect(historyItem).toContainText("public/*");

  await page.locator(".history-filter-select").nth(1).selectOption("snapshot");
  await expect(page.locator(".history-item")).toHaveCount(1);
  await historyItem.click();

  await expect(page.locator(".history-detail-panel")).toContainText("Operation type:");
  await expect(page.locator(".history-detail-panel")).toContainText("Create snapshot");
  await expect(page.locator(".history-detail-panel")).toContainText("Snapshot operations only create or delete local backups");
  await expect(page.getByRole("button", { name: "Copy Record" })).toBeVisible();

  pass(smoke, "FS-HISTORY-DATA-01", "Operation History", "Operation History replayed a UI-created snapshot record with detail fields");
});
