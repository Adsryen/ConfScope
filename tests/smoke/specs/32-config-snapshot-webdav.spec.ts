import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, pass, test } from "./smokeTest";

test("syncs config-center snapshots through Docker WebDAV", async ({ page, smoke }) => {
  const password = "smoke-snapshot-pass";
  await page.goto("/");
  await expect(page.getByText("smoke-app.yaml")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Create current list snapshot" }).click();
  await expect(page.getByText(/Snapshot created:/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Backups" }).click();
  await expect(page.getByText("Snapshot WebDAV")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("WebDAV URL", { exact: true }).fill(smoke.webdav.baseUrl);
  await page.getByLabel("WebDAV username", { exact: true }).fill(smoke.webdav.username);
  await page.getByLabel("WebDAV password", { exact: true }).fill(smoke.webdav.password);
  await page.getByLabel("Remote folder", { exact: true }).fill("/confscope/snapshots");
  await page.getByLabel("Snapshot package password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Save WebDAV target" }).click();
  await page.getByRole("button", { name: "Test WebDAV" }).click();
  await expect(page.locator(".backup-webdav-status").filter({ hasText: "WebDAV connection passed" })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Upload selected snapshot" }).click();
  await expect(page.locator(".backup-webdav-status").filter({ hasText: "Snapshot package uploaded" })).toBeVisible({ timeout: 20_000 });
  const packagePath = findPackage(smoke.webdavDir, ".cssnapshot");
  expect(packagePath).not.toBeNull();
  const packageText = readFileSync(packagePath as string, "utf8");
  expect(packageText).toContain("confscope.config-snapshot");
  expect(packageText).not.toContain("feature: true");
  pass(smoke, "FS-SNAPSHOT-WEBDAV-UPLOAD-01", "Config Snapshot WebDAV", "Uploaded encrypted .cssnapshot to Docker WebDAV");

  await page.getByRole("button", { name: "Refresh remote snapshots" }).click();
  await expect(page.locator(".backup-remote-item").filter({ hasText: /\.cssnapshot/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".backup-remote-item").filter({ hasText: ".csbackup" })).toHaveCount(0);
  pass(smoke, "FS-SNAPSHOT-WEBDAV-LIST-01", "Config Snapshot WebDAV", "Remote list showed only config snapshot packages");

  await page.getByRole("button", { name: /Import .*\.cssnapshot/ }).first().click();
  await expect(page.locator(".backup-webdav-status").filter({ hasText: "Snapshot imported" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".backup-detail")).toContainText("smoke-app.yaml", { timeout: 20_000 });
  pass(smoke, "FS-SNAPSHOT-WEBDAV-IMPORT-01", "Config Snapshot WebDAV", "Downloaded WebDAV package and imported it as a local snapshot");

  await page.getByRole("button", { name: "Compare with cloud" }).first().click();
  await expect(page.locator(".diff-result")).toContainText("Both sides are identical", { timeout: 30_000 });
  pass(smoke, "FS-SNAPSHOT-WEBDAV-DIFF-01", "Config Snapshot WebDAV", "Imported snapshot participated in local-vs-cloud DiffView compare");
});

function findPackage(rootDir: string, extension: string): string | null {
  if (!existsSync(rootDir)) return null;
  for (const entry of readdirSync(rootDir)) {
    const path = join(rootDir, entry);
    const stat = statSync(path);
    if (stat.isFile() && entry.endsWith(extension)) return path;
    if (stat.isDirectory()) {
      const nested = findPackage(path, extension);
      if (nested) return nested;
    }
  }
  return null;
}
