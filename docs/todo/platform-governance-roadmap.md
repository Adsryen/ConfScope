# ConfScope 多配置中心平台化与治理路线图

最后更新：2026-07-08

## 结论

采用“`v1.x` 小步增强 + `v2.0.0` 平台化重构”的路线。

`v1.x` 继续围绕现有桌面单用户、本地存储、provider、AuditView、DiffView、ApplyPlan、smoke 体系做向后兼容增强。`v2.0.0` 再处理会改变产品形态和数据结构的平台化能力，包括统一项目/环境/source 模型、跨 provider 聚合视图、跨配置中心治理矩阵、平台安全模型和跨中心应用策略。

## 已完成基线

- Nacos 浏览、diff、audit、ApplyPlan 安全写入链路。
- Apollo OpenAPI 只读适配，含 Docker fixture smoke。
- Consul KV 只读适配，含 Docker Consul smoke。
- 应用数据本地/WebDAV 备份恢复，使用 `.csbackup`。
- 配置中心快照 WebDAV 同步，使用 `.cssnapshot`，已发布 `v1.6.0`。
- 全量真实 smoke：Docker Nacos、Apollo fixture、Consul、WebDAV。
- 审计导出 provider 字段与脱敏增强，已发布 `v1.6.1`。
- 本地数据迁移兼容护栏，覆盖旧 localStorage fixture、schema v1 `.csbackup` 恢复和 loader normalize。
- 凭据安全路线调研与 Windows Credential Manager 最小 PoC，覆盖 WinCred 写入/读取/删除和 native smoke。

## v1.x 小步增强

### 1. audit-export-provider-hardening

目标：让 Nacos/Apollo/Consul/local 的审计导出字段一致、可脱敏、可归档。

范围：

- CSV/JSON 导出包含 provider、connection、namespace/group/dataId/key、状态、差异摘要。
- 导出脱敏规则覆盖 token、password、AK/SK、WebDAV 凭据和疑似 secret key。
- Apollo/Consul/local 的 provider 字段不丢失。
- Playwright smoke 覆盖 Apollo/Consul 审计后导出。

不做：

- 不新增治理报告页面。
- 不做跨 provider 写入。

### 2. local-data-migration-guardrails

目标：为后续 v2 数据模型迁移建立旧数据兼容护栏。

范围：

- 保存旧 `cs.connections`、settings、history、apply plans、app-data backup payload fixture。
- 覆盖旧数据加载、normalize、backup restore 后仍可浏览/对比。
- 明确新增字段默认值和丢弃非法记录的规则。

不做：

- 不在本任务引入数据库。
- 不做账号体系或远端同步服务端。

### 3. credential-security-discovery

状态：已完成。

目标：确认凭据安全增强路线，不直接一次性替换所有存储。

范围：

- 盘点当前明文凭据：连接 token、WebDAV password、Apollo token、Consul token、AK/SK、SSH passphrase。
- 对比 Windows Credential Manager、macOS Keychain、Linux Secret Service、企业 KMS/STS。
- 输出可行迁移路径、降级策略、用户提示和 smoke 可测点。

不做：

- 不直接改所有 store。
- 不承诺所有平台同一阶段完成。

## v2.0.0 平台化重构

### 1. platform-data-model-migration

目标：把项目、环境、provider、source 从当前连接列表模型中抽象出来。

必须先完成：

- `local-data-migration-guardrails`
- app-data backup restore 兼容测试

### 2. multi-provider-aggregate-view

目标：一个入口浏览 Nacos、Apollo、Consul、local snapshot、WebDAV snapshot 来源。

风险：

- 多 provider 分页、错误聚合、权限差异和字段映射复杂。

### 3. cross-provider-governance-matrix

目标：把当前 AuditView 升级为跨配置中心治理矩阵。

必须明确：

- provider 对齐规则
- 缺失解释
- 忽略策略
- 导出合同
- 解析失败与权限失败的区别

### 4. platform-security-model

目标：统一凭据托管、脱敏导出、操作历史脱敏、生产确认和权限提示。

必须先完成：

- `credential-security-discovery`

### 5. cross-provider-apply-strategy

目标：从治理差异生成跨中心修复计划。

边界：

- 默认仍不开放 Apollo/Consul 写入。
- 所有写入必须走 ApplyPlan、dry-run、before backup、生产确认。

### 6. governance-reporting

目标：输出治理摘要、异常趋势、重复配置、风险报告。

前置：

- cross-provider-governance-matrix 稳定。

## 决策记录

- 2026-07-08：接受“`v1.x` 小步增强 + `v2.0.0` 平台化重构”路线。
- 2026-07-08：配置快照 WebDAV 已作为 `v1.6.0` 完成，不再作为未完成候选项。
- 2026-07-08：确认下一项 `v1.x` P0 任务为 `audit-export-provider-hardening`，并创建 Trellis 任务 `07-08-audit-export-provider-hardening`。
- 2026-07-08：`audit-export-provider-hardening` 已完成并发布 `v1.6.1`。
- 2026-07-08：确认下一项 `v1.x` P0 任务为 `local-data-migration-guardrails`，并创建 Trellis 任务 `07-08-local-data-migration-guardrails`。
- 2026-07-08：`local-data-migration-guardrails` 已完成，新增兼容 fixture 和自动化护栏测试。
- 2026-07-08：确认下一项 `v1.x` P1 任务为 `credential-security-discovery`，包含 Windows Credential Manager 最小 PoC 设计，但不迁移真实凭据数据。
- 2026-07-08：`credential-security-discovery` 已完成，新增 Windows Credential Manager PoC、Go 测试和 native smoke 验证；真实凭据迁移与跨平台 Keychain/Secret Service 进入后续任务。

## 当前执行任务

当前优先任务：待确认下一条任务线。

刚完成任务参考：

- `credential-security-discovery` 已完成凭据盘点、方案对比、Windows Credential Manager PoC、native smoke 和后续迁移边界。

计划文件：

- `docs/todo/credential-security-discovery-plan.md`
- `.trellis/tasks/07-08-credential-security-discovery/prd.md`
- `.trellis/tasks/07-08-credential-security-discovery/design.md`
- `.trellis/tasks/07-08-credential-security-discovery/implement.md`

后续顺序：

1. 确认是否拆出真实凭据迁移任务，先覆盖小凭据 `secretRef` 迁移与 `.csbackup` 导出兼容。
2. 单独评估 Windows 大 secret（SSH privateKey）DPAPI 加密文件方案。
3. 再评估是否进入 v2 平台化数据模型迁移。
