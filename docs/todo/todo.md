# ConfScope 开发待办规划

**最后更新**: 2026-06-28
**规划参考**: `/mnt/c/Users/adsry/Desktop/fsdownload/ConfigCenterComparer`
**当前定位**: Go + Wails 桌面端配置中心管理、对比、审计工具。MVP 已支持 Nacos，后续应从“单配置浏览与 diff”升级为“多环境配置治理”。

---

## 0. 版本规划规则

这个文档以后按“版本 -> 优先级 -> 任务”维护。版本号由更新内容决定，不因为做了一个小功能就随意提高大版本。

### 0.1 版本号规则

- **MAJOR: `v2.0.0`、`v3.0.0`**
  - 核心产品形态发生明显变化。
  - 本地数据结构、配置文件、操作历史、连接模型存在不兼容迁移。
  - Provider 抽象、权限/安全模型、批量治理流程发生破坏性变化。
  - 示例：从“单配置中心工具”升级为“多配置中心治理平台”。
- **MINOR: `v1.1.0`、`v1.2.0`**
  - 一组完整、可发布、用户可感知的新能力。
  - 向后兼容，不要求用户重新配置才能继续使用已有核心功能。
  - 示例：审计矩阵、备份快照、Apollo 只读接入、环境应用计划。
- **PATCH: `v1.0.1`、`v1.1.1`**
  - 修 bug、补测试、优化 UI 细节、补发布工程、完善检查更新等小增强。
  - 内部重构只有在不改变用户能力边界时才放 PATCH。
  - 示例：`-ldflags` 注入版本号、修复代理配置保存、补 E2E 冒烟测试。
- **预发布: `v1.2.0-alpha.1`、`v1.2.0-beta.1`、`v1.2.0-rc.1`**
  - 大功能尚未稳定但需要内部验证。
  - `alpha` 用于流程未完整，`beta` 用于功能基本完整，`rc` 用于候选正式版。

### 0.2 优先级规则

- **P0: 发布门槛**
  - 这个版本不做就不应该发布。
  - 必须有自动化测试或明确的验证方式。
  - 涉及写入、删除、恢复、生产环境操作时必须有安全确认和回退策略。
- **P1: 版本完整度**
  - 做了会明显提升体验或稳定性。
  - 可以延后到同版本 patch，但不能长期没有归属。
- **P2: 可延后增强**
  - 不影响当前版本主路径。
  - 适合滚入后续 minor 或 patch，不阻塞发布。

### 0.3 发布门槛

每个正式版本至少满足：

- [ ] P0 任务全部完成或明确移出该版本。
- [ ] Go 测试通过：`go test ./... -count=1`。
- [ ] 前端类型检查通过：`pnpm exec tsc --noEmit`。
- [ ] 前端测试通过：`pnpm test`。
- [ ] Web 构建通过：`pnpm build:web`。
- [ ] `CHANGELOG`、应用版本、更新 manifest 同步。
- [ ] 危险操作、代理、凭据、导出内容经过脱敏检查。

### 0.4 文档维护规则

- 同一个待办只放在一个版本里，避免多处重复打勾。
- “能力池/参考清单”只记录方向和取舍，不作为执行状态来源。
- 当前版本的 P0 永远优先于未来版本的 P1/P2。
- 小修小补优先归入当前 patch 线，不为它们单独开 minor。
- 如果任务延期，要移动到目标版本，不保留原位置的重复项。

---

## 1. 当前执行指针

**当前基线**: `v1.0.0`
**当前开发线**: `v1.1.0`
**下一项立即做**: `v1.1.0 / P0` 的代码结构拆分与 provider 底座。

- [x] `v1.0.0` 已具备 Nacos 浏览、编辑、历史、diff、多连接、SSH 基础能力。
- [x] 已完成核心自动化测试第一批。
- [x] 已完成应用检查更新第一版：manifest、国内加速线路、代理配置、About 页入口。
- [ ] 进入 `v1.1.0` 前，先保证当前工作区干净、测试通过、todo 与 changelog 同步。

---

## 2. 版本路线图

### 2.1 `v1.0.x`: 稳定化补丁线

