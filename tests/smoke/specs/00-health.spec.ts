import { expect, pass, test } from "./smokeTest";

test("loads the shell and every main navigation page through the smoke bridge", async ({ page, smoke }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Config Browser" })).toBeVisible();

  const expectedTextByPage = new Map([
    ["Config Compare", "Config"],
    ["Config Matrix", "Run Audit"],
    ["Operation History", "Operation"],
    ["Backups", "Backups"],
    ["Tasks", "Tasks"],
    ["Connections", "Connections"],
    ["SSH Tunnels", "SSH"],
    ["Settings", "Settings"],
    ["About", "ConfScope"],
  ]);

  for (const [name, expectedText] of expectedTextByPage) {
    await page.getByRole("button", { name }).click();
    await expect(page.locator(".workspace")).toContainText(expectedText, { timeout: 15_000 });
  }

  pass(smoke, "FS-APP-01", "App shell", "Playwright loaded shell with injected Wails bridge");
  pass(smoke, "FS-APP-02", "App shell", "All main navigation pages opened without runtime crash");
});
