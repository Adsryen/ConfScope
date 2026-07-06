import { expect, pass, test } from "./smokeTest";

test("browses seeded Nacos configs and opens backup/task/about pages", async ({ page, smoke }) => {
  await page.goto("/");
  await expect(page.getByText("smoke-app.yaml")).toBeVisible({ timeout: 30_000 });
  await page.getByText("smoke-app.yaml").click();
  await expect(page.locator(".workspace")).toContainText("feature: true", { timeout: 15_000 });

  await page.getByRole("button", { name: "Backups" }).click();
  await expect(page.locator(".workspace")).toContainText("Backups");

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator(".workspace")).toContainText("Tasks");

  await page.getByRole("button", { name: "About" }).click();
  await expect(page.locator(".workspace")).toContainText("ConfScope");

  pass(smoke, "FS-BROWSE-01", "Browse", "Config Browser listed and opened smoke-app.yaml from real Nacos");
  pass(smoke, "FS-BACKUP-UI-01", "Backup", "Backup page loaded through smoke app shell");
  pass(smoke, "FS-TASK-UI-01", "Task Center", "Task Center page loaded through smoke app shell");
  pass(smoke, "FS-ABOUT-01", "About", "About page loaded and app info binding responded");
});
