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

interface ProviderWorkflowResult {
  sourceName: string;
  testMessage: string;
  content: string;
  diffText: string;
  auditText: string;
}

interface PageResult {
  page: string;
  marker: string;
}

interface CredentialStorePoCResult {
  ok: boolean;
  targetName: string;
  readBackOk: boolean;
  deleted: boolean;
  valueSize: number;
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

  await verifyCredentialStorePoC(native, smoke);

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

  await verifyNativeApolloProvider(native, smoke);
  await verifyNativeConsulProvider(native, smoke);
  await verifyNativeSSHProfileAndTunnel(native, smoke);
  await verifyNativeAppDataWebDAVBackup(native, smoke);
  await verifyNativeConfigSnapshotWebDAV(native, smoke);
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

async function verifyCredentialStorePoC(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const result = await native.eval<CredentialStorePoCResult>(
    `
    const app = window.go && window.go.main && window.go.main.App;
    if (!app || typeof app.RunCredentialStorePoC !== "function") {
      throw new Error("RunCredentialStorePoC binding not found");
    }
    const result = await app.RunCredentialStorePoC("native-" + Date.now());
    if (JSON.stringify(result).includes("secret-")) {
      throw new Error("Credential store PoC result leaked secret material");
    }
    return result;
  `,
    30_000
  );

  expect(result.ok).toBe(true);
  expect(result.readBackOk).toBe(true);
  expect(result.deleted).toBe(true);
  expect(result.targetName.startsWith("ConfScope/poc/native-")).toBe(true);
  expect(result.valueSize).toBeGreaterThan(0);
  pass(smoke, "NATIVE-CREDENTIAL-STORE-POC-01", "Security", "Windows Credential Manager PoC wrote, read, and deleted a test credential");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForShell(native: NativeControlClient): Promise<ShellResult> {
  return native.eval<ShellResult>(
    `
    ${DOM_HELPERS}
    await closeStartupDialog();
    await waitFor(() => Boolean(document.querySelector(".app-shell")), 30_000, "app shell");
    await closeStartupDialog();
    await waitFor(() => pageText().includes("Connection Manager"), 30_000, "Connection Manager");
    return {
      hasShell: Boolean(document.querySelector(".app-shell")),
      hasConnectionManager: pageText().includes("Connection Manager"),
    };
  `,
    65_000
  );
}

async function createNacosConnection(native: NativeControlClient, smoke: SmokeState): Promise<ConnectionResult> {
  const baseUrl = JSON.stringify(smoke.nacos.dev.baseUrl);
  await native.eval<boolean>(
    `
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
  `,
    10_000
  );

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

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Save");
    return true;
  `,
    10_000
  );

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

async function waitForNativeValue<T>(native: NativeControlClient, script: string, timeoutMs: number, label: string): Promise<T> {
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
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Config Browser");
    return true;
  `,
    10_000
  );

  await waitForNativeValue<boolean>(
    native,
    `
      ${DOM_HELPERS}
      return { done: pageText().includes("smoke-app.yaml"), value: true, text: pageText() };
    `,
    30_000,
    "smoke-app.yaml list item"
  );

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickText("smoke-app.yaml");
    return true;
  `,
    10_000
  );

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

async function verifyNativeApolloProvider(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const sourceName = "Native Apollo OpenAPI";
  const result = await verifyNativeProviderWorkflow(native, {
    sourceName,
    providerLabel: "Apollo",
    baseUrl: smoke.apollo.baseUrl,
    fields: [
      ["Apollo Token", smoke.apollo.token],
      ["Apollo Env", smoke.apollo.env],
      ["Apollo App ID", smoke.apollo.appId],
      ["Apollo Cluster", smoke.apollo.cluster],
      ["Apollo Namespace", smoke.apollo.namespaceName],
    ],
    browseItem: smoke.apollo.namespaceName,
    contentNeedle: "feature.enabled=true",
    auditNeedle: "server.port",
  });

  expect(result.sourceName).toBe(sourceName);
  expect(result.testMessage).toMatch(/Connected|Connection test succeeded/);
  expect(result.content).toContain("feature.enabled=true");
  expect(result.diffText).toContain("Both sides are identical");
  expect(result.auditText).toContain("server.port");
  pass(smoke, "NATIVE-APOLLO-CONNECTION-FORM-01", "Apollo provider", "Created Apollo source through the native Connection Manager form");
  pass(smoke, "NATIVE-APOLLO-CONNECTION-TEST-01", "Apollo provider", "Native connection test reached Docker Apollo OpenAPI fixture");
  pass(smoke, "NATIVE-APOLLO-BROWSE-01", "Apollo provider", "Native Config Browser opened Apollo namespace content");
  pass(smoke, "NATIVE-APOLLO-DIFF-01", "Apollo provider", "Native Config Compare compared Apollo namespace content");
  pass(smoke, "NATIVE-APOLLO-AUDIT-01", "Apollo provider", "Native Config Matrix included Apollo provider content");
}

async function verifyNativeConsulProvider(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const sourceName = "Native Consul KV";
  const result = await verifyNativeProviderWorkflow(native, {
    sourceName,
    providerLabel: "Consul",
    baseUrl: smoke.consul.baseUrl,
    fields: [
      ["Consul Datacenter", smoke.consul.datacenter],
      ["Consul Key Prefix", smoke.consul.keyPrefix],
    ],
    browseItem: "apps/order/app.yaml",
    contentNeedle: "feature: true",
    auditNeedle: "apps/order/app.yaml",
  });

  expect(result.sourceName).toBe(sourceName);
  expect(result.testMessage).toMatch(/Connected|Connection test succeeded/);
  expect(result.content).toContain("feature: true");
  expect(result.diffText).toContain("Both sides are identical");
  expect(result.auditText).toContain("apps/order/app.yaml");
  pass(smoke, "NATIVE-CONSUL-CONNECTION-FORM-01", "Consul provider", "Created Consul source through the native Connection Manager form");
  pass(smoke, "NATIVE-CONSUL-CONNECTION-TEST-01", "Consul provider", "Native connection test reached Docker Consul KV");
  pass(smoke, "NATIVE-CONSUL-BROWSE-01", "Consul provider", "Native Config Browser opened Consul KV content");
  pass(smoke, "NATIVE-CONSUL-DIFF-01", "Consul provider", "Native Config Compare compared Consul KV content");
  pass(smoke, "NATIVE-CONSUL-AUDIT-01", "Consul provider", "Native Config Matrix included Consul provider content");
}

async function verifyNativeProviderWorkflow(
  native: NativeControlClient,
  options: {
    sourceName: string;
    providerLabel: string;
    baseUrl: string;
    fields: Array<[string, string]>;
    browseItem: string;
    contentNeedle: string;
    auditNeedle: string;
  }
): Promise<ProviderWorkflowResult> {
  await createProviderConnection(native, options);
  const content = await browseProviderConfig(native, options.sourceName, options.browseItem, options.contentNeedle);
  const diffText = await compareProviderWithItself(native, options.sourceName, options.browseItem, options.contentNeedle);
  const auditText = await runProviderAudit(native, options.auditNeedle);
  const testMessage = await readLastConnectionTestMessage(native);
  return { sourceName: options.sourceName, testMessage, content, diffText, auditText };
}

async function createProviderConnection(
  native: NativeControlClient,
  options: { sourceName: string; providerLabel: string; baseUrl: string; fields: Array<[string, string]> }
): Promise<void> {
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Connections");
    await waitFor(() => pageText().includes("Connection Manager"), 15_000, "Connection Manager");
    clickButton("Add Source");
    await setProject("Native Smoke Project");
    await selectByLabel("Environment", "Development");
    await setInputByLabel("Source Name", ${JSON.stringify(options.sourceName)});
    await selectByLabel("Config Center", ${JSON.stringify(options.providerLabel)});
    await setInputByLabel("Target Address", ${JSON.stringify(options.baseUrl)});
    const fields = ${JSON.stringify(options.fields)};
    for (const [label, value] of fields) {
      await setInputByLabel(label, value);
    }
    clickButton("Test Connection");
    return true;
  `,
    20_000
  );

  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const message = normalize(document.querySelector(".test-msg")?.textContent || "");
      const success = /Connected|Connection test succeeded|Config center API passed/.test(message || pageText());
      return {
        done: success,
        value: message || "Connection test succeeded",
        text: pageText(),
      };
    `,
    30_000,
    `${options.sourceName} connection test`
  );

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Save");
    return true;
  `,
    10_000
  );

  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const connections = JSON.parse(localStorage.getItem("cs.connections") || "[]");
      const saved = Array.isArray(connections) && connections.find((item) => item && item.sourceName === ${JSON.stringify(options.sourceName)});
      return {
        done: Boolean(saved) && pageText().includes(${JSON.stringify(options.sourceName)}),
        value: saved ? saved.sourceName : "",
        text: pageText(),
      };
    `,
    15_000,
    `${options.sourceName} saved connection`
  );
}

async function readLastConnectionTestMessage(native: NativeControlClient): Promise<string> {
  return native.eval<string>(
    `
    ${DOM_HELPERS}
    return normalize(document.querySelector(".test-msg")?.textContent || "Connection test succeeded");
  `,
    5_000
  );
}

async function browseProviderConfig(native: NativeControlClient, sourceName: string, itemName: string, contentNeedle: string): Promise<string> {
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Config Browser");
    await waitFor(() => document.querySelector(".browse-header .page-actions .sel"), 15_000, "browser connection selector");
    await pickCustomSelect(".browse-header .page-actions", 0, ${JSON.stringify(sourceName)});
    await waitFor(() => pageText().includes(${JSON.stringify(itemName)}), 30_000, ${JSON.stringify(itemName)});
    clickText(${JSON.stringify(itemName)});
    return true;
  `,
    45_000
  );

  return waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const content = document.querySelector(".browser-detail")?.textContent || "";
      return { done: content.includes(${JSON.stringify(contentNeedle)}), value: content, text: pageText() };
    `,
    30_000,
    `${sourceName} browser content`
  );
}

async function compareProviderWithItself(native: NativeControlClient, sourceName: string, itemName: string, contentNeedle: string): Promise<string> {
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Config Compare");
    await waitFor(() => document.querySelectorAll(".source-picker").length >= 2, 15_000, "Diff source pickers");
    await pickCustomSelectInElement(document.querySelectorAll(".source-picker")[0], 1, ${JSON.stringify(sourceName)});
    await pickCustomSelectInElement(document.querySelectorAll(".source-picker")[1], 1, ${JSON.stringify(sourceName)});
    await waitFor(() => Array.from(document.querySelectorAll(".source-picker")).every((picker) => normalize(picker.textContent).includes(${JSON.stringify(sourceName)})), 15_000, "selected diff sources");
    setComboboxValueInElement(document.querySelectorAll(".source-picker")[0].querySelectorAll(".combo")[0], ${JSON.stringify(itemName)});
    setComboboxValueInElement(document.querySelectorAll(".source-picker")[1].querySelectorAll(".combo")[0], ${JSON.stringify(itemName)});
    clickButton("Load & Compare");
    return true;
  `,
    45_000
  );

  return waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = document.querySelector(".diff-result")?.textContent || "";
      return { done: text.includes(${JSON.stringify(contentNeedle)}) && text.includes("Both sides are identical"), value: text, text: pageText() };
    `,
    45_000,
    `${sourceName} diff result`
  );
}

async function runProviderAudit(native: NativeControlClient, auditNeedle: string): Promise<string> {
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Config Matrix");
    await waitFor(() => pageText().includes("Run Audit"), 15_000, "Config Matrix page");
    clickButton("Run Audit");
    return true;
  `,
    20_000
  );

  return waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = document.querySelector(".audit-matrix")?.textContent || "";
      return { done: text.includes(${JSON.stringify(auditNeedle)}), value: text, text: pageText() };
    `,
    60_000,
    `audit matrix ${auditNeedle}`
  );
}

async function verifyNativeSSHProfileAndTunnel(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const profileName = "Native Docker SSH";
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("SSH Tunnels");
    await waitFor(() => pageText().includes("SSH Tunnel Profiles"), 15_000, "SSH manager");
    await setInputByLabel("Profile Name", ${JSON.stringify(profileName)});
    await setInputByLabel("SSH Server Address", ${JSON.stringify(smoke.ssh.host)});
    await setInputByLabel("SSH Port", ${JSON.stringify(String(smoke.ssh.hostPort))});
    await setInputByLabel("SSH Username", ${JSON.stringify(smoke.ssh.username)});
    await setInputByLabel("SSH Password", ${JSON.stringify(smoke.ssh.password)});
    clickButton("Test SSH");
    return true;
  `,
    20_000
  );

  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("SSH connection passed"), value: text, text };
    `,
    45_000,
    "Docker SSH profile test"
  );
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Save");
    await waitFor(() => {
      const profiles = JSON.parse(localStorage.getItem("cs.sshProfiles") || "[]");
      return Array.isArray(profiles) && profiles.some((profile) => profile.name === ${JSON.stringify(profileName)});
    }, 10_000, "saved SSH profile");
    return true;
  `,
    15_000
  );
  pass(smoke, "SSH-CONTAINER-PROFILE-01", "SSH Manager", "Native SSH Manager tested and saved a Docker SSH profile through real Wails binding");

  const tunnelResult = await native.eval<{ localPort: number; content: string }>(
    `
    const app = window.go && window.go.main && window.go.main.App;
    if (!app || typeof app.CreateSSHTunnel !== "function" || typeof app.NacosGetConfig !== "function") {
      throw new Error("SSH tunnel or Nacos binding not found");
    }
    const connectionId = "native-ssh-tunnel-" + Date.now();
    const localPort = await app.CreateSSHTunnel(connectionId, {
      host: ${JSON.stringify(smoke.ssh.host)},
      port: ${JSON.stringify(smoke.ssh.hostPort)},
      username: ${JSON.stringify(smoke.ssh.username)},
      authType: "password",
      password: ${JSON.stringify(smoke.ssh.password)},
      privateKey: "",
      passphrase: "",
      localPort: 0,
      remoteHost: "confscope-smoke-nacos-dev",
      remotePort: 8848,
    });
    try {
      const content = await app.NacosGetConfig("http://127.0.0.1:" + localPort + "/nacos", "", "v1", "", "smoke-app.yaml", "DEFAULT_GROUP");
      return { localPort, content };
    } finally {
      await app.StopSSHTunnel(connectionId);
    }
  `,
    60_000,
  );
  expect(tunnelResult.localPort).toBeGreaterThan(0);
  expect(tunnelResult.content).toContain("feature: true");
  pass(smoke, "SSH-CONTAINER-TUNNEL-01", "SSH Manager", "Native Wails CreateSSHTunnel read Docker Nacos config through Docker SSH tunnel");
}

