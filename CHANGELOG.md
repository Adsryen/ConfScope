# Changelog

本项目的所有显著更改都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

<!--
自 1.9.2 起本文件与 tag 同步维护：发版前必须先把该版本的段落写好（scripts/verify-release-version.sh
会校验 tag / package.json / 本文件顶部三处版本一致）。1.6.0 ~ 1.6.4 的发布说明散落在 GitHub Release，
未在此回填。
-->

## [1.9.2] - 2026-10-20

### Added
- 配置浏览的代码视图支持行号显示、搜索命中词标红并整行高亮、右侧类 VSCode 缩略图（可点可拖），以及就地 `Ctrl+F` 文件内查找（Enter/Shift+Enter/F3 逐处跳转，Aa 区分大小写与 `ab|` 全词各自收窄命中）。
- 编辑态同样补齐行号、文件内查找与右侧缩略图，滚轮落在缩略图或查找控件上照样滚正文。
- 配置对比的并排差异与历史「高亮变更」正文接入文件内查找层，命中标红与行号变红共用一份实现。
- 历史页的视图切换改成两颗恒定命名的分段控件，按钮文案不再与所在视图相反。
- 四个直接写入配置的入口统一改为走变更计划；计划执行成功后向保活视图广播写后失效，界面反映服务端真值。
- 设置页新增数据位置展示并可直接打开对应文件夹；端口等数字输入加约束并防止滚轮误改。
- 轻提示可读、可关、可悬停暂停，并能压住报错弹框；审计/历史/备份页切走再回来不再丢筛选与滚动位置。

### Fixed
- 发布产物的版本号从未注入成功：构建拆分 Go 主包后（`77fa451`），Release 工作流里的 `-X main.appVersion` 已打不到变量真实所在的包，而 Go 链接器对不存在的注入目标静默忽略，于是自 v1.9.1 起所有安装包的版本号都是 `dev`，被比较逻辑当成 `0.0.0`——关于页显示 `vdev`，「检查更新」永远提示有新版本。现修正注入路径，后台自动检查改为只在版本号可比时发起，本地构建脚本也一并注入 `git describe` 版本。
- 主数据文件（`app-data/confscope-data.json`）自 2026-09-05 起实际未被写入：前端一处手写的 Wails 绑定命名空间停留在重构前的 `go.main.App`，取不到绑定即静默降级为只跑 localStorage。现绑定读取收进唯一出口，落盘、首启水合与损坏隔离恢复生效。
- 配置对比的来源不再有两套状态互相覆盖，重启后不会丢掉用户实际比过的那一对。
- 审计页配置矩阵默认窗口不再塌成 0 行，执行审计工具栏不再把面板挤变形。
- 跨类样式覆盖改为按特异度决胜，清掉一批从未生效的声明与重复选择器；窄屏堆叠、危险按钮 hover/disabled 反馈、模态与弹层层级不再赌文档顺序。
- 变更计划里的引擎报错翻成界面语言可读的文案，`$` 序列不再被插值吞掉，库层抛给用户的提示跟随界面语言。
- 只符号的按钮补齐可访问名称，加载中与进度条、保存/测试结果可被读屏读出；弹层获得 dialog 语义与焦点陷阱，嵌套确认框不再被外层抢走 Esc/Tab。
- 编辑区 `Ctrl+S` 保存配置内容而不再弹出原生「保存网页」；输入法组合态与弹框回车劫持收口；关闭新建配置前先确认，半篇手写 YAML 不再点一下遮罩就丢。
- 关于页外链改走系统浏览器，不再是点了没反应的死按钮；被省略号截断的文本悬停可见全文且可复制。

### Engineering
- `tests/ux` 静态守卫扩到 75 个文件 / 599 条用例：新增查找层唯一实现、Wails 绑定命名空间唯一事实源、构建期注入符号必须打中 Go 声明、后台更新检查必须先验版本号可比等守卫，每条都带变异自检。
- retest 真机永久回归新增对比正文/高亮变更查找（DF、DF2）、主数据文档绑定链路（DD）、视图切换与滚动归零（V、D）等组。
- 发布链路加校验脚本 `scripts/verify-release-version.sh`：tag、`package.json`、本文件顶部版本三者一致，并实测 `-ldflags` 注入能落进 `internal/app`。

## [1.9.1] - 2026-09-07

### Added
- 前端主数据迁出 localStorage：以数据文件为唯一事实源，localStorage 降级为热缓存，损坏时隔离副本并回退。
- 内容批量替换支持选择来源连接作为目标，可原地批量改值。
- 配置对比工作流的 stepper 支持点击导航（相邻前进、任意回退不跳节点），随后瘦身为顶栏极简进度条，回退目标加高亮闪烁。
- 构建脚本新增快速编译模式（复用前端 dist 只重编 Go 侧）与耗时统计。

