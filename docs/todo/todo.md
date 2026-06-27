# ConfScope 开发待办规划

**最后更新**: 2026-06-27
**规划参考**: `/mnt/c/Users/adsry/Desktop/fsdownload/ConfigCenterComparer`
**当前定位**: Go + Wails 桌面端配置中心管理、对比、审计工具。MVP 已支持 Nacos，后续应从“单配置浏览与 diff”升级为“多环境配置治理”。

---

## 0. 参考项目结论与取舍

`ConfigCenterComparer` 值得参考的是产品模型，不是代码实现。它通过数据库读取 Apollo/Nacos 配置，把不同环境的数据整理成统一矩阵，再做一致性判断、忽略、过滤、导出和重复配置检查。

### 值得吸收

- [ ] **多环境一致性矩阵**：把 `配置中心 / 环境 / 命名空间 / group / dataId / key / value / 更新时间` 规整成统一行模型，再计算一致性状态。
- [ ] **key 级配置拆解**：将 YAML、JSON、Properties 等内容解析为 `key -> value`，而不是只做整文件文本 diff。
- [ ] **忽略列表**：允许用户把预期不同的配置项加入忽略规则，减少巡检噪音。
- [ ] **名称归一化**：支持 dataId、namespace、service/app 名称的前缀裁剪、后缀裁剪、精确替换，用于对齐不同环境命名。
- [ ] **重复配置检查**：在同一环境内找出多个服务重复配置了相同 `key + value` 的场景。
- [ ] **导出审计结果**：支持把一致性矩阵、异常项、重复项导出为 CSV/JSON。

### 不建议照搬

- [ ] **不直接复制 GPL-3.0 代码**：参考项目是 GPL-3.0，ConfScope 是 MIT，只能借鉴产品思路并重写实现。
- [ ] **不优先走数据库直连**：参考项目通过 MySQL 表读取 Apollo/Nacos，依赖内部表结构。ConfScope 应优先走配置中心 OpenAPI，保留权限、历史、发布语义。
- [ ] **不固定 4 个环境**：参考项目偏 `PRO/PRE/TEST/DEV`，ConfScope 应支持任意数量环境，并允许用户指定基准环境。
- [ ] **不只支持 YAML**：ConfScope 当前已有多格式识别能力，后续应支持 YAML、JSON、Properties、TOML；XML/TEXT 可做降级处理。
- [ ] **不把比较规则写死**：一致性状态、忽略规则、生产环境确认规则都应配置化。

---

## 1. 总体架构方向

当前项目已经有 `internal/nacos`、`src/api/nacos.ts`、`DiffView`、`ConfigBrowser`。下一阶段应先抽象“配置中心通用模型”，否则 Apollo、Consul、备份、本地模式、审计矩阵都会继续绑死在 Nacos 上。

### 1.1 配置中心 Provider 抽象

- [ ] **设计 Go 后端通用接口**
  - `ListNamespaces`
  - `ListConfigs`
  - `GetConfig`
  - `PublishConfig`
  - `DeleteConfig`
  - `ListHistory`
  - `GetHistoryDetail`
  - `TestConnection`
- [ ] **定义统一领域模型**
  - `ProviderType`: `nacos | apollo | consul | local`
  - `ConnectionProfile`: 连接、认证、代理、SSH、环境标签、安全等级
  - `ConfigRef`: provider、connectionId、namespace、group、dataId、key
  - `ConfigDocument`: 原始内容、格式、更新时间、版本、来源
  - `ConfigEntry`: 拆解后的 key/value/path/type
- [ ] **保留 Nacos 现有能力，但迁移到 provider 模型**
  - 先做适配层，不重写所有业务。
  - 前端仍可通过 `src/api/nacos.ts` 兼容过渡，新增通用 `src/api/configCenter.ts`。

### 1.2 前端模块边界

- [ ] `ConfigBrowser` 保持负责浏览和编辑单个配置。
- [ ] `DiffView` 保持负责两个来源或批量 dataId 的文本级/key 级 diff。
- [ ] 新增 `AuditView`，负责多环境一致性矩阵、过滤、忽略、导出。
- [ ] 新增 `BackupView`，负责云端/本地/WebDAV 备份恢复。
- [ ] 新增 `SettingsView`，集中管理代理、安全确认、名称归一化、忽略规则。
- [ ] 顶层导航从“顶部双模式按钮”升级为“左侧主导航 + 顶部上下文工具栏”。
  - 左侧主导航承载：浏览、对比、审计、备份、任务、设置。
  - 顶部工具栏只展示当前页面相关的连接、命名空间、筛选、刷新等操作。
  - 保持深色、紧凑、工程工具风格，不做营销式大卡片布局。