async function verifyNativeAppDataWebDAVBackup(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const target = {
    url: smoke.webdav.baseUrl,
    username: smoke.webdav.username,
    password: smoke.webdav.password,
    rootPath: smoke.webdav.rootPath,
    backupPassword: "native-app-data-pass",
  };
  const expectedConnectionCount = await native.eval<number>(
    `
    const connections = JSON.parse(localStorage.getItem("cs.connections") || "[]");
    return Array.isArray(connections) ? connections.length : 0;
  `,
    5_000
  );
  await native.eval<boolean>(
    `
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
  `,
    30_000
  );

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

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    await setInputByLabel("WebDAV backup password", ${JSON.stringify(target.backupPassword)});
    clickButton("Upload current data");
    return true;
  `,
    10_000
  );
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

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Refresh remote list");
    return true;
  `,
    10_000
  );
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      const rows = Array.from(document.querySelectorAll(".app-data-backup-remote-row"));
      const hasRemoteBackup = rows.some((element) => normalize(element.textContent).includes("confscope-app-data-") && element.querySelector("button"));
      const diagnostics = {
        readyState: document.readyState,
        location: window.location.href,
        bodyText: text,
        rowCount: rows.length,
        buttonTexts: Array.from(document.querySelectorAll("button")).map((button) => normalize(button.textContent)).slice(0, 30),
      };
      return { done: text.includes("Remote backup list loaded") && hasRemoteBackup, value: text, text: JSON.stringify(diagnostics) };
    `,
    45_000,
    "refreshed remote backup row"
  );
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    await setInputByLabel("Remote restore password", ${JSON.stringify(target.backupPassword)});
    const previewButton = remoteBackupPreviewButton();
    if (!previewButton) throw new Error("Remote backup preview button not found after refreshed list");
    previewButton.click();
    return true;
  `,
    10_000
  );
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes(${JSON.stringify(`Connections: ${expectedConnectionCount}`)}), value: text, text };
    `,
    30_000,
    "remote backup preview"
  );
  pass(smoke, "NATIVE-APPDATA-WEBDAV-LIST-01", "App Data Backup", "Native Settings refreshed Docker WebDAV list and showed the uploaded backup row");
  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    const restoreButton = findButton("Restore this backup");
    if (!restoreButton) throw new Error("Restore button not found before clearing connections");
    localStorage.setItem("cs.connections", "[]");
    restoreButton.click();
    return true;
  `,
    10_000
  );
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

