# Full Product Smoke Matrix

This tracked matrix is the current source of truth for ConfScope full-product smoke coverage. Runtime evidence is written to
`.tmp/full-smoke-<run-id>/reports/result.md`; run artifacts must stay outside git.

Status values:

- `PASS`: automated coverage exists and must emit the listed report case.
- `FAIL_PRODUCT_BUG`: workflow is automated and currently expected to expose a product defect.
- `FAIL_TEST_SETUP`: workflow is blocked by smoke harness or container setup.
- `NOT_RUN_UNIMPLEMENTED`: product capability is not implemented yet.
- `NOT_RUN_ENV_MISSING`: coverage needs an environment that the reusable container smoke cannot safely provide.
- `NOT_RUN_RISK_ACCEPTANCE`: coverage is intentionally manual because automation would be unsafe or destructive.
- `NOT_RUN_AUTOMATION_GAP`: product exists, but reusable automation is still being added.

## Environment And Harness

| ID | Area | Surface | Environment | Status | Automation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| ENV-DOCKER | Environment | Docker availability | Vite/native global setup | PASS | `tests/smoke/global-setup.ts`, `tests/smoke/native/global-setup.ts` | Docker is reachable before any container workflow runs. |
| ENV-NACOS-01 | Environment | Nacos dev/sandbox/prod containers | Vite/native Docker | PASS | `pnpm test:smoke`, `pnpm test:smoke:native` | Three loopback Nacos containers are started and seeded. |
| ENV-APOLLO-01 | Environment | Apollo-compatible OpenAPI fixture | Vite Docker | PASS | `tests/smoke/global-setup.ts` | Fixture responds to authenticated OpenAPI namespace reads. |
| ENV-CONSUL-01 | Environment | Consul KV fixture | Vite Docker | PASS | `tests/smoke/global-setup.ts` | Consul dev agent starts, seeds KV, and returns decoded content. |
| ENV-SSH-01 | Environment | SSH server fixture | Windows native Docker | PASS | `tests/smoke/native/global-setup.ts` | Docker SSH server emits an SSH protocol banner and is tested by the native Wails binding. |
| ENV-WEBDAV-01 | Environment | Generic WebDAV storage | Vite/native Docker | PASS | `tests/smoke/global-setup.ts`, `tests/smoke/native/global-setup.ts` | Basic-auth WebDAV container accepts smoke root operations. |
| ENV-WEB-01 | Environment | Vite smoke web server | Vite global setup | PASS | `tests/smoke/global-setup.ts` | `pnpm dev:web` serves only on strict loopback smoke port. |
| ENV-NATIVE-BUILD-01 | Environment | Wails Windows executable | Native global setup | PASS | `tests/smoke/native/global-setup.ts` | Windows native smoke builds `ConfScope-smoke-native.exe`. |
| ENV-CLEANUP-01 | Environment | Container/process cleanup | Vite/native teardown | PASS | `tests/smoke/global-teardown.ts`, `tests/smoke/native/global-teardown.ts` | Containers are removed unless `CONFSCOPE_SMOKE_KEEP=1`. |

## App Shell And Navigation