### 1.3 UI/交互架构方向

- [ ] **浏览类页面采用双栏结构**
  - 左侧：连接、命名空间、配置列表、搜索。
  - 右侧：内容、历史、编辑、diff。
- [ ] **治理类页面采用矩阵结构**
  - 顶部：审计范围、基准环境、过滤条件。
  - 中部：状态摘要与矩阵表格。
  - 右侧或底部：选中行详情、diff、忽略原因。
- [ ] **设置类页面采用分组表单**
  - 基础信息。
  - 认证。
  - 网络。
  - 安全。
  - 高级。
- [ ] **长任务采用任务中心**
  - 批量审计、备份、恢复、导出、WebDAV 上传下载都进入任务中心。
  - 展示进度、成功数、失败数、跳过数、可取消状态和错误详情。
- [ ] **危险操作采用统一确认组件**
  - 普通确认。
  - 高风险二次确认。
  - 生产环境输入指定文字确认。
  - dry-run 预览后确认执行。
- [ ] **状态色体系统一**
  - 一致。
  - 部分一致。
  - 不一致。
  - 缺失。
  - 无法解析。
  - 已忽略。
  - 危险环境。

### 1.4 Go 与前端职责取舍

- [ ] **Go 后端负责**
  - OpenAPI 调用、SSH 隧道、代理、文件读写、WebDAV、敏感信息处理。
  - 大批量拉取时的并发控制、取消、超时、错误聚合。
- [ ] **前端负责**
  - 交互状态、表格过滤、diff 展示、用户确认流程。
  - 小规模解析和展示可以留在前端。
- [ ] **共享算法优先放 TypeScript**
  - 配置格式识别、key/value 归一化、矩阵计算先放前端，迭代快。
  - 如果后续出现大数据性能瓶颈，再迁移到 Go。

---

## 2. 高优先级：审计矩阵与批量治理

这是最应该从 `ConfigCenterComparer` 吸收的核心能力。目标是让 ConfScope 从“打开两个配置看 diff”升级为“批量发现环境差异”。

### 2.1 配置内容标准化

- [x] **实现 `normalizeConfig(content, format)`**
  - YAML：使用现有 `yaml` 依赖解析，输出点路径 key。
  - JSON：递归展开对象；数组默认作为整体值，后续再考虑数组下标策略。
  - Properties：按 `key=value` / `key: value` 解析。
  - TOML：可先按文本降级，后续再引入解析。
  - XML/TEXT：暂不拆 key，只保留整文档 hash 和文本 diff。
- [x] **输出统一 `ConfigEntry`**
  - `key`
  - `value`
  - `valueType`
  - `sourcePath`
  - `parseStatus`
  - `parseError`
- [x] **补测试**
  - YAML 嵌套对象。
  - JSON 嵌套对象。
  - Properties 注释与空行。
  - 解析失败降级。

### 2.2 多环境一致性矩阵

- [ ] **新增 AuditView**
  - 选择多个连接作为环境。
  - 每个环境可选择 namespace、group、dataId 过滤条件。
  - 支持同名 dataId 批量匹配。
  - 支持按基准环境比较。
- [ ] **AuditView UI 布局**
  - 顶部条件栏：环境选择、namespace/group/dataId 范围、基准环境、比较模式。
  - 状态摘要条：总数、一致、不一致、缺失、无法解析、已忽略。
  - 主矩阵表格：`dataId / key / 状态 / 各环境值 / 更新时间`。
  - 详情面板：展示当前行在各环境的原始值、差异、来源链接。
- [x] **生成矩阵行**
  - 主键：`normalizedName + namespace + group + dataId + key`
  - 列：每个环境的 value、更新时间、存在状态。
  - 状态：`一致 / 部分一致 / 不一致 / 缺失 / 无法解析 / 已忽略`
- [ ] **矩阵结果接入 UI**
  - 当前已完成 `buildAuditMatrix` 纯函数，AuditView 还未接入。
  - UI 接入时复用现有状态枚举，不在组件里重复写判断逻辑。
  - 状态摘要、过滤、导出都应基于同一份矩阵结果派生。