async function verifyNativeConfigSnapshotWebDAV(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const target = {
    url: smoke.webdav.baseUrl,
    username: smoke.webdav.username,
    password: smoke.webdav.password,
    rootPath: "/confscope/native-snapshots",
    packagePassword: "native-snapshot-pass",
  };

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Config Browser");
    await waitFor(() => document.querySelector(".browse-header .page-actions .sel"), 15_000, "browser connection selector");
    await pickCustomSelect(".browse-header .page-actions", 0, "Native Dev Nacos");
    await waitFor(() => pageText().includes("smoke-app.yaml"), 30_000, "Nacos smoke item before snapshot");
    clickButton("Create current list snapshot");
    await waitFor(() => pageText().includes("Snapshot created:"), 30_000, "snapshot created");
    clickButton("Backups");
    await waitFor(() => pageText().includes("Snapshot WebDAV"), 20_000, "Snapshot WebDAV panel");
    await setInputByLabel("WebDAV URL", ${JSON.stringify(target.url)});
    await setInputByLabel("WebDAV username", ${JSON.stringify(target.username)});
    await setInputByLabel("WebDAV password", ${JSON.stringify(target.password)});
    await setInputByLabel("Remote folder", ${JSON.stringify(target.rootPath)});
    await setInputByLabel("Snapshot package password", ${JSON.stringify(target.packagePassword)});
    clickButton("Save WebDAV target");
    clickButton("Test WebDAV");
    return true;
  `,
    60_000
  );

  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("WebDAV connection passed"), value: text, text };
    `,
    30_000,
    "snapshot WebDAV connection passed"
  );
  pass(smoke, "NATIVE-SNAPSHOT-WEBDAV-TEST-01", "Config Snapshot WebDAV", "Native Backups tested Docker WebDAV snapshot target");

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Upload selected snapshot");
    return true;
  `,
    10_000
  );
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("Snapshot package uploaded"), value: text, text };
    `,
    45_000,
    "snapshot package uploaded"
  );
  pass(smoke, "NATIVE-SNAPSHOT-WEBDAV-UPLOAD-01", "Config Snapshot WebDAV", "Native Backups uploaded .cssnapshot to Docker WebDAV");

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Refresh remote snapshots");
    return true;
  `,
    10_000
  );
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes(".cssnapshot") && !text.includes(".csbackup"), value: text, text };
    `,
    30_000,
    "remote snapshot list"
  );
  pass(smoke, "NATIVE-SNAPSHOT-WEBDAV-LIST-01", "Config Snapshot WebDAV", "Native Backups refreshed remote snapshot list");

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    const remoteRows = Array.from(document.querySelectorAll(".backup-remote-item"));
    const row = remoteRows.find((element) => normalize(element.textContent).includes(".cssnapshot"));
    if (!row) throw new Error("Remote .cssnapshot row not found");
    const importButton = Array.from(row.querySelectorAll("button")).find((button) => normalize(button.textContent).includes("Import"));
    if (!importButton) throw new Error("Import .cssnapshot button not found");
    importButton.click();
    return true;
  `,
    10_000
  );
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = pageText();
      return { done: text.includes("Snapshot imported") && text.includes("smoke-app.yaml"), value: text, text };
    `,
    45_000,
    "snapshot imported"
  );
  pass(smoke, "NATIVE-SNAPSHOT-WEBDAV-IMPORT-01", "Config Snapshot WebDAV", "Native Backups imported remote .cssnapshot");

  await native.eval<boolean>(
    `
    ${DOM_HELPERS}
    clickButton("Compare with cloud");
    return true;
  `,
    10_000
  );
  await waitForNativeValue<string>(
    native,
    `
      ${DOM_HELPERS}
      const text = document.querySelector(".diff-result")?.textContent || "";
      return { done: text.includes("Both sides are identical"), value: text, text: pageText() };
    `,
    45_000,
    "snapshot WebDAV diff"
  );
  pass(smoke, "NATIVE-SNAPSHOT-WEBDAV-DIFF-01", "Config Snapshot WebDAV", "Native imported snapshot compared with Docker Nacos in DiffView");
}

