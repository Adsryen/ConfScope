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
- 容器化全量回归覆盖已补齐并发布 `v1.6.2`。

## v1.x 小步增强

### 1. audit-export-provider-hardening

状态：已完成，已发布 `v1.6.1`。

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

状态：已完成。

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

### 4. credential-secretref-migration

状态：已完成。

目标：把小凭据从 localStorage 明文字段迁移到系统凭据库，localStorage 只保存 `secretRef` 和非敏感元数据。

优先覆盖：

- Nacos password / token。
- Apollo token。
- Consul token。
- Aliyun MSE AK/SK/securityToken。
- app-data WebDAV password。
- config snapshot WebDAV password。

必须满足：

- secure store 写入后必须读回校验，失败时保留明文回退。
- 平台不支持 secure store 时不能丢凭据。
- `.csbackup` 导出必须能解析 `secretRef` 回明文后再写入加密包，保留迁移电脑能力。
- `.csbackup` 恢复到不支持 secure store 的环境时，可以恢复明文字段，后续再重新迁移。
- 自动化测试必须使用隔离测试数据和测试 secure-store target，不迁移真实用户 `cs.*` 数据。

不做：

- 不处理 SSH private key 这类大 secret。
- 不改变 `.cssnapshot` 语义。
- 不引入账号体系或远端同步服务。

### 5. windows-large-secret-protection

状态：`credential-secretref-migration` 后的 P1 候选任务。

目标：为 SSH private key、SSH passphrase 等可能超过 WinCred 限制的大 secret 设计 Windows 安全存储方案。

推荐方向：

- 评估 DPAPI 加密本地文件。
- localStorage 或 secure store 只保存引用元数据。
- `.csbackup` 继续作为跨机器迁移主路径，导出时写入明文 secret 到加密包内。

不做：

- 不强行把 private key 塞进 WinCred。
- 不承诺 DPAPI 文件可直接跨机器迁移。

## v2.0.0 平台化重构

### 1. platform-data-model-migration

目标：把项目、环境、provider、source 从当前连接列表模型中抽象出来。

必须先完成：

- `local-data-migration-guardrails`
- app-data backup restore 兼容测试
- `credential-secretref-migration` 的备份恢复边界
- Windows 大 secret 至少完成设计，避免 v2 模型继续固化明文字段债务

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
- `credential-secretref-migration`
- Windows 大 secret 方案设计

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
- 2026-07-08：`v1.6.2` 已发布，容器化全量回归覆盖补齐。
- 2026-07-08：新建 Trellis 任务 `07-08-platform-governance-scope-confirmation` 复审平台化/治理后续项。用户接受推荐：先产出完整路线矩阵，并默认把 `credential-secretref-migration` 标为下一条最高优先级任务。
- 2026-07-08：已创建独立 Trellis 任务 `07-08-credential-secretref-migration`，用于规划小凭据 `secretRef` 真实迁移；`07-08-platform-governance-scope-confirmation` 已归档。
- 2026-07-08：`credential-secretref-migration` 已完成，覆盖 provider/WebDAV 小凭据真实 WinCred 迁移、runtime hydrate、`.csbackup` portable 导出恢复和 native smoke 回归。

## 当前执行任务

当前优先任务：`credential-secretref-migration` 已完成；下一步评估 Windows 大 secret 保护方案或进入后续平台化数据模型迁移。

刚完成任务参考：

- `credential-security-discovery` 已完成凭据盘点、方案对比、Windows Credential Manager PoC、native smoke 和后续迁移边界。

计划文件：

- `docs/todo/credential-security-discovery-plan.md`
- `.trellis/tasks/07-08-credential-security-discovery/prd.md`
- `.trellis/tasks/07-08-credential-security-discovery/design.md`
- `.trellis/tasks/07-08-credential-security-discovery/implement.md`
- `.trellis/tasks/07-08-platform-governance-scope-confirmation/prd.md`
- `.trellis/tasks/07-08-platform-governance-scope-confirmation/design.md`
- `.trellis/tasks/07-08-platform-governance-scope-confirmation/implement.md`
- `.trellis/tasks/07-08-credential-secretref-migration/prd.md`
- `.trellis/tasks/07-08-credential-secretref-migration/design.md`
- `.trellis/tasks/07-08-credential-secretref-migration/implement.md`

后续顺序：

1. 单独评估 Windows 大 secret（SSH privateKey/passphrase）DPAPI 加密文件方案。
2. 再进入 `platform-data-model-migration`，作为 `v2.0.0` 平台化数据模型迁移起点。
3. 后续按依赖推进跨 provider 聚合视图、治理矩阵、平台安全模型、跨中心应用策略和治理报告。