| ID | Area | Surface | Environment | Status | Automation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| FS-APP-01 | App shell | Startup shell with Wails bridge | Vite bridge | PASS | `tests/smoke/specs/00-health.spec.ts` | App shell loads with injected bridge. |
| FS-APP-02 | App shell | Main navigation pages | Vite bridge | PASS | `tests/smoke/specs/00-health.spec.ts` | Browser, compare, matrix, history, backups, tasks, connections, SSH, settings, and about open. |
| NATIVE-SHELL-01 | Native Desktop | Real Wails WebView shell | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real desktop shell loads through loopback control server. |
| NATIVE-BACKUP-UI-01 | Backup | Backups page navigation | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Backups page opens in native shell. |
| NATIVE-TASK-UI-01 | Task Center | Tasks page navigation | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Tasks page opens in native shell. |
| NATIVE-SETTINGS-UI-01 | Settings | Settings page navigation | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Settings page opens in native shell. |
| NATIVE-ABOUT-UI-01 | About | About page navigation | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | About page opens and app info is visible. |
| GAP-NATIVE-MACOS | Native Desktop | macOS packaged app | Native manual-risk | NOT_RUN_AUTOMATION_GAP | `tests/smoke/native/global-teardown.ts` | Windows-first native automation does not run macOS. |
| GAP-NATIVE-LINUX | Native Desktop | Linux packaged app | Native manual-risk | NOT_RUN_AUTOMATION_GAP | `tests/smoke/native/global-teardown.ts` | Windows-first native automation does not run Linux. |
| GAP-OS-DIALOGS | Native Desktop | OS dialogs, install/restart, external-open flows | Manual-risk | NOT_RUN_RISK_ACCEPTANCE | `tests/smoke/native/global-teardown.ts` | Destructive or OS-modal workflows remain manual spot checks. |

## Connections And Providers

| ID | Area | Surface | Environment | Status | Automation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| FS-CONN-02 | Connection Manager | Local snapshot validation | Vite bridge | PASS | `tests/smoke/specs/10-real-bindings.spec.ts` | Strict and invalid local snapshot directories return expected validation states. |
| NATIVE-CONNECTION-FORM-01 | Connections | Nacos form creation | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Nacos source is created through the visible form, not localStorage seed. |
| NATIVE-CONNECTION-TEST-01 | Connections | Nacos connection test | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real Go binding tests Docker Nacos connection. |
| FS-APOLLO-CONN-01 | Apollo provider | Apollo form/test/save | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/40-apollo-provider.spec.ts` | Apollo OpenAPI connection is created through the form and tested. |
| FS-CONSUL-CONN-01 | Consul provider | Consul form/test/save | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/45-consul-provider.spec.ts` | Consul KV connection is created through the form and tested. |
| NATIVE-APOLLO-CONNECTION-FORM-01 | Apollo provider | Native Apollo form/save | Windows native + Docker Apollo | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Apollo source is created through the native Connection Manager form. |
| NATIVE-APOLLO-CONNECTION-TEST-01 | Apollo provider | Native Apollo connection test | Windows native + Docker Apollo | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real Wails binding tests Docker Apollo OpenAPI. |
| NATIVE-CONSUL-CONNECTION-FORM-01 | Consul provider | Native Consul form/save | Windows native + Docker Consul | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Consul source is created through the native Connection Manager form. |
| NATIVE-CONSUL-CONNECTION-TEST-01 | Consul provider | Native Consul connection test | Windows native + Docker Consul | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real Wails binding tests Docker Consul KV. |

## Browse, Diff, Audit, And Apply