**版本性质**: PATCH
**目标**: 稳住 `v1.0.0` 已有能力，补齐发布、检查更新、测试和小问题，不引入大规模新工作流。

#### P0

- [x] 补齐现有核心自动化测试第一批。
  - Go 后端覆盖 Nacos client、SSH manager/tunnel、检查更新。
  - 前端覆盖 diff、format、keys、validate、normalize、audit、highlight、toast、connection store、检查更新，以及配置浏览、编辑、历史、删除确认、连接管理等核心组件路径。
- [x] 应用检查更新第一版。
  - Go 侧 `internal/updatecheck` 独立实现 manifest 检查、版本比较、更新源回退、HTTPS 下载校验。
  - 默认线路：GitHub 官方、`gh.llkk.cc`、`gh-proxy.com`、`ghfast.top`。
  - About 页展示当前版本、更新状态、命中线路、下载入口。
  - 检查更新支持 HTTP proxy、HTTPS proxy、no_proxy。
- [ ] 发布时统一应用版本来源。
  - 当前 Go 侧仍有 `appVersion = "1.0.0"`。
  - 打包时改用 `-ldflags` 注入版本，避免 `package.json` 与 Go 常量分叉。
- [ ] 准备更新 manifest 发布流程。
  - manifest 字段：`version`、`notes`、`downloadUrl`、`publishedAt`、`sha256`、`mandatory`。
  - 发布前校验下载链接必须为 HTTPS。

#### P1

- [ ] 检查更新本地状态。
  - 记录 `lastCheckAt`、`lastSeenVersion`、`skipVersion`。
  - 支持“忽略此版本”。
  - `mandatory=true` 时不允许忽略，但仍不自动安装。
- [ ] 启动后低频后台检查。
  - 默认不弹强打断弹框。
  - 有更新时只给顶部提示或 About 红点。
- [ ] 将 About 页中的代理入口迁移到 SettingsView 后，About 只保留检查更新操作。

#### P2

- [ ] 补 `CHANGELOG` 自动生成或半自动模板。
- [ ] 桌面壳冒烟脚本。
  - 构建成功。
  - 应用启动。
  - 首页无白屏。

---

### 2.2 `v1.1.0`: 架构底座与设置中心

**版本性质**: MINOR
**目标**: 先拆结构，再做大功能。把 Nacos 现有能力迁移到通用 provider 边界，为 AuditView、Apollo、备份、环境应用铺路。

#### P0

- [x] 后端 Provider 抽象第一批。
  - 定义 `ProviderType`: `nacos | apollo | consul | local`。
  - 定义 `ConnectionProfile`: 连接、认证、代理、SSH、环境标签、安全等级。
  - 定义 `ConfigRef`: provider、connectionId、namespace、group、dataId、key。
  - 定义 `ConfigDocument`: 原始内容、格式、更新时间、版本、来源。
  - [ ] 后续补 `ConfigEntry` 后端模型；当前 key/value 拆解仍保留在前端算法层。
- [x] 后端通用接口第一批。
  - `ListNamespaces`
  - `ListConfigs`
  - `GetConfig`
  - `PublishConfig`
  - `DeleteConfig`
  - `ListHistory`
  - `GetHistoryDetail`
  - `TestConnection`
- [x] Nacos 适配层第一批。
  - 保留现有 Nacos 行为，不重写业务。
  - 先把 `internal/nacos.Client` 包进 provider 适配器。
  - Wails `App` 只保留薄绑定和参数转发。
- [x] 前端 API 边界第一批。
  - 保留 `src/api/nacos.ts` 兼容过渡。
  - 新增通用 `src/api/configCenter.ts`。
  - [ ] 页面逐步从 Nacos 专属 API 迁移到通用 API。
- [ ] 自动化测试。
  - [x] provider 抽象单元测试第一批。
  - [x] Nacos 适配器测试第一批。
  - [x] App provider 注册薄测试。
  - [x] App Wails 绑定 provider 分发测试第一批。
  - [x] 前端通用 configCenter API 包装测试第一批。
  - [ ] 页面迁移后的组件回归测试。

#### P1