- [ ] **过滤与排序**
  - 仅看不一致。
  - 仅看缺失。
  - 仅看无法解析。
  - 隐藏已忽略。
  - 按 dataId、key、状态、环境排序。
- [ ] **矩阵行跳转**
  - 点击某行可打开对应 dataId 的详细 diff。
  - 可从矩阵直接复制 key/value。
- [ ] **矩阵大数据交互**
  - 使用虚拟滚动，避免上万行卡顿。
  - 支持列冻结：固定 `dataId/key/status`。
  - 支持列显隐：环境列、更新时间列、原始名称列。
  - 支持保存过滤条件。

### 2.3 忽略规则

- [ ] **新增本地忽略规则存储**
  - 初期存 localStorage。
  - 后续迁移到 Wails 应用数据目录，便于备份和跨设备同步。
- [ ] **规则字段**
  - providerType
  - namespace pattern
  - group pattern
  - dataId pattern
  - key pattern
  - reason
  - createdAt
- [ ] **匹配策略**
  - 精确匹配优先。
  - 支持 `*` 通配。
  - 暂不支持复杂正则，避免误伤。
- [x] **忽略规则纯函数匹配**
  - 已支持 namespace、group、dataId、key、providerType 的 `*` 通配匹配。
  - 已支持命中后把矩阵行状态标记为 `ignored` 并保留 reason。
- [ ] **UI 行为**
  - 矩阵行右键加入忽略。
  - 忽略规则管理列表。
  - 可临时显示已忽略项。

### 2.4 名称归一化

- [ ] **新增对比前名称处理规则**
  - 前缀裁剪。
  - 后缀裁剪。
  - 精确替换。
  - 大小写是否敏感。
- [ ] **应用范围**
  - dataId。
  - namespace 展示名。
  - Apollo appId / cluster / namespace。
  - 本地备份文件路径。
- [ ] **配置方式**
  - 按连接组保存。
  - 在 AuditView 里可临时启用/禁用。
- [ ] **安全约束**
  - 默认不自动归一化，用户显式开启。
  - 归一化后需要展示原始名称，避免误判。
- [x] **矩阵计算支持名称归一化回调**
  - 已支持对 dataId 做归一化后再分组。
  - 已保留各环境的 originalDataIds，供 UI 展示原始名称。

### 2.5 重复配置检查

- [ ] **同环境重复检查**
  - 在同一个环境内，按 `key + normalizedValue` 分组。
  - 只展示出现次数 >= 2 的项。
  - 过滤空值、明显默认值可配置。
- [ ] **跨环境重复检查**
  - 同一 key/value 是否在多个环境重复出现。
  - 用于发现“环境差异本应存在但被复制一致”的情况。
- [ ] **输出**
  - 重复 key。
  - 重复 value。
  - 出现在哪些 dataId / namespace / group。
  - 可导出 CSV。

---

## 3. 高优先级：连接、安全与运行环境

这些能力直接影响生产可用性，优先级高于新增更多配置中心。

### 3.1 SSH 隧道

- [x] 已有基础 SSH 隧道能力。
- [ ] 补齐连接管理 UI 的状态展示：已连接、本地端口、失败原因。
- [ ] SSH 配置在连接管理中独立成“网络”分组。
- [ ] SSH 状态在连接列表与顶部上下文栏显示。
- [ ] 支持手动重连和断开。
- [ ] 连接删除或修改时自动关闭旧隧道。
- [ ] 批量审计时复用隧道，避免重复创建。
- [ ] 补 Go 单元测试或集成测试边界：端口占用、认证失败、StopAll。

### 3.2 全局代理

- [ ] 新增全局代理设置。
  - HTTP proxy。
  - HTTPS proxy。
  - no_proxy。
- [ ] Go HTTP client 支持读取代理配置。
- [ ] 每个连接允许覆盖全局代理。
- [ ] UI 标识当前连接是否走代理。
- [ ] 代理配置放入 SettingsView 的“网络”分组。

### 3.3 生产/沙箱安全确认

- [ ] 连接增加安全等级。
  - 普通。
  - 测试。
  - 预发。
  - 生产。
  - 沙箱。
- [ ] 高风险操作二次确认。
  - 发布配置。
  - 删除配置。
  - 回滚配置。
  - 批量操作。