### Fixed
- 内容替换计划的 source 指纹改为绑定原始文档基线，修复执行前必然判定 stale。
- 浏览页操作行被分组筛选垂直撑高的布局问题。
- dev 备份改用 robocopy，规避 WebView2 深层目录的 MAX_PATH 限制。
- `build-latest.ps1` 自动补全 wails CLI 的 PATH 并兼容 Windows PowerShell 5.1（UTF-8 BOM + 英文字符串）。
- `wails.json` 的 `frontend:build` 含 shell 操作符导致 Linux/macOS 构建失败；Release 工作流对齐 wails v2.13 构建环境。
- retest 桥恢复审计 jsonl 的 Node 侧落盘，修复审计清理与读取失效。

### Engineering
- Go 主包拆分：`App` 迁入 `internal/app`，Wails 绑定命名空间由 `main` 改为 `app`；仓库根目录归拢整理。
- `.gitattributes` 统一 LF 换行，`.ps1` 例外保留 CRLF。
- 数据护栏测试补充文件↔缓存双向兼容与损坏回退用例；smoke 环境代码与 NSIS 安装器脚手架入库，retest SSH 测试环境自助化。

## [1.9.0] - 2026-09-02

### Added
- 会话审计日志（`audit-trail.jsonl`）与独立审计日志页，变更计划 5 步全程记录会话（含完整配置内容）。
- 变更计划内可人工编辑目标配置，用于机器判定不准或需要补充的场景。
- 重复 key 位置可视化警告（对比页提示条 + 计划详情 warning），并按完整层级路径判定，不同父路径同名 key 不再误报。
- 计划详情 diff 上方增加 dry-run 预览提示条，第四步明确 dry-run 语义，避免「应用后」预览被误读为已写入。
- Nacos 后端支持命名空间/组列表查询与审计事件持久化；浏览与对比页增加 group 下拉、来源恢复，对比页记住左右来源并自动恢复。
- 设置页新增开发者清理缓存入口（localStorage `cs.*` 与审计日志）。

### Fixed
- YAML duplicate key 降级为警告，不再阻塞配置同步。
- 审计矩阵滚动与详情面板布局，修复跳转 Diff 按钮被遮挡无法点击。
- 修正 Nacos v1 列表接口字段映射，修复批量匹配找不到 dataId。
- 修复对比应用箭头失效、搜索无高亮、拖选复制含两端代码块以及审计跨命名空间对齐问题。

### Engineering
- 升级 Wails v2.12 → v2.13 以支持 webkit2gtk-4.1。
- retest 真人模拟套件扩到 S 组（S1–S16）并修至全绿，补齐晋级全链路、导出与快照恢复、执行失败、任务详情等用例；新增生产级测试数据生成脚本（12 个配置对）。

## [1.8.0] - 2026-08-11

### Added
- 配置浏览支持内容搜索、批量替换，并安全进入变更计划。
- 配置对比固定左到右的应用方向并保留对比上下文。
- 备份加密密码通过系统凭据库持久保存，且不进入可移植备份包。

## [1.7.1] - 2026-07-30

### Added
- 配置对比支持批量差异的双向合并预览并物化为变更计划，合并预览交互与工作流布局重构。
- 支持 `CONFSCOPE_DATA_DIR` 便携数据目录，配置浏览细化范围筛选，文件选择与返回流程优化。
- 配置源文件导出，应用数据备份集成快照。
- 对比工作流引导与变更计划文案统一。

### Fixed
- 清理设置页保存提示的残留定时器。

## [1.7.0] - 2026-07-23

### Added
- 配置浏览支持按分组筛选，并优化左侧工具条布局与 SVG 图标显示。
- 配置对比页记住上一次左右来源，并在批量对比中标记仅左侧/仅右侧存在的配置。
- 应用计划支持 diff 预览、dry-run 检查和按配置项选择执行。
- Windows 便携版将 WebView 数据保存到 exe 同级目录，并支持从旧 AppData 数据自动迁移。

### Fixed
- 修复 SSH 隧道 localhost/IPv6、过期端口缓存和并发创建导致的连接失败。
- 修复 Nacos 中文响应在 GBK/GB18030 场景下显示乱码的问题。
- 修复对比页和筛选下拉弹层被父容器遮挡的问题。

### Engineering
- 增加便携数据迁移、SSH 隧道复用、配置浏览分组、对比偏好和应用计划 dry-run 的回归测试。

## [1.6.5] - 2026-07-15