- [ ] SettingsView。
  - 基础信息。
  - 认证。
  - 网络。
  - 安全。
  - 高级。
- [ ] 全局代理进入 SettingsView。
  - HTTP proxy。
  - HTTPS proxy。
  - no_proxy。
  - Nacos HTTP client 支持读取全局代理。
  - 每个连接允许覆盖全局代理。
  - UI 标识当前连接是否走代理。
- [ ] 连接管理升级为 provider 感知表单。
  - provider 类型选择。
  - 根据 provider 切换字段。
  - 基础信息、认证、网络、安全、高级分组。
  - 连接列表显示 provider、环境标签、安全等级、SSH/代理状态。
- [ ] SSH 隧道状态完善。
  - 显示已连接、本地端口、失败原因。
  - 支持手动重连和断开。
  - 连接删除或修改时自动关闭旧隧道。

#### P2

- [ ] 主布局骨架。
  - 从顶部双模式切换升级为左侧主导航。
  - 左侧主导航承载：浏览、对比、审计、备份、任务、设置。
  - 顶部栏只展示当前页面相关的上下文操作。
- [ ] 工程质量。
  - 配置 ESLint。
  - 配置 Prettier。
  - TypeScript strict 模式评估并逐步开启。
  - 移除未使用代码。

---

### 2.3 `v1.2.0`: Nacos 只读审计矩阵

**版本性质**: MINOR
**目标**: 先在 Nacos 上跑通参考项目最有价值的能力：多环境一致性矩阵。该版本只做只读审计，不做环境写入。

#### P0

- [x] 配置内容标准化纯函数。
  - YAML：使用 `yaml` 依赖解析，输出点路径 key。
  - JSON：递归展开对象。
  - Properties：按 `key=value` / `key: value` 解析。
  - TOML/XML/TEXT：可先降级为整文档 hash 和文本 diff。
- [x] 统一 `ConfigEntry` 输出。
  - `key`
  - `value`
  - `valueType`
  - `sourcePath`
  - `parseStatus`
  - `parseError`
- [x] 矩阵计算纯函数。
  - 主键：`normalizedName + namespace + group + dataId + key`。
  - 列：每个环境的 value、更新时间、存在状态。
  - 状态：一致、部分一致、不一致、缺失、无法解析、已忽略。
- [ ] 新增 AuditView。
  - 选择多个 Nacos 连接作为环境。
  - 每个环境可选择 namespace、group、dataId 过滤条件。
  - 支持同名 dataId 批量匹配。
  - 支持按基准环境比较。
- [ ] AuditView UI。
  - 顶部条件栏：环境选择、namespace/group/dataId 范围、基准环境、比较模式。
  - 状态摘要条：总数、一致、不一致、缺失、无法解析、已忽略。
  - 主矩阵表格：`dataId / key / 状态 / 各环境值 / 更新时间`。
  - 详情面板：展示当前行在各环境的原始值、差异、来源链接。
- [ ] 忽略规则 UI。
  - 矩阵行加入忽略。
  - 忽略规则管理列表。
  - 可临时显示已忽略项。
- [ ] 名称归一化 UI。
  - 前缀裁剪。
  - 后缀裁剪。
  - 精确替换。
  - 大小写是否敏感。
  - 默认不自动归一化，用户显式开启。
- [ ] 测试。
  - AuditView 过滤状态。
  - 行选择。
  - 忽略规则。
  - 名称归一化。
  - 跳转 diff。

#### P1

- [ ] 审计结果导出。
  - CSV：适合发给团队审阅。
  - JSON：适合后续导入或自动化处理。
  - 敏感字段默认剔除。
- [ ] 过滤与排序。
  - 仅看不一致。
  - 仅看缺失。
  - 仅看无法解析。
  - 隐藏已忽略。
  - 按 dataId、key、状态、环境排序。
- [ ] 矩阵行跳转。
  - 点击某行可打开对应 dataId 的详细 diff。
  - 可从矩阵直接复制 key/value。
- [ ] DiffView 与 AuditView 职责拆分。
  - DiffView 保持深度对比定位。
  - 批量治理入口迁移到 AuditView。

#### P2