| ID | Area | Surface | Environment | Status | Automation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| FS-BIND-01 | Backend bindings | Nacos list/get through bridge | Vite bridge + Docker Nacos | PASS | `tests/smoke/specs/10-real-bindings.spec.ts` | Real Docker Nacos list/get returns seeded `smoke-app.yaml`. |
| FS-BROWSE-01 | Browse | Nacos browser list/detail | Vite bridge + Docker Nacos | PASS | `tests/smoke/specs/20-browse-pages.spec.ts` | Browser opens seeded config content. |
| NATIVE-CONFIG-BROWSE-01 | Browse | Nacos browser list/detail | Windows native + Docker Nacos | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native UI opens seeded config content. |
| FS-APOLLO-BROWSE-01 | Apollo provider | Apollo namespace browse | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/40-apollo-provider.spec.ts` | Browser opens Apollo namespace content. |
| FS-APOLLO-DIFF-01 | Apollo provider | Apollo diff | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/40-apollo-provider.spec.ts` | Compare loads identical Apollo namespace content. |
| FS-APOLLO-AUDIT-01 | Apollo provider | Apollo audit matrix | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/40-apollo-provider.spec.ts` | Matrix includes Apollo namespace and rows. |
| FS-APOLLO-AUDIT-EXPORT-01 | Apollo provider | Apollo audit JSON export | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/40-apollo-provider.spec.ts` | Exported JSON includes provider metadata and masks token. |
| NATIVE-APOLLO-BROWSE-01 | Apollo provider | Native Apollo namespace browse | Windows native + Docker Apollo | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native browser opens Apollo namespace content. |
| NATIVE-APOLLO-DIFF-01 | Apollo provider | Native Apollo diff | Windows native + Docker Apollo | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native compare loads identical Apollo namespace content. |
| NATIVE-APOLLO-AUDIT-01 | Apollo provider | Native Apollo audit matrix | Windows native + Docker Apollo | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native matrix includes Apollo provider content. |
| NATIVE-APOLLO-APPLY-01 | Apollo provider | Native Apollo ApplyPlan write/delete | Windows native + Docker Apollo | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Wails ApplyPlan binding writes and deletes an Apollo item, while direct write stays blocked. |
| FS-CONSUL-BROWSE-01 | Consul provider | Consul KV browse | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/45-consul-provider.spec.ts` | Browser opens decoded Consul KV content. |
| FS-CONSUL-DIFF-01 | Consul provider | Consul diff | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/45-consul-provider.spec.ts` | Compare loads identical Consul KV content. |
| FS-CONSUL-AUDIT-01 | Consul provider | Consul audit matrix | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/45-consul-provider.spec.ts` | Matrix includes Consul KV rows. |
| FS-CONSUL-AUDIT-EXPORT-01 | Consul provider | Consul audit CSV export | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/45-consul-provider.spec.ts` | CSV includes provider/source metadata and masks secrets. |
| FS-CONSUL-APPLY-01 | Consul provider | Consul UI ApplyPlan write | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/45-consul-provider.spec.ts` | Config Compare generates an ApplyPlan from local snapshot to Consul, executes CAS-protected write, and reads back the KV value. |
| NATIVE-CONSUL-BROWSE-01 | Consul provider | Native Consul KV browse | Windows native + Docker Consul | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native browser opens Consul KV content. |
| NATIVE-CONSUL-DIFF-01 | Consul provider | Native Consul diff | Windows native + Docker Consul | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native compare loads identical Consul KV content. |
| NATIVE-CONSUL-AUDIT-01 | Consul provider | Native Consul audit matrix | Windows native + Docker Consul | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native matrix includes Consul provider content. |
| NATIVE-CONSUL-APPLY-01 | Consul provider | Native Consul ApplyPlan create/update/delete | Windows native + Docker Consul | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Wails ApplyPlan binding creates, updates, CAS-blocks, and deletes a Consul KV, while direct write stays blocked. |
| FS-APPLY-01 | ApplyPlan | Sandbox publish through ApplyPlan binding | Vite bridge + Docker Nacos | PASS | `tests/smoke/specs/10-real-bindings.spec.ts` | Direct write is blocked; ApplyPlan publish writes sandbox Nacos. |
| FS-APOLLO-APPLY-BINDING-01 | Apollo provider | Apollo ApplyPlan binding write/delete | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/10-real-bindings.spec.ts` | ApplyPlan binding writes and deletes an Apollo item, while direct write stays blocked. |
| FS-APOLLO-APPLY-01 | Apollo provider | Apollo UI ApplyPlan write | Vite bridge + Docker Apollo | PASS | `tests/smoke/specs/40-apollo-provider.spec.ts` | Config Compare generates an ApplyPlan from local snapshot to Apollo, executes it, and reads back the released value. |
| FS-CONSUL-APPLY-BINDING-01 | Consul provider | Consul ApplyPlan binding create/update/delete | Vite bridge + Docker Consul | PASS | `tests/smoke/specs/10-real-bindings.spec.ts` | ApplyPlan binding creates, updates, CAS-blocks, and deletes a Consul KV, while direct write stays blocked. |
| FS-HISTORY-UI-01 | Operation History | Page navigation | Vite bridge | PASS | Covered by `FS-APP-02` | Navigation smoke opens Operation History without runtime crash. |
| FS-HISTORY-DATA-01 | Operation History | Historical operation replay | Vite bridge | PASS | `tests/smoke/specs/25-operation-history.spec.ts` | Smoke creates a snapshot through the UI, replays the local operation record, filters by type, and opens detail/copy controls. |