async function verifyNavigationPages(native: NativeControlClient, smoke: SmokeState): Promise<void> {
  const pages = [
    {
      button: "Backups",
      marker: "Backups",
      id: "NATIVE-BACKUP-UI-01",
      area: "Backup",
      evidence: "Backups page loaded in native Wails shell",
    },
    { button: "Tasks", marker: "Tasks", id: "NATIVE-TASK-UI-01", area: "Task Center", evidence: "Tasks page loaded in native Wails shell" },
    {
      button: "Settings",
      marker: "Settings",
      id: "NATIVE-SETTINGS-UI-01",
      area: "Settings",
      evidence: "Settings page loaded in native Wails shell",
    },
    { button: "About", marker: "ConfScope", id: "NATIVE-ABOUT-UI-01", area: "About", evidence: "About page loaded in native Wails shell" },
  ] as const;

  for (const page of pages) {
    await native.eval<boolean>(
      `
      ${DOM_HELPERS}
      clickButton(${JSON.stringify(page.button)});
      return true;
    `,
      10_000
    );
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
  const mouseDown = (element) => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  };
  const pickCustomSelectInElement = async (scope, index, optionText) => {
    if (!scope) throw new Error("Select scope not found for option: " + optionText);
    const select = scope.querySelectorAll(".sel")[index];
    if (!select) throw new Error("Custom select not found at index " + index + " for option: " + optionText);
    const trigger = select.querySelector(".sel-trigger");
    if (!trigger) throw new Error("Custom select trigger not found for option: " + optionText);
    trigger.click();
    await waitFor(() => Array.from(select.querySelectorAll(".sel-option")).some((option) => normalize(option.textContent).includes(optionText)), 10_000, "select option " + optionText);
    const option = Array.from(select.querySelectorAll(".sel-option")).find((item) => normalize(item.textContent).includes(optionText));
    if (!option) throw new Error("Custom select option not found: " + optionText);
    mouseDown(option);
    await sleep(150);
  };
  const pickCustomSelect = async (scopeSelector, index, optionText) => {
    await pickCustomSelectInElement(document.querySelector(scopeSelector), index, optionText);
  };
  const pickComboboxInElement = async (combo, optionText) => {
    if (!combo) throw new Error("Combobox not found for option: " + optionText);
    const input = combo.querySelector("input");
    if (!input) throw new Error("Combobox input not found for option: " + optionText);
    setNativeValue(input, "");
    input.focus();
    await sleep(100);
    await waitFor(() => Array.from(combo.querySelectorAll(".combo-option")).some((option) => normalize(option.textContent).includes(optionText)), 15_000, "combobox option " + optionText);
    const option = Array.from(combo.querySelectorAll(".combo-option")).find((item) => normalize(item.textContent).includes(optionText));
    if (!option) throw new Error("Combobox option not found: " + optionText);
    mouseDown(option);
    await sleep(150);
  };
  const setComboboxValueInElement = (combo, value) => {
    if (!combo) throw new Error("Combobox not found for value: " + value);
    const input = combo.querySelector("input");
    if (!input) throw new Error("Combobox input not found for value: " + value);
    setNativeValue(input, value);
  };
  const remoteBackupPreviewButton = () => {
    const rows = Array.from(document.querySelectorAll(".app-data-backup-remote-row"));
    const row = rows.find((element) => normalize(element.textContent).includes("confscope-app-data-")) || rows[0];
    return row ? row.querySelector("button") : null;
  };
  const closeStartupDialog = async () => {
    const action = findButton("Start") || findButton("Got it");
    if (action) {
      action.click();
      await waitFor(() => !document.querySelector(".startup-overlay"), 5_000, "startup dialog close");
    }
  };
`;