- [ ] 矩阵大数据交互。
  - 虚拟滚动。
  - 固定 `dataId/key/status` 列。
  - 环境列、更新时间列、原始名称列可显隐。
  - 保存过滤条件。
- [ ] 重复配置检查第一版。
  - 同环境按 `key + normalizedValue` 分组。
  - 只展示出现次数 >= 2 的项。
  - 可导出 CSV。
- [ ] Playwright Web E2E。
  - 使用 mock Wails API。
  - 覆盖浏览、diff、审计主流程。

---

### 2.4 `v1.3.0`: 导出、备份与本地快照

**版本性质**: MINOR
**目标**: 给审计结果和配置内容提供可落地的保存、导出、快照和本地对比能力。

#### P0

- [ ] 单配置导出。
  - 原始内容。
  - 元信息 JSON。
- [ ] 差异导出。
  - 文本 diff。
  - key/value 差异 JSON。
- [ ] 审计矩阵导出增强。
  - CSV 转义。
  - JSON 字段完整性。
  - 敏感字段默认剔除。
- [ ] 本地备份目录结构。
  - provider。
  - connection name。
  - namespace。
  - group。
  - dataId。
  - metadata.json。
- [ ] 云端到本地快照。
  - 支持从 Nacos 拉取一次快照保存到本地。
  - 快照保存原始内容和元信息。
- [ ] local provider。
  - 本地快照作为 `local` provider 参与浏览和对比。
  - 支持云端 vs 本地备份。
  - 支持本地备份 A vs 本地备份 B。
- [ ] BackupView。
  - 快照列表。
  - 快照详情。
  - 云端/本地来源标识。
  - 快照与当前云端的差异入口。

#### P1

- [ ] 任务中心基础能力。
  - 批量导出、备份进入任务中心。
  - 展示任务名称、范围、进度、状态、开始时间、耗时。
  - 失败任务支持展开错误详情和复制错误。
  - 可取消的任务显示取消按钮。
- [ ] 导出安全策略。
  - 默认不导出密码、token、私钥。
  - 日志中屏蔽 password、accessKey、secretKey、token。
- [ ] 备份测试。
  - 本地目录结构生成。
  - 快照元信息完整性。
  - local provider 浏览与 diff。

#### P2

- [ ] 备份压缩包格式。
- [ ] 备份导入向导。
- [ ] Git 集成评估。

---

### 2.5 `v1.4.0`: 环境应用、操作历史与回退

**版本性质**: MINOR
**目标**: 闭环“发现差异 -> 应用到沙箱 -> 验证 -> 晋级真实环境 -> 可回退”。这是写入能力版本，安全门槛最高。

#### P0

- [ ] ApplyPlan 领域模型。
  - 源环境。
  - 目标环境。
  - provider、connection、namespace、group、dataId、key。
  - 源值、目标当前值、应用后值。
  - 新增、覆盖、删除、跳过、解析失败状态。
- [ ] 应用入口。
  - 从 AuditView 的差异行发起。
  - 从 DiffView 的单配置差异发起。
  - 从 BackupView 的快照差异发起。
- [ ] 应用范围。
  - 单 key 应用。
  - 单配置应用。
  - 批量应用。
- [ ] dry-run 应用计划。
  - 禁止跳过 dry-run 直接写入。
  - 计划生成后保存计划快照。
  - 确认执行时使用计划快照，而不是重新隐式计算。
  - 如果源或目标在计划后变化，要求重新生成计划。
- [ ] 沙箱到真实环境晋级。
  - 支持 `源环境 -> 沙箱环境 -> 真实环境`。
  - 沙箱应用完成后生成验证状态，不自动继续推真实环境。
  - 真实环境应用必须基于沙箱验证过的计划版本。
- [ ] 写入前备份。
  - 每次应用前保存目标环境原始内容快照。
  - 快照与操作历史绑定。
  - 如果备份失败，默认禁止继续写入。
- [ ] OperationHistory 领域模型。
  - 操作类型：apply、promote、restore、rollback、delete、publish。
  - 操作者、本机时间、源环境、目标环境、计划摘要、执行结果、错误详情。
  - 目标写入前内容、写入后内容、对应配置中心历史版本。
  - 默认保存在 Wails 应用数据目录。