### Added
- 恢复 macOS 发布产物：GitHub Actions 自动构建 `ConfScope-darwin-arm64.dmg` 与 `ConfScope-darwin-amd64.dmg`。
- `update.json` 增加 `darwin-arm64` / `darwin-amd64` 下载条目。
- Release workflow 支持 `workflow_dispatch` 手动试跑（只构建上传 artifact，不创建正式 Release）。

### Fixed
- 修复 macOS runner 上 Wails CLI 因缺少 `LC_UUID` 无法启动的问题（CI Go 1.24.x + darwin external link 安装 CLI）。

### Engineering
- DMG 打包改为动态定位 `.app`，`create-dmg` 失败时回退 `hdiutil`，失败不再被 `|| true` 吞掉。

## [1.5.0] - 2026-07-07

### Added
- 新增应用数据备份与恢复，覆盖连接、SSH 配置档案、设置、操作历史、ApplyPlan、验证记录、UI 与语言状态。
- 支持本地 `.csbackup` 加密备份包导出、预览和完整恢复。
- 支持单个 WebDAV 备份目标，提供连接测试、上传、远端列表、下载预览和恢复。
- 恢复前自动创建加密恢复点，恢复点创建失败时阻止覆盖当前数据。

### Engineering
- 新增 Go `internal/appbackup` 加密包、本地文件读写和 WebDAV 客户端测试。
- 扩展 Vite smoke 与 Windows native Wails smoke，使用 Docker WebDAV 覆盖应用数据备份恢复链路。

## [1.4.2] - 2026-07-07

### Engineering
- Added reusable Windows native Wails WebView smoke automation.
- Native smoke now builds the real Wails exe, starts Docker Nacos, creates a Nacos connection through the UI form, reads seeded config, and archives PASS/NOT_RUN report rows.
- Added a smoke-only loopback control server enabled by `CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT` after WebView2 CDP proved unavailable in the real Wails build.

## [1.4.1] - 2026-07-06

### Fixed
- 修复默认 Nacos 命名空间在 ApplyPlan 入口中被内部改写为 `public`，导致真实 Nacos 写入后读回不一致的问题。
- 修复 Nacos v1/v3 默认命名空间请求发送空 `tenant` / `namespaceId` 参数的风险。

### Engineering
- 新增 Docker Nacos 真实集成测试，覆盖直写拦截、沙箱应用、生产晋级、回退、历史读取和删除。
- 补齐 Diff/Audit ApplyEntry 与 Nacos 请求参数的默认命名空间回归测试。

## [1.4.0] - 2026-07-06

### Added
- ✅ **应用计划执行闭环**: 新增 dry-run 审核、写入前备份、受保护目标确认与执行历史记录。
- ✅ **沙箱验证与生产晋级**: 支持成功应用记录标记沙箱验证后生成生产晋级计划。
- ✅ **安全回退计划**: 支持从应用/晋级历史基于 before 快照生成回退 dry-run。

### Fixed
- 🐛 **写入入口安全**: 禁用旧发布、删除和历史直回滚路径，真实写入只允许 ApplyPlan 专用绑定。
- 🐛 **快照回退执行**: 回退计划执行时保留 dry-run 解析出的本地快照源连接，避免 snapshot source 丢失。

### Engineering
- 🧪 **端到端验证**: 增加 Playwright 主流程，覆盖差异、沙箱应用、生产晋级和历史回退。
- 🧪 **回归测试**: 补齐 ApplyPlan 执行、安全备份、晋级、回退和旧入口禁用测试。

## [1.3.1] - 2026-07-05

### Fixed
- 🐛 **更新检查**: 归一化 `v1.3.0`、`refs/tags/v1.3.0` 等标签格式，同版本不再误判为可更新。
- 🐛 **关于页空态**: 无连接状态下仍可打开关于页，不再被连接空态拦截。
- 🐛 **设置页导航**: 左侧索引跳转只滚动右侧设置面板，避免带动整个工作区滚动。

### Changed
- 🔄 **设置页布局**: 重排设置页分组，左侧索引在设置页内部保持固定。
- 🔄 **启动更新提示**: 将更新弹窗文案调整为 `1.3.1` 补丁版本说明。
- 🔄 **发布物料许可证**: RPM metadata 与项目许可证统一为 AGPL-3.0-only。

## [1.2.0] - 2026-07-03