- [ ] 生产环境要求人工输入确认文本。
  - 例如输入 `确认发布到生产`。
  - 确认文案可在连接配置中设置。
- [ ] UI 中对生产/沙箱连接做持续可见标识。
  - 顶部连接选择器显示安全等级。
  - 发布、删除、恢复按钮使用危险态样式。
  - 批量操作预览页标出将影响的生产项数量。
- [ ] 沙箱环境策略。
  - 可配置为禁止发布。
  - 可配置为发布后不立即生效，如果目标配置中心支持该语义。
  - Nacos 不天然支持“发布但不生效”，需要在 UI 上明确限制，不假装支持。

### 3.4 敏感信息处理

- [ ] 当前连接密码存在 localStorage，需规划迁移。
- [ ] Go 侧优先使用系统 keychain/credential store；做不到时至少应用数据目录加密存储。
- [ ] 导出配置时默认不导出密码、token、私钥。
- [ ] 日志中屏蔽 password、accessKey、secretKey、token。

---

## 4. 高优先级：导入、导出、备份、恢复

这是用户已有备注里的重点，也能承接审计矩阵输出。

### 4.1 导出

- [ ] 单配置导出。
  - 原始内容。
  - 元信息 JSON。
- [ ] 审计矩阵导出。
  - CSV：适合发给团队审阅。
  - JSON：适合后续导入或自动化处理。
- [ ] 差异导出。
  - 文本 diff。
  - key/value 差异 JSON。
- [ ] 重复配置检查结果导出。

### 4.2 本地备份模式

- [ ] 定义本地备份目录结构。
  - provider。
  - connection name。
  - namespace。
  - group。
  - dataId。
  - metadata.json。
- [ ] 支持从云端拉取一次快照保存到本地。
- [ ] 支持本地快照作为一个 `local` provider 参与浏览和对比。
- [ ] 支持同环境多配置位置对比。
  - 云端 vs 本地备份。
  - 本地备份 A vs 本地备份 B。
  - 同一连接不同 namespace/group。
- [ ] 新增 BackupView。
  - 快照列表。
  - 快照详情。
  - 云端/本地/WebDAV 来源标识。
  - 快照与当前云端的差异入口。

### 4.3 WebDAV 备份与恢复

- [ ] 新增 WebDAV 连接配置。
  - URL。
  - 用户名。
  - 密码/token。
  - 根目录。
- [ ] 支持上传本地备份到 WebDAV。
- [ ] 支持从 WebDAV 下载备份到本地。
- [ ] 恢复前必须预览差异。
- [ ] WebDAV 上传、下载、恢复进入任务中心。
- [ ] 恢复到生产环境必须走生产确认流程。

### 4.4 导入/恢复策略

- [ ] 单配置恢复。
- [ ] 批量恢复。
- [ ] 只新增缺失项。
- [ ] 覆盖已有项。
- [ ] 跳过已存在项。
- [ ] dry-run 模式：只生成计划，不执行发布。

---

## 5. 中优先级：Apollo 配置中心

当前 ConfScope 还不支持 Apollo。参考项目支持 Apollo，但它走数据库；ConfScope 应优先走 Apollo OpenAPI。

### 5.1 是否做

- [ ] **做 Apollo OpenAPI 适配**：符合 ConfScope 多配置中心定位。
- [ ] **暂不做 Apollo 数据库直连**：除非 OpenAPI 无法满足历史或权限场景。
- [ ] **暂不追求 Apollo 全量管理后台能力**：先支持浏览、获取、diff、审计、导出。

### 5.2 Apollo 概念映射

- [ ] Nacos `namespace` 对应 Apollo 的 `appId + cluster + namespaceName` 组合。
- [ ] Nacos `group` 在 Apollo 中没有直接等价物，可显示为 cluster 或固定为空。
- [ ] Nacos `dataId` 可映射为 Apollo namespaceName 或单个配置集合。
- [ ] Apollo item 的 `key/value` 天然适合审计矩阵。

### 5.3 第一阶段能力

- [ ] Apollo 连接管理。
  - Portal/OpenAPI 地址。
  - token。
  - appId。
  - cluster。
  - namespace。
- [ ] Apollo 连接 UI 使用 provider 专属表单。
  - 不强行展示 Nacos 的 group/dataId 字段。
  - 表单中明确 Apollo 的 appId、cluster、namespaceName。
  - 权限不足时提供手动输入 appId/cluster/namespaceName 的模式。
