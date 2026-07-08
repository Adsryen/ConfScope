# 审计导出 Provider 字段与脱敏增强计划

最后更新：2026-07-08

## 目标

补齐 Nacos、Apollo、Consul、local snapshot 审计导出的 provider/source 元数据、字段一致性、默认脱敏和真实 UI smoke 下载覆盖。

## 背景

- `src/lib/audit.ts` 的 `AuditRow` 已有 `providerType`、`namespace`、`group`、`dataId`、`key`、`status`、`originalDataIds`。
- `src/lib/export.ts` 当前审计导出缺少 JSON `sources[]`、行级 provider/source 字段和 per-cell `originalDataId`。
- `AuditView` 已默认 `sanitizeExport=true`，但真实 smoke 只验证 audit 展示，没有验证下载内容。
- 本任务属于 `v1.x` 小步增强，不新增治理报告，不开放 Apollo/Consul 写入。

## 范围

需要修改：

- `src/lib/export.ts`
- `src/lib/export.test.ts`
- `src/components/AuditView.test.tsx`
- `tests/smoke/specs/auditExport.ts`
- `tests/smoke/specs/40-apollo-provider.spec.ts`
- `tests/smoke/specs/45-consul-provider.spec.ts`
- `.trellis/spec/frontend/export-guidelines.md`，仅在导出合同落定后更新

不做：

- 不新增治理报告页面。
- 不改 Apollo/Consul 写入能力。
- 不重构配置矩阵 UI。
- 不改变 `.csbackup` 或 `.cssnapshot` 格式。

## 导出合同

JSON 增强：

- `metadata.schemaVersion = 2`
- `sources[]` 包含 `envId`、`provider`、`connectionId`、`connectionName`、`projectName`、`environmentName`、`sourceName`、`sourceType`、`namespace`、`group`
- `rows[]` 包含 `providerType`、`namespace`、`group`、`dataId`、`key`、`status`、`ignoreReason`、`originalDataIds`
- `rows[].values[envId]` 包含 `exists`、`value`、`updatedAt`、`originalDataId`

CSV 增强：

- 固定前缀列：`providerType,namespace,group,dataId,key,status,ignoreReason,originalDataIds`
- 每个环境源输出：`_value`、`_exists`、`_updatedAt`、`_originalDataId`
- 环境源列名包含 provider/project/environment/source/connection/namespace/group，方便人工审阅归档。

脱敏增强：

- 默认 `sanitize: true` 不变。
- 命中敏感 key 时值替换为 `***`，字段和行继续保留。
- 覆盖：`password`、`token`、`secret`、`secretKey`、`accessKey`、`accessKeyId`、`accessKeySecret`、`securityToken`、独立片段 `ak`、独立片段 `sk`、`privateKey`、`passphrase`、`webdav.password`。

## 实施步骤

1. 在 `src/lib/export.test.ts` 先写失败测试：
   - JSON `metadata.schemaVersion`、`sources[]`、行级 provider/source 字段。
   - CSV 固定前缀列、环境源列、`updatedAt`、`originalDataIds`。
   - AK/SK、WebDAV password、privateKey、passphrase 等敏感 key 脱敏。
2. 在 `src/lib/export.ts` 实现：
   - `AuditExportSource` 类型。
   - `auditSources()`、`sourceLabel()`、`providerOf()` 等 helper。
   - JSON schema v2 输出。
   - CSV provider/source 前缀列与 per-env 补充列。
   - path-aware 敏感 key 判断，避免 `sk` 误伤普通单词。
3. 在 `src/components/AuditView.test.tsx` 加强现有默认脱敏测试：
   - 继续断言 `exportAuditCSV(..., { sanitize: true })`。
   - 断言传入导出层的 `envSources` 保留 connection/provider/source/namespace/group。
4. 新增 `tests/smoke/specs/auditExport.ts`：
   - `downloadAuditJSON(page)` 通过可见 UI 选择 JSON、等待下载并解析。
   - `downloadAuditCSV(page)` 通过可见 UI 下载 CSV 并返回文本。
5. 扩展 Apollo smoke：
   - 在现有 Config Matrix audit 后下载 JSON。
   - 断言 `schemaVersion=2`、`sanitized=true`、`sources[].provider="apollo"`、`rows[].providerType="apollo"`。
6. 扩展 Consul smoke：
   - 在现有 Config Matrix audit 后下载 CSV。
   - 断言 provider/source 列、`consul`、`apps/order/app.yaml`、关键字段内容。
7. 更新 `.trellis/spec/frontend/export-guidelines.md`：
   - 记录审计 JSON schema v2、CSV 前缀列、source 元数据和测试要求。

## 验证命令

```bash
pnpm test src/lib/export.test.ts src/components/AuditView.test.tsx
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright test -c tests/smoke/playwright.config.ts tests/smoke/specs/40-apollo-provider.spec.ts tests/smoke/specs/45-consul-provider.spec.ts
pnpm test:smoke
git diff --check
```

## 完成标准

- 单元测试覆盖 CSV/JSON 新合同和脱敏字段。
- 组件测试证明默认脱敏导出没被破坏。
- Apollo/Consul smoke 通过真实 UI 下载并检查审计导出文件。
- `.trellis/spec/frontend/export-guidelines.md` 已同步新导出合同。
- 代码按项目提交规范提交，`.trellis/` 不强行加入 git。