- [ ] 回退操作。
  - 基于写入前备份生成 rollback dry-run。
  - 回退进入任务中心和操作历史。
  - 生产回退同样需要生产确认文本。
- [ ] 安全确认。
  - 沙箱环境至少需要普通确认。
  - 生产/真实环境需要输入确认文本。
  - 批量应用先展示影响数量和失败风险。
- [ ] 测试。
  - 应用计划生成。
  - 写入前备份失败禁止执行。
  - 计划后源/目标变化要求重新生成。
  - 回退计划使用 before 快照。

#### P1

- [ ] ApplyPlanView。
  - 展示计划摘要。
  - 展示每项 diff。
  - 展示确认状态。
- [ ] OperationHistoryView。
  - 操作列表、筛选、详情、回退入口。
  - 支持复制执行报告。
- [ ] 执行与任务中心。
  - 每项执行状态：待执行、成功、失败、跳过、已回退。
  - 支持失败后继续/停止策略。
  - 支持复制执行报告。
- [ ] Playwright 主流程。
  - 差异 -> 沙箱应用 -> 真实环境晋级 -> 历史回退。

#### P2

- [ ] 环境晋级策略模板。
  - 真实环境必须先经过指定沙箱环境。
  - 沙箱环境可配置为禁止发布。
  - Nacos 不天然支持“发布但不生效”，UI 上明确限制，不假装支持。
- [ ] 操作历史导出 JSON。

---

### 2.6 `v1.5.0`: Apollo 只读第一阶段

**版本性质**: MINOR
**目标**: 支持 Apollo OpenAPI 的连接、浏览、读取、diff、审计。第一阶段只做只读能力，不做发布/回滚。

#### P0

- [ ] Apollo OpenAPI 适配。
  - Portal/OpenAPI 地址。
  - token。
  - appId。
  - cluster。
  - namespaceName。
- [ ] Apollo provider 专属连接表单。
  - 不强行展示 Nacos 的 group/dataId 字段。
  - 表单明确 Apollo 的 appId、cluster、namespaceName。
  - 权限不足时允许手动输入 appId/cluster/namespaceName。
- [ ] Apollo 概念映射。
  - Nacos `namespace` 对应 Apollo 的 `appId + cluster + namespaceName` 组合。
  - Nacos `group` 在 Apollo 中没有直接等价物，可显示为 cluster 或固定为空。
  - Nacos `dataId` 可映射为 namespaceName 或单个配置集合。
  - Apollo item 的 `key/value` 天然适合审计矩阵。
- [ ] Apollo 浏览。
  - App 列表如果 API 权限允许则自动获取。
  - 权限不足时允许手动输入 appId。
  - Apollo namespace 配置项列表。
  - Apollo 配置详情。
- [ ] Apollo 参与统一 diff 和 AuditView。
  - 通用列：环境、namespace、group、dataId、key、value。
  - 原始字段：Apollo appId/cluster/namespaceName，Nacos tenant/group/dataId。
- [ ] Apollo Go client 测试。
  - 使用 `httptest.Server` 覆盖连接、浏览、读取、错误处理。

#### P1

- [ ] Apollo 审计导出。
- [ ] Apollo 错误提示。
  - 网络失败。
  - token 失效。
  - 权限不足。
  - app/cluster/namespace 不存在。
- [ ] Apollo 样例 fixture。
  - app。
  - cluster。
  - namespace。
  - item。

#### P2

- [ ] Apollo 历史版本评估。
- [ ] Apollo 发布/回滚设计，不在本版本执行。
- [ ] Apollo 灰度配置支持评估。

---

### 2.7 `v1.6.0`: WebDAV 与远端备份恢复

**版本性质**: MINOR
**目标**: 把本地备份扩展到远端存储，并提供恢复预览和 dry-run。

#### P0

- [ ] WebDAV 连接配置。
  - URL。
  - 用户名。
  - 密码/token。
  - 根目录。
- [ ] WebDAV 客户端。
  - 上传本地备份。
  - 下载远端备份。
  - 错误分类：网络、认证、权限、路径不存在、写入失败。