## Backup And Restore

| ID | Area | Surface | Environment | Status | Automation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| FS-BACKUP-01 | Backup | Create/list local config snapshot | Vite bridge | PASS | `tests/smoke/specs/10-real-bindings.spec.ts` | `CreateSnapshot` and `ListSnapshots` write under smoke home. |
| FS-BACKUP-UI-01 | Backup | Backup page navigation | Vite bridge | PASS | `tests/smoke/specs/20-browse-pages.spec.ts` | Backups page opens through shell. |
| FS-SNAPSHOT-WEBDAV-UPLOAD-01 | Config Snapshot WebDAV | Upload encrypted `.cssnapshot` | Vite bridge + Docker WebDAV | PASS | `tests/smoke/specs/32-config-snapshot-webdav.spec.ts` | Package is present in WebDAV mount and does not contain plaintext config. |
| FS-SNAPSHOT-WEBDAV-LIST-01 | Config Snapshot WebDAV | Remote snapshot list | Vite bridge + Docker WebDAV | PASS | `tests/smoke/specs/32-config-snapshot-webdav.spec.ts` | Remote list shows `.cssnapshot` and filters `.csbackup`. |
| FS-SNAPSHOT-WEBDAV-IMPORT-01 | Config Snapshot WebDAV | Import remote snapshot | Vite bridge + Docker WebDAV | PASS | `tests/smoke/specs/32-config-snapshot-webdav.spec.ts` | Remote package imports as a local snapshot. |
| FS-SNAPSHOT-WEBDAV-DIFF-01 | Config Snapshot WebDAV | Diff imported snapshot with cloud | Vite bridge + Docker WebDAV/Nacos | PASS | `tests/smoke/specs/32-config-snapshot-webdav.spec.ts` | Imported snapshot compares identical with cloud config. |
| NATIVE-SNAPSHOT-WEBDAV-TEST-01 | Config Snapshot WebDAV | Native WebDAV test | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Backups tests Docker WebDAV snapshot target. |
| NATIVE-SNAPSHOT-WEBDAV-UPLOAD-01 | Config Snapshot WebDAV | Native upload `.cssnapshot` | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Backups uploads a snapshot package. |
| NATIVE-SNAPSHOT-WEBDAV-LIST-01 | Config Snapshot WebDAV | Native remote snapshot list | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Backups refreshes remote snapshot list. |
| NATIVE-SNAPSHOT-WEBDAV-IMPORT-01 | Config Snapshot WebDAV | Native import remote snapshot | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Backups imports remote `.cssnapshot`. |
| NATIVE-SNAPSHOT-WEBDAV-DIFF-01 | Config Snapshot WebDAV | Native imported snapshot diff | Windows native + Docker WebDAV/Nacos | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native imported snapshot compares with Docker Nacos in DiffView. |
| FS-APPDATA-LOCAL-EXPORT-01 | App Data Backup | Local encrypted export | Vite bridge | PASS | `tests/smoke/specs/30-app-data-backup.spec.ts` | `.csbackup` is written under smoke app-backups and contains no plaintext secrets. |
| FS-APPDATA-LOCAL-RESTORE-01 | App Data Backup | Local preview/restore with recovery point | Vite bridge | PASS | `tests/smoke/specs/30-app-data-backup.spec.ts` | Backup preview restores localStorage after recovery point creation. |
| FS-APPDATA-WEBDAV-UPLOAD-01 | App Data Backup | WebDAV upload encrypted app-data backup | Vite bridge + Docker WebDAV | PASS | `tests/smoke/specs/30-app-data-backup.spec.ts` | Encrypted app-data package is uploaded to WebDAV. |
| FS-APPDATA-WEBDAV-RESTORE-01 | App Data Backup | WebDAV list/preview/restore | Vite bridge + Docker WebDAV | PASS | `tests/smoke/specs/30-app-data-backup.spec.ts` | Remote list row is visible, package previews and restores. |
| NATIVE-APPDATA-WEBDAV-TEST-01 | App Data Backup | Native WebDAV target test | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real Wails binding tests Docker WebDAV. |
| NATIVE-APPDATA-WEBDAV-UPLOAD-01 | App Data Backup | Native WebDAV upload | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real Go binding uploads app data package. |
| NATIVE-APPDATA-WEBDAV-RESTORE-01 | App Data Backup | Native WebDAV preview/restore | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Remote package restores native localStorage. |
| NATIVE-APPDATA-WEBDAV-LIST-01 | App Data Backup | Native explicit remote refresh/list assertion | Windows native + Docker WebDAV | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Settings refreshes Docker WebDAV list and shows uploaded backup row. |
| NATIVE-CREDENTIAL-SECRETREF-APPDATA-BACKUP-01 | App Data Backup | SecretRef portable backup restore | Windows native + Docker WebDAV + WinCred | PASS | `tests/smoke/native/specs/native-full.spec.ts` | App-data WebDAV backup after secretRef migration restores portable plaintext credentials. |

