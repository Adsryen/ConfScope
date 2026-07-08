# 凭据安全路线调研计划

创建时间：2026-07-08

## 目标

确认 ConfScope 当前本地凭据的存储、备份、导出、日志和测试暴露面，并输出后续凭据安全增强路线。该计划包含 Windows Credential Manager 最小 PoC，但 PoC 不接入真实用户数据。

## 当前结论

推荐路线：系统凭据库 + localStorage `secretRef`。

- Windows：先验证 Credential Manager PoC，用于 password/token/AK/SK/WebDAV password 这类小凭据。
- Windows 大 secret：SSH private key 可能超过 WinCred blob 限制，后续单独评估 DPAPI 加密文件或其他安全容器。
- macOS：后续映射 Keychain Services。
- Linux：后续映射 Secret Service / libsecret。
- localStorage：未来只保留非敏感元数据和 secret reference。
- `.csbackup`：仍必须能导出可恢复明文凭据到加密包内，保留迁移电脑能力。
- 包密码：继续只作为临时输入，不持久化。

## 已确认凭据面

- `cs.connections`
  - Nacos password
  - Aliyun MSE `accessKeyId/accessKeySecret/securityToken`
  - Apollo `apolloToken`
  - Consul `consulToken`
  - inline SSH `password/privateKey/passphrase`
- `cs.sshProfiles`
  - SSH profile `password/privateKey/passphrase`
- `cs.appDataBackup`
  - app-data WebDAV target password
- `cs.snapshotWebDAV`
  - config snapshot WebDAV target password
- transient package passwords
  - `.csbackup` password
  - `.cssnapshot` password

## 任务边界

本任务做：

- 风险矩阵。
- 候选方案对比。
- Windows Credential Manager PoC 设计。
- 迁移、备份、恢复、回滚策略。
- 后续实现任务拆分。

本任务不做：

- 不迁移真实 `cs.*` store。
- 不删除现有明文字段。
- 不改变 `.csbackup` / `.cssnapshot` schema。
- 不实现 macOS Keychain 或 Linux Secret Service。
- 不引入账号体系、远端同步服务或企业 KMS。

## PoC 验证范围

Windows PoC 只验证：

- 写入测试凭据。
- 读取同一测试凭据。
- 删除测试凭据。
- 错误分类。
- native smoke 可调用。
- 测试结束后清理 `ConfScope/poc/<run-id>` target。
- 小 payload，不覆盖 SSH private key 大 secret。

## PoC 实现结论

- 已新增 `internal/securestore` PoC 接口和 Windows WinCred 实现。
- 已新增 `RunCredentialStorePoC(runID)` Wails 绑定，只写入 `ConfScope/poc/<run-id>` 测试凭据。
- PoC 返回值仅包含 target 名称、读回/删除状态和值大小，不返回 secret 值。
- native smoke 新增 `NATIVE-CREDENTIAL-STORE-POC-01`，用于真实 Windows 原生包验证。
- 真实凭据迁移、macOS Keychain、Linux Secret Service、SSH privateKey 大 secret 仍是后续任务。

## Trellis artifacts

- `.trellis/tasks/07-08-credential-security-discovery/prd.md`
- `.trellis/tasks/07-08-credential-security-discovery/design.md`
- `.trellis/tasks/07-08-credential-security-discovery/implement.md`

## 验收

- 用户确认规划。
- roadmap 当前任务更新为 `credential-security-discovery`。
- 后续如果进入实现，PoC 提交必须与规划提交分开。
