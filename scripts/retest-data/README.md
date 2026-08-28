# retest 测试数据说明

本目录的 gen.py + publish.py 生成并发布到双 Nacos 容器的 12 个生产级配置对。

## 运行
```bash
python3 gen.py       # 生成 24 个文件到 generated/
python3 publish.py   # 删旧数据 + 发布到 A(19848/retest-dev) B(19849/retest-qa), group=RETEST-PROD
```

## 12 个配置对覆盖的场景
| dataId | 格式 | 覆盖场景 |
|---|---|---|
| svc-gateway.yaml | yaml | 行序差异、注释措辞差异、值差异、仅 B 新增 key |
| svc-billing.yaml | yaml | 注释掉的模块（语义差异）、空值 |
| svc-search.yaml | yaml | bool vs 字符串类型差异、行序漂移 |
| svc-pay.json | json | 嵌套键值差异、仅 B 新增顶层键（paypal/compliance） |
| svc-pay.properties | properties | 仅一侧存在的 key、注释差异 |
| svc-order.toml | toml | 文本 fallback 对比、行序漂移 |
| svc-common.env | text(env) | 文本 fallback、仅一侧 key |
| svc-notify.yaml | yaml | **B 侧故意 YAML 语法错误**（tab 混用）→ parse_error 场景 |
| svc-config.yaml | yaml | 纯注释变化 + 值变化 |
| svc-data.yaml | yaml | 空值（null/空串）vs 实值 |
| svc-auth.json | json | 数组元素差异、仅 B 顶层键 |
| svc-legacy.yaml | yaml | 200+ 行大文件、行漂移、大量注释块 |

## 与旧数据
旧的 8 个 `retest-*` 文件已被 publish.py 删除（2026-08-28）。