- [ ] Apollo 配置浏览。
  - App 列表如果 API 权限允许则自动获取。
  - 权限不足时允许手动输入 appId。
- [ ] Apollo 浏览 UI 使用 Apollo 概念命名。
  - App。
  - Cluster。
  - Namespace。
  - Item key/value。
- [ ] Apollo namespace 配置项列表。
- [ ] Apollo 配置详情。
- [ ] Apollo 与 Nacos、本地备份参与统一 diff 和 AuditView。
- [ ] AuditView 中统一展示通用列，同时保留 provider 原始字段。
  - 通用列：环境、namespace、group、dataId、key、value。
  - 原始字段：Apollo appId/cluster/namespaceName，Nacos tenant/group/dataId。

### 5.4 第二阶段能力

- [ ] Apollo 历史版本。
- [ ] Apollo 发布/回滚。
- [ ] Apollo 灰度配置支持。
- [ ] Apollo namespace 创建/删除。
- [ ] Apollo 配置导入导出。

### 5.5 风险

- [ ] Apollo OpenAPI 权限和部署差异较大，需要清晰错误提示。
- [ ] Apollo 概念与 Nacos 不一致，UI 不能强行套 `group/dataId`。
- [ ] 发布 Apollo 配置通常涉及修改 item + release，应单独设计确认流程。

---

## 6. 中优先级：Consul 与其他配置中心

### 6.1 Consul

- [ ] 支持 Consul KV 浏览。
- [ ] 支持 token 认证。
- [ ] 支持 datacenter 选择。
- [ ] 支持 key prefix 过滤。
- [ ] 支持 Consul KV 与 Nacos/Apollo/local 的 diff。
- [ ] 暂不优先做 Consul session、watch、service discovery 管理。

### 6.2 后续候选

- [ ] Etcd。
- [ ] ZooKeeper。
- [ ] Kubernetes ConfigMap/Secret。
- [ ] Spring Cloud Config。

### 6.3 取舍

- [ ] 只有当 provider 抽象稳定后再新增第三个配置中心。
- [ ] 每个 provider 先满足浏览、读取、diff、审计，再考虑写入。
- [ ] 写入能力必须接入安全确认机制。

---

## 7. 中优先级：阿里云 MSE / Nacos 企业场景

- [ ] 支持阿里云 MSE Nacos AccessKey 模式。
- [ ] 连接配置增加认证类型。
  - username/password。
  - accessKey/secretKey。
  - token。
- [ ] Go 后端封装签名逻辑，前端不直接处理 secret。
- [ ] 日志脱敏。
- [ ] 连接测试需要区分认证失败、网络失败、权限不足。
- [ ] 文档中说明 MSE 与自建 Nacos 的能力差异。

---

## 8. 中优先级：UI/UX 与大数据体验

### 8.0 主布局演进

- [ ] 从顶部双模式切换升级为左侧主导航。
- [ ] 主导航支持折叠，只显示图标时仍有 tooltip。
- [ ] 顶部栏改为当前工作区上下文操作区。
- [ ] 保留当前 VSCode Dark 风格，但统一按钮、表格、状态标签、危险态样式。
- [ ] 不使用卡片堆叠承载核心工作流，优先使用分栏、表格、工具栏和详情面板。

### 8.1 表格体验

- [ ] AuditView 使用虚拟列表或表格虚拟滚动。
- [ ] 支持列显示/隐藏。
- [ ] 支持列宽调整。
- [ ] 支持复制单元格、复制整行、复制异常摘要。
- [ ] 支持保存过滤条件。
- [ ] 状态列使用固定视觉语言。
  - 一致：绿色。
  - 部分一致：黄色。
  - 不一致：红色。
  - 缺失：橙色或红色描边。
  - 无法解析：灰色加错误标识。
  - 已忽略：低对比度。

### 8.1.1 连接管理体验

- [ ] 连接管理从单页长表单升级为分组表单或标签页。
- [ ] 支持 provider 类型选择。
- [ ] 根据 provider 类型切换字段。
- [ ] 基础信息、认证、网络、安全、高级分区。
- [ ] 连接列表显示 provider、环境标签、安全等级、SSH/代理状态。
- [ ] 测试连接结果展示更细：网络可达、认证成功、权限范围、版本信息。