- [ ] WebDAV 任务接入任务中心。
  - 上传。
  - 下载。
  - 恢复预览。
- [ ] 恢复策略。
  - 单配置恢复。
  - 批量恢复。
  - 只新增缺失项。
  - 覆盖已有项。
  - 跳过已存在项。
- [ ] 恢复 dry-run。
  - 恢复前必须预览差异。
  - 恢复到生产环境必须走生产确认流程。
  - 禁止跳过 dry-run 直接恢复。
- [ ] WebDAV 测试。
  - 客户端单元测试。
  - 恢复计划测试。
  - 任务失败聚合测试。

#### P1

- [ ] WebDAV 凭据安全存储。
- [ ] 远端备份列表缓存。
- [ ] Playwright 覆盖备份、恢复预览、dry-run 禁止误执行。

#### P2

- [ ] 定时备份评估。
- [ ] 多远端备份目标评估。

---

### 2.8 `v2.0.0`: 多配置中心治理平台化

**版本性质**: MAJOR
**目标**: Provider 抽象稳定后，将 ConfScope 从 Nacos 优先的桌面工具升级为多配置中心治理工具。

#### P0

- [ ] 多 provider 聚合视图。
  - Nacos。
  - Apollo。
  - local。
  - WebDAV 备份来源。
- [ ] 跨配置中心审计矩阵。
- [ ] 跨配置中心环境应用策略。
- [ ] 本地数据结构迁移策略。
  - 连接配置。
  - 代理配置。
  - 操作历史。
  - 忽略规则。
  - 备份索引。
- [ ] 安全模型升级。
  - 凭据迁移。
  - 操作历史脱敏。
  - 导出默认脱敏。

#### P1

- [ ] Consul KV。
  - KV 浏览。
  - token 认证。
  - datacenter 选择。
  - key prefix 过滤。
  - 与 Nacos/Apollo/local 的 diff 和 AuditView。
- [ ] 阿里云 MSE / Nacos 企业场景。
  - AccessKey 模式。
  - 认证类型：username/password、accessKey/secretKey、token。
  - Go 后端封装签名逻辑，前端不直接处理 secret。
  - 连接测试区分认证失败、网络失败、权限不足。
- [ ] 配置治理报告。
  - 摘要。
  - 异常趋势。
  - 重复配置。
  - 导出。

#### P2

- [ ] Etcd。
- [ ] ZooKeeper。
- [ ] Kubernetes ConfigMap/Secret。
- [ ] Spring Cloud Config。
- [ ] Git 集成。
- [ ] Linux ARM64、Windows ARM64、macOS ARM64。

---

## 3. 能力池与取舍清单

本节只记录方向和边界，不作为执行状态来源。实际执行状态以第 2 节版本路线图为准。

### 3.1 参考项目结论

`ConfigCenterComparer` 值得参考的是产品模型，不是代码实现。它通过数据库读取 Apollo/Nacos 配置，把不同环境的数据整理成统一矩阵，再做一致性判断、忽略、过滤、导出和重复配置检查。

#### 值得吸收

- 多环境一致性矩阵。
- key 级配置拆解，而不是只做整文件文本 diff。
- 忽略列表，减少预期差异带来的噪音。
- 名称归一化，用于对齐不同环境命名。
- 重复配置检查。
- 审计结果导出。

#### 不建议照搬

- 不直接复制 GPL-3.0 代码，ConfScope 是 MIT，只借鉴产品思路并重写实现。
- 不优先走数据库直连，ConfScope 应优先走配置中心 OpenAPI，保留权限、历史、发布语义。
- 不固定 4 个环境，ConfScope 应支持任意数量环境，并允许用户指定基准环境。
- 不只支持 YAML，应支持 YAML、JSON、Properties、TOML，XML/TEXT 可降级处理。
- 不把比较规则写死，一致性状态、忽略规则、生产环境确认规则都应配置化。

### 3.2 UI/交互原则

- 浏览类页面采用双栏结构。
  - 左侧：连接、命名空间、配置列表、搜索。
  - 右侧：内容、历史、编辑、diff。
