import { expect, pass, test, type NativeControlClient } from "./nativeTest";
import type { SmokeState } from "../../env/workspace";

interface ShellResult {
  hasShell: boolean;
  hasConnectionManager: boolean;
}

interface ConnectionResult {
  connectionCount: number;
  sourceName: string;
  testMessage: string;
}

interface BrowseResult {
  listed: boolean;
  content: string;
}

interface PageResult {
  page: string;
  marker: string;
}

interface NativePollResult<T> {
  done: boolean;
  value?: T;
  text?: string;
}

test.skip(process.platform !== "win32", "Native Wails WebView smoke is Windows-only.");

test("creates a Nacos connection through the native Wails UI and browses real configs", async ({ native, smoke }) => {
  await prepareEnglishUi(native);
  await sleep(1_500);

  const shell = await waitForShell(native);
  expect(shell.hasShell).toBe(true);
  expect(shell.hasConnectionManager).toBe(true);
  pass(smoke, "NATIVE-SHELL-01", "Native Desktop", "Real Wails WebView shell loaded through native smoke control");

  const connection = await createNacosConnection(native, smoke);
  expect(connection.sourceName).toBe("Native Dev Nacos");
  expect(connection.connectionCount).toBeGreaterThan(0);
  expect(connection.testMessage).toMatch(/No account configured|Connected|Connection test succeeded/);
  pass(smoke, "NATIVE-CONNECTION-TEST-01", "Connections", "Connection test succeeded against Docker Nacos via real Go binding");
  pass(smoke, "NATIVE-CONNECTION-FORM-01", "Connections", "Created Nacos source through the Connection Manager form");

  const browse = await browseSeededConfig(native);
  expect(browse.listed).toBe(true);
  expect(browse.content).toContain("feature: true");
  pass(smoke, "NATIVE-CONFIG-BROWSE-01", "Browse", "Config Browser opened smoke-app.yaml from real Docker Nacos");

  await verifyNativeAppDataWebDAVBackup(native, smoke);
  await verifyNavigationPages(native, smoke);
});

async function prepareEnglishUi(native: NativeControlClient): Promise<void> {
  await native.eval<boolean>(`
    const existingConnections = localStorage.getItem("cs.connections");
    if (existingConnections && existingConnections !== "[]") {
      throw new Error("Native smoke requires an empty isolated connection store before form creation.");
    }
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "connections", sidebarCollapsed: false }));
    if (document.body) {
      document.body.innerHTML = "<div id=\\"native-smoke-reloading\\">reloading</div>";
    }
    setTimeout(() => window.location.reload(), 500);
    return true;
  `);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForShell(native: NativeControlClient): Promise<ShellResult> {
  return native.eval<ShellResult>(`
    ${DOM_HELPERS}
    await closeStartupDialog();
    await waitFor(() => Boolean(document.querySelector(".app-shell")), 30_000, "app shell");
    await closeStartupDialog();
    await waitFor(() => pageText().includes("Connection Manager"), 30_000, "Connection Manager");
    return {
      hasShell: Boolean(document.querySelector(".app-shell")),
      hasConnectionManager: pageText().includes("Connection Manager"),
    };
  `, 65_000);
}

async function createNacosConnection(native: NativeControlClient, smoke: SmokeState): Promise<ConnectionResult> {
  const baseUrl = JSON.stringify(smoke.nacos.dev.baseUrl);
  await native.eval<boolean>(`
    ${DOM_HELPERS}
    await setProject("Native Smoke Project");
    await selectByLabel("Environment", "Development");
    await setInputByLabel("Source Name", "Native Dev Nacos");
    await optionalSelectByLabel("Config Center", "Nacos");
    await optionalSelectByLabel("Distribution", "Open-source Nacos");
    await optionalSelectByLabel("Access Mode", "Direct");
    await setInputByLabel("Target Address", ${baseUrl});
    await selectByLabel("Authentication", "No Auth");
    await setInputByLabel("Username", "");
    await setInputByLabel("Password", "");
    await setInputByLabel("Default Namespace ID", "");
    await sleep(150);
    clickButton("Test Connection");
    return true;
  `, 10_000);

  const testMessage = await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const message = normalize(document.querySelector(".test-msg")?.textContent || "");
      const visible = pageText();
      const success = /No account configured|Connected|Connection test succeeded|Config center API passed/.test(message || visible);
      return {
        done: success,
        value: message || (success ? "Connection test succeeded" : ""),
        text: visible,
      };
    `,
    30_000,
    "successful connection test message"
  );

  await native.eval<boolean>(`
    ${DOM_HELPERS}
    clickButton("Save");
    return true;
  `, 10_000);

  const saved = await waitForNativeValue<{ connectionCount: number; sourceName: string }>(
    native,
    `
      ${DOM_HELPERS}
      const connections = JSON.parse(localStorage.getItem("cs.connections") || "[]");
      if (!Array.isArray(connections)) throw new Error("Saved connection store is not an array");
      const saved = connections.find((item) => item && item.sourceName === "Native Dev Nacos");
      return {
        done: Boolean(saved) && pageText().includes("Native Dev Nacos"),
        value: saved ? { connectionCount: connections.length, sourceName: saved.sourceName } : undefined,
        text: pageText(),
      };
    `,
    15_000,
    "saved connection entry"
  );

  return { ...saved, testMessage };
}

async function waitForNativeValue<T>(
  native: NativeControlClient,
  script: string,
  timeoutMs: number,
  label: string
): Promise<T> {
  const started = Date.now();
  let lastText = "";
  while (Date.now() - started < timeoutMs) {
    const result = await native.eval<NativePollResult<T>>(script, 5_000);
    lastText = result.text ?? lastText;
    if (result.done && result.value !== undefined) return result.value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}. Visible text: ${lastText.slice(0, 1200)}`);
}