### 8.2 搜索

- [ ] 配置列表 dataId 搜索已支持，继续优化。
- [ ] 支持配置内容全文搜索。
- [ ] 支持 key 搜索。
- [ ] 支持 value 搜索。
- [ ] 支持跨连接搜索。

### 8.3 Diff

- [ ] 当前行级 diff 保留。
- [ ] DiffView 保持深度对比定位，不继续承接审计矩阵职责。
- [ ] key/value diff 与审计矩阵打通。
- [ ] 支持忽略空白、忽略顺序、忽略注释。
- [ ] 大文件 diff 增加性能保护：超过阈值提示用户选择模式。
- [ ] 批量 diff 结果增加汇总区。
  - 总数。
  - 一致数量。
  - 有差异数量。
  - 失败数量。
  - 可快速跳到下一个差异项。

### 8.3.1 任务中心

- [ ] 新增任务中心入口。
- [ ] 批量审计、批量导出、备份、恢复、WebDAV 上传下载统一进入任务中心。
- [ ] 每个任务展示名称、范围、进度、状态、开始时间、耗时。
- [ ] 失败任务支持展开错误详情和复制错误。
- [ ] 可取消的任务显示取消按钮。
- [ ] 任务完成后可跳转到结果页。

### 8.3.2 危险操作体验

- [ ] 统一危险操作确认弹窗。
- [ ] 生产环境操作要求输入确认文本。
- [ ] 批量操作先展示影响范围，再允许执行。
- [ ] 恢复操作必须先展示 dry-run 差异计划。
- [ ] 危险操作按钮文案必须具体，例如“发布到生产”“删除 12 个配置”，避免只写“确定”。

### 8.4 多语言

- [x] 已有多语言基础。
- [ ] 补齐新增页面文案。
- [ ] 检查所有硬编码中文/英文。
- [ ] 语言切换不应重置当前工作区状态。

---

## 9. 中优先级：日志、错误处理与可观测性

- [ ] 增加应用日志查看页面。
- [ ] 日志页面接入主导航的“任务/日志”区域。
- [ ] Go 后端统一错误类型。
  - 网络错误。
  - 认证错误。
  - 权限错误。
  - 解析错误。
  - 写入失败。
- [ ] 批量任务展示进度。
- [ ] 批量任务支持取消。
- [ ] 批量任务结束后展示成功、失败、跳过数量。
- [ ] 错误详情可复制。
- [ ] 日志默认脱敏。

---

## 10. 测试与工程质量

当前自动化测试已经补上第一层基线：Go 后端覆盖 Nacos client 与 SSH manager/tunnel，前端已引入 Vitest 并覆盖 diff、format、keys、validate、normalize、audit、highlight、toast、connection store 等纯逻辑/状态模块。下一阶段应优先补 React 组件测试与 Playwright Web E2E，否则 AuditView、BackupView、连接管理升级后仍会依赖大量人工回归。

### 10.1 Go 测试

- [x] 已有 `internal/nacos/client_test.go`。
- [x] Nacos client 基础行为测试。
- [x] SSH manager 测试。
- [x] SSH tunnel 基础测试。
- [ ] provider 抽象加单元测试。
- [ ] Nacos v1/v3 响应兼容测试。
- [ ] App Wails 绑定层加薄测试。
  - 参数透传。
  - 错误返回。
  - provider 分发。
- [ ] 代理配置测试。
- [ ] WebDAV 客户端测试。
- [ ] Apollo client 使用 `httptest.Server` 模拟 Portal/OpenAPI。
- [ ] 批量任务调度测试。
  - 并发限制。
  - 取消。
  - 部分失败聚合。
  - 超时。

### 10.2 前端测试

- [x] 引入 Vitest。
- [x] 测试 `normalizeConfig`。
- [x] 测试一致性矩阵状态计算。
- [x] 测试忽略规则匹配。
- [x] 测试名称归一化。
- [x] 测试 diff 统计。
- [x] 测试格式识别。
- [x] 测试 key 提取。
- [x] 测试发布前格式校验。
- [x] 测试语法高亮兜底与逐行缓存。
- [x] 测试 toast 发布订阅与自动移除。
- [x] 测试连接本地存储的读取、新增、更新、删除、SSH 配置保存。
- [ ] 测试导出数据生成。
  - CSV 转义。
  - JSON 字段完整性。
  - 敏感字段默认剔除。
