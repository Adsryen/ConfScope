import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, pass, test } from "./smokeTest";

test("backs up and restores app data locally and through WebDAV", async ({ page, smoke }) => {
  const password = "smoke-backup-pass";
  await page.goto("/");
  await expect(page.getByText("smoke-app.yaml")).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => {
    const connections = JSON.parse(localStorage.getItem("cs.connections") || "[]") as Array<Record<string, unknown>>;
    connections.push({
      id: "smoke-migrated-conn",
      name: "Migrated Secret Connection",
      projectName: "Smoke Project",
      environmentName: "Development",
      sourceName: "Migrated Secret Connection",
      sourceType: "nacos",
      provider: "nacos",
      distribution: "opensource",
      authType: "nacos-password",
      baseUrl: "http://127.0.0.1:18858/nacos",
      username: "migrated",
      password: "local-secret-for-backup",
      defaultNamespace: "",
      useProxy: false,
    });
    localStorage.setItem("cs.connections", JSON.stringify(connections));
  });

  await openSettingsBackupPanel(page);
  await page.getByLabel("Local backup password", { exact: true }).fill(password);
  await page.getByLabel("Confirm local backup password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Export encrypted file" }).click();
  await expect(page.locator(".test-msg").filter({ hasText: "Local backup exported" })).toBeVisible({ timeout: 15_000 });

  const localBackups = readdirSync(smoke.appBackupsDir).filter((name) => name.endsWith(".csbackup"));
  expect(localBackups.length).toBeGreaterThan(0);
  const packageText = readFileSync(`${smoke.appBackupsDir}/${localBackups[0]}`, "utf8");
  expect(packageText).not.toContain("local-secret-for-backup");
  expect(packageText).not.toContain("Migrated Secret Connection");
  pass(smoke, "FS-APPDATA-LOCAL-EXPORT-01", "App Data Backup", "Settings exported encrypted app data backup to .tmp app-backups");

  await page.evaluate(() => localStorage.setItem("cs.connections", "[]"));
  await page.getByRole("button", { name: "Choose local backup" }).click();
  await page.getByLabel("Restore password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Preview local backup" }).click();
  await expect(page.getByText("Connections: 6")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Restore this backup" }).click();
  await expect.poll(() => readStorage(page, "cs.connections")).toContain("smoke-migrated-conn");
  const recoveryPointsAfterLocal = await recoveryPointSuccessCount(page);
  expect(recoveryPointsAfterLocal).toBeGreaterThan(0);
  pass(smoke, "FS-APPDATA-LOCAL-RESTORE-01", "App Data Backup", "Local encrypted backup preview restored app data after recovery point creation");

  await openSettingsBackupPanel(page);
  await page.getByLabel("WebDAV URL", { exact: true }).fill(smoke.webdav.baseUrl);
  await page.getByLabel("WebDAV username", { exact: true }).fill(smoke.webdav.username);
  await page.getByLabel("WebDAV password", { exact: true }).fill(smoke.webdav.password);
  await page.getByLabel("Remote folder", { exact: true }).fill(smoke.webdav.rootPath);
  await page.getByRole("button", { name: "Save WebDAV target" }).click();
  await page.getByRole("button", { name: "Test WebDAV" }).click();
  await expect(page.locator(".test-msg").filter({ hasText: "WebDAV connection passed" })).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("WebDAV backup password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Upload current data" }).click();
  await expect(page.locator(".test-msg").filter({ hasText: "WebDAV backup uploaded" })).toBeVisible({ timeout: 20_000 });
  expect(existsSync(smoke.webdavDir)).toBe(true);
  expect(hasBackupPackage(smoke.webdavDir)).toBe(true);
  pass(smoke, "FS-APPDATA-WEBDAV-UPLOAD-01", "App Data Backup", "Uploaded encrypted app data backup to Docker WebDAV storage");

  await page.getByRole("button", { name: "Refresh remote list" }).click();
  await expect(page.locator(".app-data-backup-remote-row strong").filter({ hasText: /confscope-app-data-.*\.csbackup/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => localStorage.setItem("cs.connections", "[]"));
  await page.getByLabel("Remote restore password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /Preview confscope-app-data-.*\.csbackup/ }).click();
  await expect(page.getByText("Connections: 6")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Restore this backup" }).click();
  await expect.poll(() => readStorage(page, "cs.connections")).toContain("smoke-migrated-conn");
  pass(smoke, "FS-APPDATA-WEBDAV-RESTORE-01", "App Data Backup", "Downloaded WebDAV app data backup and restored app data through Settings UI");
});

async function openSettingsBackupPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "App Data Backup" })).toBeVisible({ timeout: 15_000 });
}

async function readStorage(page: Page, key: string): Promise<string> {
  try {
    return await page.evaluate((storageKey) => localStorage.getItem(storageKey) || "", key);
  } catch {
    return "";
  }
}

async function recoveryPointSuccessCount(page: Page): Promise<number> {
  const readCount = async () => {
    try {
      return await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("cs.appDataBackup") || "{}") as {
          activities?: Array<{ type?: string; status?: string }>;
        };
        return state.activities?.filter((item) => item.type === "recovery_point" && item.status === "success").length ?? 0;
      });
    } catch {
      return 0;
    }
  };
  await expect.poll(readCount).toBeGreaterThan(0);
  return readCount();
}

function hasBackupPackage(rootDir: string): boolean {
  if (!existsSync(rootDir)) return false;
  for (const entry of readdirSync(rootDir)) {
    const path = join(rootDir, entry);
    const stat = statSync(path);
    if (stat.isFile() && entry.endsWith(".csbackup")) return true;
    if (stat.isDirectory() && hasBackupPackage(path)) return true;
  }
  return false;
}