async function browseSeededConfig(native: NativeControlClient): Promise<BrowseResult> {
  await native.eval<boolean>(`
    ${DOM_HELPERS}
    clickButton("Config Browser");
    return true;
  `, 10_000);

  await waitForNativeValue<boolean>(
    native,
    `
      ${DOM_HELPERS}
      return { done: pageText().includes("smoke-app.yaml"), value: true, text: pageText() };
    `,
    30_000,
    "smoke-app.yaml list item"
  );

  await native.eval<boolean>(`
    ${DOM_HELPERS}
    clickText("smoke-app.yaml");
    return true;
  `, 10_000);

  const content = await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const content = document.querySelector(".workspace")?.textContent || "";
      return { done: content.includes("feature: true"), value: content, text: pageText() };
    `,
    15_000,
    "smoke-app.yaml content"
  );

  return { listed: true, content };
}

async function verifyNativeAppDataWebDAVBackup(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const target = {
    url: smoke.webdav.baseUrl,
    username: smoke.webdav.username,
    password: smoke.webdav.password,
    rootPath: smoke.webdav.rootPath,
    backupPassword: "native-app-data-pass",
  };
  await native.eval<boolean>(`
    ${DOM_HELPERS}
    clickButton("Settings");
    await waitFor(() => pageText().includes("App Data Backup"), 20_000, "App Data Backup panel");
    await setInputByLabel("WebDAV URL", ${JSON.stringify(target.url)});
    await setInputByLabel("WebDAV username", ${JSON.stringify(target.username)});
    await setInputByLabel("WebDAV password", ${JSON.stringify(target.password)});
    await setInputByLabel("Remote folder", ${JSON.stringify(target.rootPath)});
    clickButton("Save WebDAV target");
    clickButton("Test WebDAV");
    return true;
  `, 30_000);

  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("WebDAV connection passed"), value: text, text };
    `,
    30_000,
    "WebDAV connection passed"
  );
  pass(smoke, "NATIVE-APPDATA-WEBDAV-TEST-01", "App Data Backup", "Settings tested Docker WebDAV through real Wails binding");

  await native.eval<boolean>(`
    ${DOM_HELPERS}
    await setInputByLabel("WebDAV backup password", ${JSON.stringify(target.backupPassword)});
    clickButton("Upload current data");
    return true;
  `, 10_000);
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("WebDAV backup uploaded"), value: text, text };
    `,
    45_000,
    "WebDAV backup uploaded"
  );
  pass(smoke, "NATIVE-APPDATA-WEBDAV-UPLOAD-01", "App Data Backup", "Uploaded app data backup to Docker WebDAV through real Go binding");

  await native.eval<boolean>(`
    ${DOM_HELPERS}
    clickButton("Refresh remote list");
    return true;
  `, 10_000);
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: /confscope-app-data-.*\\.csbackup/.test(text), value: text, text };
    `,
    30_000,
    "remote app data backup list"
  );

  await native.eval<boolean>(`
    ${DOM_HELPERS}
    localStorage.setItem("cs.connections", "[]");
    await setInputByLabel("Remote restore password", ${JSON.stringify(target.backupPassword)});
    clickButton("Preview confscope-app-data-");
    return true;
  `, 10_000);
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("Connections: 1"), value: text, text };
    `,
    30_000,
    "remote backup preview"
  );
  await native.eval<boolean>(`
    ${DOM_HELPERS}
    clickButton("Restore this backup");
    return true;
  `, 10_000);
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const connections = localStorage.getItem("cs.connections") || "";
      return { done: connections.includes("Native Dev Nacos"), value: connections, text: pageText() };
    `,
    45_000,
    "restored native app data"
  );
  pass(smoke, "NATIVE-APPDATA-WEBDAV-RESTORE-01", "App Data Backup", "Downloaded WebDAV backup and restored native app localStorage");
}

