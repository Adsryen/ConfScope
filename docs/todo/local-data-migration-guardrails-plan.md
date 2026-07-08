# 本地数据迁移兼容护栏计划

最后更新：2026-07-08

## 目标

为后续 `v2.0.0` 平台化数据模型迁移建立旧本地数据兼容测试基线，避免新增字段、store normalize 或备份恢复改动破坏用户已有数据。

## 范围

- 建立旧 localStorage fixture。
- 覆盖连接、settings、SSH profiles、operation history、apply plans、apply verifications、app-data backup state、UI 和 locale。
- 覆盖应用数据备份 payload 恢复后再通过 loader 读取的兼容结果。
- 只做被测试证明必要的小范围 normalize 修补。

## 不做

- 不引入 v2 数据模型。
- 不引入数据库或账号体系。
- 不改变 `.csbackup` schema version。
- 不迁移真实用户数据文件。

## 预期文件

- 新增：`tests/fixtures/legacyAppData.ts`
- 新增：`tests/compat/appDataMigrationGuardrails.test.ts`
- 可能修改：`src/store/*.ts`
- 可能修改：`src/lib/appDataBackup.ts`
- 更新：`docs/todo/platform-governance-roadmap.md`

## 验收

- 旧 Nacos-only 连接缺字段仍能加载为当前 `Connection`。
- Apollo/Consul/local snapshot 连接字段不会在 normalize 中丢失。
- 旧 operation history 的 `previousContent/content` 仍映射到 `beforeContent/afterContent`。
- invalid apply plan / operation record / verification 不影响有效记录。
- `.csbackup` schema v1 合法 payload 恢复后，所有 loader 返回当前代码可消费的数据。

## 验证命令

```bash
pnpm test tests/compat/appDataMigrationGuardrails.test.ts
pnpm typecheck
pnpm lint
pnpm test
```