### Added
- ✨ **配置矩阵**: 多环境一致性检查，支持 2-6 个环境对比
- ✨ **审计导出**: CSV/JSON 双格式导出，支持脱敏开关
- ✨ **过滤与排序**: 按状态过滤（不一致/缺失/解析失败）、隐藏已忽略、按列排序
- ✨ **矩阵行跳转 DiffView**: 点击矩阵行直接跳转深度对比
- ✨ **操作历史**: 本地操作记录 + 配置中心历史拉取，支持筛选
- ✨ **侧边栏分组**: 配置管理/数据管理/系统设置三组，组间分隔线
- ✨ **AuditView UI 美化**: 完整 CSS 样式优化（工具栏、矩阵表格、详情面板）
- ✨ **DiffView 页面头部**: 添加 page-header，项目选择和展开按钮移入
- ✨ **底部样式统一**: 消息中心和收起按钮融入导航风格

### Changed
- 🔄 "审计矩阵"更名为"配置矩阵"
- 🔄 "智能对比"更名为"配置对比"
- 🔄 SSH 隧道移入系统设置组
- 🔄 操作历史筛选改为一行内展示
- 🔄 清空操作历史按钮移入设置页危险操作区

### Engineering
- 强制测试要求加入项目规约（前后端 quality-guidelines.md）
- 前端 188 测试全绿（34 个测试文件）
- 新增 export.ts、operationHistory.ts、AuditView.test.tsx、operationHistory.test.ts

## [1.1.0] - 2026-07-02

### Added
- ✨ **Provider 抽象层**: Go 后端 ConfigProvider 接口 + Nacos/Local 适配器
- ✨ **阿里云 MSE Nacos**: 支持 AK/SK 签名认证
- ✨ **全局代理配置**: SettingsView 网络分组，支持 HTTP/HTTPS/NoProxy
- ✨ **连接表单代理开关**: 按连接选择是否走系统代理
- ✨ **应用检查更新**: 多线路自动回退 + 后台低频静默检查
- ✨ **版本号 ldflags 注入**: 构建时从 git tag 注入版本号
- ✨ **更新 ignore**: 支持"忽略此版本"，mandatory 时禁止忽略
- ✨ **连接管理项目/环境层级**: 项目分组 + 环境标签
- ✨ **本地快照目录来源**: 本地目录作为只读 provider 参与对比
- ✨ **全局消息中心**: 错误聚合、合并、复制、已读管理
- ✨ **SSH 配置档案**: 可复用 SSH 配置，连接引用 + 影响范围提示
- ✨ **智能对比容错**: 单侧故障不阻断，失败侧标记 + 重试
- ✨ **HTTP 网络层重试**: 3 次指数退避，自动恢复瞬时网络抖动
- ✨ **连接池优化**: IdleConnTimeout 30s，MaxIdleConnsPerHost 4
- ✨ **批量对比失败内联展示**: 失败 dataId 列表 + 逐个重试
- ✨ **对比/浏览刷新按钮**: 一键刷新匹配列表和配置内容
- ✨ **连接测试进度提示**: 实时计时 + 超时黄色警告
- ✨ **本地快照对比标签**: 区分本地路径与远程 Nacos 连接
- ✨ **错误复制按钮**: 全错误场景统一提供 CopyButton

### Changed
- 🔄 左侧主导航取代顶部双模式切换
- 🔄 无边框窗口，自绘主布局
- 🔄 连接管理升级为 provider 感知表单
- 🔄 应用版本默认 `dev`，发布时 ldflags 注入
- 🔄 SettingsView 按基础信息/认证/网络/安全/高级分组
- 🔄 所有 Go/TS 注释统一使用中文

### Fixed
- 🐛 连接池复用失效导致 `context deadline exceeded` 误报
- 🐛 对比页 A/B 侧同时加载失败时无重试入口
- 🐛 命名空间加载失败无复制按钮

### Engineering
- ESLint + Prettier + TypeScript strict + noUnusedLocals
- Trellis 任务线管理（12 个归档任务）
- Spec 规范文档（backend 5 + frontend 6）
- Go 57 测试 + 前端 161 测试全绿

## [0.1.0] - 2026-06-24

### Added
- ✨ 从 Tauri 迁移到 **Wails 2** + **Go** 后端
- ✨ Nacos OpenAPI v1/v3 双版本自动探测
- ✨ 连接管理（多套 Nacos 服务器配置）
- ✨ 智能认证（Token 缓存、过期刷新、403 自动重试）
- ✨ 配置浏览（命名空间切换、模糊搜索）
- ✨ 历史版本查看
- ✨ 智能配置对比（LCS 行级 diff）
- ✨ 深色 VSCode 风格 UI
- ✨ 配置内容语法高亮（YAML/JSON/Properties/XML）

### Technical
- Go 后端直连 Nacos OpenAPI，零第三方依赖
- 纯前端 LCS diff 算法，无额外重依赖
- Wails 2 桌面应用框架，支持 Windows/macOS/Linux