## Security, SSH, Settings, And Metadata

| ID | Area | Surface | Environment | Status | Automation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| NATIVE-CREDENTIAL-STORE-POC-01 | Security | Windows Credential Manager PoC | Windows native | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Real Wails binding writes, reads, deletes only a `ConfScope/poc/native-*` test credential. |
| NATIVE-CREDENTIAL-SECRETREF-MIGRATION-01 | Security | Credential secretRef migration | Windows native + WinCred | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Form-created Nacos, Apollo, and WebDAV credentials migrate into Windows Credential Manager while SSH password stays out of scope. |
| NATIVE-CREDENTIAL-SECRETREF-WEBDAV-HYDRATE-01 | Security | SecretRef WebDAV hydrate | Windows native + Docker WebDAV + WinCred | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Migrated app-data and snapshot WebDAV targets still test through real Wails bindings. |
| FS-SSH-UI-01 | SSH Manager | SSH page navigation | Vite bridge | PASS | Covered by `FS-APP-02` | SSH Tunnels page opens without runtime crash. |
| SSH-CONTAINER-PROFILE-01 | SSH Manager | Docker SSH profile connection test | Windows native + Docker SSH | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native SSH Manager tests and saves a Docker SSH profile through real Wails binding. |
| SSH-CONTAINER-TUNNEL-01 | SSH Manager | Nacos over SSH tunnel | Windows native + Docker SSH/Nacos | PASS | `tests/smoke/native/specs/native-full.spec.ts` | Native Nacos connection browses Docker Nacos through Docker SSH tunnel. |
| FS-SETTINGS-UI-01 | Settings | Settings page navigation | Vite bridge | PASS | Covered by `FS-APP-02` | Settings page opens without runtime crash. |
| FS-TASK-UI-01 | Task Center | Task Center navigation | Vite bridge | PASS | `tests/smoke/specs/20-browse-pages.spec.ts` | Task Center opens through shell. |
| FS-ABOUT-01 | About | About page and app info | Vite bridge | PASS | `tests/smoke/specs/20-browse-pages.spec.ts` | About page loads and app info binding responds. |
| UPDATE-CHECK-REAL-01 | About / Update | Real update feed/network check | External service | NOT_RUN_ENV_MISSING | Matrix-only | Container smoke must not depend on real public release/update endpoints. |
| MSE-REAL-01 | Connections | Real MSE instance compatibility | External service | NOT_RUN_ENV_MISSING | Matrix-only | No safe reusable local MSE fixture exists in the smoke harness. |