- [ ] 测试危险操作确认逻辑。
  - 普通环境。
  - 生产环境输入确认文本。
  - dry-run 未完成时禁止执行。

### 10.2.1 React 组件测试

- [ ] 引入 React Testing Library。
- [ ] `ConfigBrowser` 测试。
  - 搜索。
  - 翻页。
  - 打开配置。
  - 编辑脏状态拦截。
- [ ] `DiffPanel` 测试。
  - 统计显示。
  - 仅显示变更。
  - 无差异状态。
- [ ] `ConnectionManager` 测试。
  - provider 切换字段。
  - SSH/代理/安全分组。
  - 测试连接结果展示。
- [ ] `AuditView` 测试。
  - 过滤状态。
  - 行选择。
  - 忽略规则。
  - 跳转 diff。

### 10.2.2 端到端测试

- [ ] 引入 Playwright，先覆盖 Web 模式。
  - 只测前端路由、交互、mock API，不直接启动 Wails 桌面壳。
- [ ] 使用 mock 的 Wails API。
  - 模拟连接列表。
  - 模拟 Nacos namespace/config/history。
  - 模拟错误和超时。
- [ ] 覆盖核心用户流程。
  - 新增连接。
  - 浏览配置。
  - 查看历史。
  - 两配置 diff。
  - 审计矩阵过滤。
  - 导出审计结果。
- [ ] 桌面壳冒烟测试单独评估。
  - 构建成功。
  - 应用启动。
  - 首页无白屏。
  - 不把所有业务流程都压到桌面 E2E。

### 10.2.3 测试数据与 Mock 策略

- [ ] 建立 `src/test/fixtures`。
  - Nacos v1 配置列表响应。
  - Nacos v3 配置列表响应。
  - YAML/JSON/Properties 样例。
  - Apollo app/cluster/namespace/item 样例。
- [ ] 建立 mock API 层。
  - 前端组件测试不访问真实 Wails 绑定。
  - E2E 测试不依赖真实 Nacos/Apollo 服务。
- [ ] 建立回归样例。
  - 空配置。
  - 解析失败。
  - 超大配置。
  - 缺失环境。
  - 值相同但顺序不同。
  - 生产环境危险操作。

### 10.3 代码质量

- [ ] 配置 ESLint。
- [ ] 配置 Prettier。
- [ ] TypeScript strict 模式评估并逐步开启。
- [ ] 移除未使用代码。
- [ ] 统一 import 路径。

### 10.4 CI/CD

- [ ] CI 增加 Go test。
- [ ] CI 增加前端 test。
- [ ] CI 增加 Playwright Web E2E。
- [ ] CI 增加 lint。
- [ ] CI 增加 `npm run build:web`，确保前端可构建。
- [ ] Windows/Linux 构建继续保持。
- [ ] macOS 构建问题单独跟踪。

---

## 11. 平台与发布

### 11.1 当前支持

- [x] Windows amd64。
- [x] Linux amd64。
- [ ] macOS amd64 暂停。
- [ ] macOS arm64 暂停。

### 11.2 macOS 问题

**错误信息**:

```text
dyld[1744]: missing LC_UUID load command in /Users/runner/go/bin/wails
dyld[1744]: missing LC_UUID load command
Abort trap: 6
```

- [ ] 跟踪 Wails CLI v2.12.0 在 macOS GitHub Actions runner 上的问题。
- [ ] 尝试固定 Go 版本。
- [ ] 尝试固定或降级 Wails CLI。
- [ ] 尝试 macOS 本机 runner。
- [ ] 恢复 macOS 前先保证 CI 可重复。

### 11.3 未来平台

- [ ] Linux ARM64。
- [ ] Windows ARM64。
- [ ] macOS ARM64。

---

## 12. 分阶段里程碑

### v1.1：Nacos 审计增强

- [ ] 主布局支持左侧主导航骨架。
- [x] 配置内容标准化。
- [ ] AuditView 多环境一致性矩阵。
- [ ] AuditView 顶部条件栏、状态摘要、虚拟矩阵表格、详情面板。
- [x] 忽略规则纯函数匹配。
- [x] 名称归一化参与矩阵分组。
- [ ] 审计结果导出 CSV/JSON。
- [ ] DiffView 与 AuditView 职责拆分，批量治理入口迁移到 AuditView。
- [x] 引入 Vitest，覆盖标准化、矩阵状态、忽略规则、名称归一化。
- [x] 前端核心算法测试第一批。
- [ ] AuditView 接入现有 `normalizeConfig` / `buildAuditMatrix`。
- [ ] 前端核心算法测试补齐导出、危险确认与过滤派生逻辑。