- 治理类页面采用矩阵结构。
  - 顶部：审计范围、基准环境、过滤条件。
  - 中部：状态摘要与矩阵表格。
  - 右侧或底部：选中行详情、diff、忽略原因。
- 设置类页面采用分组表单。
  - 基础信息。
  - 认证。
  - 网络。
  - 安全。
  - 高级。
- 长任务进入任务中心。
  - 批量审计、备份、恢复、导出、WebDAV 上传下载。
  - 展示进度、成功数、失败数、跳过数、取消状态和错误详情。
- 危险操作使用统一确认组件。
  - 普通确认。
  - 高风险二次确认。
  - 生产环境输入指定文字确认。
  - dry-run 预览后确认执行。
- 保持深色、紧凑、工程工具风格。
  - 不做营销式大卡片布局。
  - 核心工作流优先使用分栏、表格、工具栏和详情面板。

### 3.3 Go 与前端职责

- Go 后端负责：
  - OpenAPI 调用。
  - SSH 隧道。
  - 代理。
  - 文件读写。
  - WebDAV。
  - 敏感信息处理。
  - 大批量拉取时的并发控制、取消、超时、错误聚合。
- 前端负责：
  - 交互状态。
  - 表格过滤。
  - diff 展示。
  - 用户确认流程。
  - 小规模解析和展示。
- 共享算法优先放 TypeScript：
  - 配置格式识别。
  - key/value 归一化。
  - 矩阵计算。
  - 如果后续出现大数据性能瓶颈，再迁移到 Go。

### 3.4 测试策略

- Go 测试：
  - provider 抽象。
  - Nacos v1/v3 响应兼容。
  - App Wails 绑定薄测试。
  - Nacos/Apollo/WebDAV 代理配置。
  - Apollo client 使用 `httptest.Server`。
  - WebDAV client。
  - 批量任务调度：并发限制、取消、部分失败聚合、超时。
- 前端测试：
  - 纯函数优先覆盖。
  - Store 持久化和迁移逻辑必须覆盖。
  - 组件测试覆盖关键交互，不测试 mock 本身。
  - E2E 使用 mock Wails API，不依赖真实 Nacos/Apollo 服务。
- 测试数据：
  - Nacos v1 配置列表响应。
  - Nacos v3 配置列表响应。
  - YAML/JSON/Properties 样例。
  - Apollo app/cluster/namespace/item 样例。
  - 空配置、解析失败、超大配置、缺失环境、生产环境危险操作。

### 3.5 平台与发布

- 当前支持：
  - Windows amd64。
  - Linux amd64。
- macOS 暂停：
  - macOS amd64。
  - macOS arm64。
- macOS 已知问题：

```text
dyld[1744]: missing LC_UUID load command in /Users/runner/go/bin/wails
dyld[1744]: missing LC_UUID load command
Abort trap: 6
```

- 恢复 macOS 前需要：
  - 跟踪 Wails CLI v2.12.0 在 macOS GitHub Actions runner 上的问题。
  - 尝试固定 Go 版本。
  - 尝试固定或降级 Wails CLI。
  - 尝试 macOS 本机 runner。
  - 保证 CI 可重复。

---

## 4. 已完成基线

- [x] Nacos v1/v3 双版本支持。
- [x] 配置浏览与搜索。
- [x] 配置编辑与发布。
- [x] 配置删除确认。
- [x] 历史版本查看。
- [x] 历史版本回滚。
- [x] 行级 diff。
- [x] 任意两个配置来源对比。
- [x] 批量同名 dataId 对比基础能力。
- [x] 多连接管理。
- [x] 自动认证与 Token 管理。
- [x] SSH 隧道基础能力。
- [x] 配置内容标准化纯函数。
- [x] 审计矩阵计算纯函数。
- [x] 忽略规则匹配纯函数。
- [x] 名称归一化参与矩阵分组。
- [x] 应用检查更新第一版。
- [x] React 18 + TypeScript + Vite 5。
- [x] Wails 2 + Go 后端。
- [x] Vitest + React Testing Library 基础覆盖。
- [x] README、CHANGELOG、LICENSE、CREDITS。

---

**维护者**: Adsryen
**项目**: https://github.com/Adsryen/ConfScope