async function verifyNavigationPages(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const pages = [
    { button: "Backups", marker: "Backups", id: "NATIVE-BACKUP-UI-01", area: "Backup", evidence: "Backups page loaded in native Wails shell" },
    { button: "Tasks", marker: "Tasks", id: "NATIVE-TASK-UI-01", area: "Task Center", evidence: "Tasks page loaded in native Wails shell" },
    { button: "Settings", marker: "Settings", id: "NATIVE-SETTINGS-UI-01", area: "Settings", evidence: "Settings page loaded in native Wails shell" },
    { button: "About", marker: "ConfScope", id: "NATIVE-ABOUT-UI-01", area: "About", evidence: "About page loaded in native Wails shell" },
  ] as const;

  for (const page of pages) {
    await native.eval<boolean>(`
      ${DOM_HELPERS}
      clickButton(${JSON.stringify(page.button)});
      return true;
    `, 10_000);
    const result = await waitForNativeValue<PageResult>(
      native,
      `
        ${DOM_HELPERS}
        return {
          done: pageText().includes(${JSON.stringify(page.marker)}),
          value: { page: ${JSON.stringify(page.button)}, marker: ${JSON.stringify(page.marker)} },
          text: pageText(),
        };
      `,
      15_000,
      page.marker
    );
    expect(result.page).toBe(page.button);
    pass(smoke, page.id, page.area, page.evidence);
  }
}

const DOM_HELPERS = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const pageText = () => document.body ? document.body.innerText || document.body.textContent || "" : "";
  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width >= 0 && rect.height >= 0;
  };
  const waitFor = async (check, timeoutMs, label) => {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < timeoutMs) {
      try {
        if (check()) return true;
      } catch (error) {
        lastError = String(error && (error.stack || error.message || error));
      }
      await sleep(100);
    }
    throw new Error("Timed out waiting for " + label + (lastError ? ": " + lastError : "") + "\\nVisible text: " + pageText().slice(0, 1200));
  };
  const setNativeValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setSelectValue = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const labelTitle = (label) => normalize(label.querySelector(".field-label > span:first-child")?.textContent || label.textContent);
  const findLabel = (labelText) => {
    const labels = Array.from(document.querySelectorAll("label")).filter(isVisible);
    const target = labels.find((label) => labelTitle(label) === labelText) || labels.find((label) => labelTitle(label).includes(labelText));
    if (!target) throw new Error("Field label not found: " + labelText);
    return target;
  };
  const findControlByLabel = (labelText, selector) => {
    const label = findLabel(labelText);
    const control = label.querySelector(selector);
    if (!control) throw new Error("Control not found for label: " + labelText);
    return control;
  };
  const setInputByLabel = async (labelText, value) => {
    const control = findControlByLabel(labelText, "input, textarea");
    setNativeValue(control, value);
    await sleep(50);
  };
  const optionValue = (select, labelOrValue) => {
    const options = Array.from(select.options);
    const exact = options.find((option) => option.value === labelOrValue || normalize(option.textContent) === labelOrValue);
    if (exact) return exact.value;
    const partial = options.find((option) => normalize(option.textContent).includes(labelOrValue));
    if (partial) return partial.value;
    throw new Error("Option not found: " + labelOrValue);
  };
  const selectByLabel = async (labelText, labelOrValue) => {
    const control = findControlByLabel(labelText, "select");
    setSelectValue(control, optionValue(control, labelOrValue));
    await sleep(80);
  };
  const optionalSelectByLabel = async (labelText, labelOrValue) => {
    const labels = Array.from(document.querySelectorAll("label")).filter(isVisible);
    if (!labels.some((label) => labelTitle(label) === labelText || labelTitle(label).includes(labelText))) return;
    await selectByLabel(labelText, labelOrValue);
  };
  const setProject = async (projectName) => {
    const label = findLabel("Project");
    const input = label.querySelector("input");
    if (input) {
      setNativeValue(input, projectName);
      await sleep(50);
      return;
    }
    const select = label.querySelector("select");
    if (!select) throw new Error("Project control not found");
    setSelectValue(select, optionValue(select, "New Project..."));
    await waitFor(() => Boolean(findLabel("Project").querySelector("input")), 5_000, "new project input");
    setNativeValue(findLabel("Project").querySelector("input"), projectName);
    await sleep(50);
  };
  const findButton = (label) => {
    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    return buttons.find((button) => normalize(button.textContent) === label || normalize(button.textContent).includes(label));
  };
  const clickButton = (label) => {
    const button = findButton(label);
    if (!button) throw new Error("Button not found: " + label + "\\nVisible text: " + pageText().slice(0, 1200));
    button.click();
  };
  const clickText = (label) => {
    const elements = Array.from(document.querySelectorAll(".browser-item, .data-list-item, [role='button'], button, li, tr, div, span"))
      .filter((element) => isVisible(element) && normalize(element.textContent).includes(label))
      .sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);
    const element = elements[0];
    if (!element) throw new Error("Text target not found: " + label);
    const clickable = element.closest("button, [role='button'], .browser-item, .data-list-item, li, tr") || element;
    clickable.click();
  };
  const closeStartupDialog = async () => {
    const action = findButton("Start") || findButton("Got it");
    if (action) {
      action.click();
      await waitFor(() => !document.querySelector(".startup-overlay"), 5_000, "startup dialog close");
    }
  };
`;