### v1.2：备份与安全

- [ ] 连接管理升级为 provider 感知的分组表单。
- [ ] 本地备份 provider。
- [ ] BackupView 快照列表、详情、差异入口。
- [ ] 云端到本地快照。
- [ ] 本地快照浏览与 diff。
- [ ] 生产/沙箱安全确认。
- [ ] 危险操作统一确认组件。
- [ ] 全局代理。
- [ ] SSH 隧道状态完善。
- [ ] 任务中心基础能力。
- [ ] React 组件测试覆盖连接管理、DiffPanel、BackupView 基础交互。

### v1.3：Apollo 第一阶段

- [ ] provider 抽象落地。
- [ ] Apollo OpenAPI 连接。
- [ ] Apollo provider 专属连接表单。
- [ ] Apollo 浏览与读取。
- [ ] Apollo 浏览页使用 appId、cluster、namespace、item key/value 概念。
- [ ] Apollo 参与 diff 和 AuditView。
- [ ] AuditView 同时展示通用模型字段与 Apollo 原始字段。
- [ ] Apollo 审计导出。
- [ ] Apollo Go client 使用 `httptest.Server` 覆盖连接、浏览、读取、错误处理。

### v1.4：WebDAV 与恢复

- [ ] WebDAV 备份上传/下载。
- [ ] WebDAV 任务接入任务中心。
- [ ] 恢复预览。
- [ ] 恢复 dry-run 计划 UI。
- [ ] dry-run 恢复计划。
- [ ] 单配置恢复。
- [ ] 批量恢复。
- [ ] Playwright 覆盖备份、恢复预览、dry-run 禁止误执行。

### v2.0：多配置中心治理

- [ ] Consul KV。
- [ ] 多 provider 聚合视图。
- [ ] 跨配置中心聚合视图。
- [ ] 重复配置检查增强。
- [ ] 配置治理报告。
- [ ] 治理报告页面支持摘要、异常趋势、导出。
- [ ] Git 集成评估。

---

## 13. 已完成

- [x] Nacos v1/v3 双版本支持。
- [x] 配置浏览与搜索。
- [x] 历史版本查看。
- [x] 智能配置对比：行级 diff。
- [x] 任意两个配置来源对比。
- [x] 批量同名 dataId 对比基础能力。
- [x] 多连接管理。
- [x] 自动认证与 Token 管理。
- [x] SSH 隧道基础能力。
- [x] React 18 + TypeScript + Vite 5。
- [x] Wails 2 + Go 后端。
- [x] README、CHANGELOG、LICENSE、CREDITS。

---

## 14. 近期建议执行顺序

1. [x] 先实现 `normalizeConfig` 与测试。
2. [x] 再实现矩阵状态计算与忽略规则匹配。
3. [x] 引入 Vitest，把核心纯函数测试跑进 `npm test`。
4. [ ] 先落左侧主导航骨架，给 AuditView、BackupView、SettingsView、任务中心预留入口。
5. [ ] 新增 AuditView，只支持 Nacos，不引入 Apollo。
6. [ ] AuditView 接入 `normalizeConfig` / `buildAuditMatrix`，先跑通多环境只读审计。
7. [ ] 做审计导出。
8. [ ] 引入 React Testing Library，覆盖 AuditView/连接管理/DiffPanel 的关键交互。
9. [ ] 引入 Playwright Web E2E，用 mock Wails API 覆盖浏览、diff、审计主流程。
10. [ ] 抽 provider 接口，把 Nacos 迁移进去。
11. [ ] 连接管理升级为 provider 感知分组表单。
12. [ ] 开始 Apollo OpenAPI 第一阶段。

这个顺序的原因：先把参考项目最有价值的“审计矩阵”在现有 Nacos 能力上跑通，再抽象 provider。否则一开始就抽象 Apollo/Consul，容易为了未知需求过度设计。

---

**维护者**: Adsryen
**项目**: https://github.com/Adsryen/ConfScope
