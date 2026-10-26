# retest 测试数据说明

本目录的 gen.py + publish.py 生成并发布到双 Nacos 容器的 12 个生产级配置对。

## 运行
```bash
python3 init-namespaces.py   # 先建命名空间（幂等；A: retest-dev，B: retest-qa）并复核 A 侧没有 retest-qa
python3 gen.py               # 生成 24 个文件到 generated/
python3 publish.py           # 删旧数据 + 发布到 A(19848/retest-dev) B(19849/retest-qa), group=RETEST-PROD
```

## 为什么 init-namespaces.py 必须跑在 publish.py 前面
命名空间过去是人手工在控制台建的，仓库里没有任何地方能重建它。空容器或换机时
`publish.py` 会往一个「不存在的 tenant」写，而这一步看起来是成功的
（2026-10-27 真机读数，临时命名空间 ghost-probe-1793045769 / ghost3-1793046186：
POST `/v1/cs/configs` 返回 true，紧接着精确 GET 是 404、约 0.5s 后同一读法变 200，
blur 列表 `totalCount=1`，而 `/v1/console/namespaces` 多久都列不出它）：
配置真的落库了，但应用的浏览页以命名空间列表为入口，列不出来的租户在 UI 里不可达。
脚本等 readiness、建完回读、末尾整体复核，缺任何一名空间直接非 0 退出；
`--self-test` 会真建真删一枚临时命名空间来验证 API 通路。

口径是这个脚本里的两个常量，不是「容器里恰好有什么」：
- `ENVS`（该建的）：A = `retest-dev`、B = `retest-qa`，与 `tests/retest/state.ts` 同源。
  `x` 那类手工残留在用例里没有引用，不建也不该建。
- `MUST_NOT_EXIST`（该没有的）：A 侧不得有 `retest-qa`。`98-remaining` E4 与
  `99-s-promote-entry` S31 的晋级目标就是「A 上还没被建出来的 retest-qa」，
  用例验的是产品那条「晋级会新建它，而不是覆盖同名配置」的提醒；把它建出来
  产品如实不提醒，两条用例一起红，红字还长得像「产品坏了」。
  2026-10-27 就把这一条建到了 A 上，S31 当场红成 `element(s) not found`
  （`/tmp/cs/r87-full-retest.log:25467`），删回去 E4 + S31 复跑 2 passed（`/tmp/cs/r88-envs-revert-check.log`）。

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
