# 公开截图凭据暴露面处置记录（2026-10-22）

- 状态：**程序侧已收口**（内容级闸门 + 本清单）；**凭据轮换未闭环**，需基础设施侧执行。
- 任务线：`.trellis/tasks/10-22-r64-screenshot-leak-disposal`（轮64），随 `v1.9.6` 发布。
- 本文只记**位置与形态**，不转录任何凭据值；文中 IP 一律 defang 成 `192[.]168[.]0[.]153` 形态，
  既是安全文档惯例，也让 `tests/ux/publicScreenshotsStaySanitized.test.ts` 的文档面扫描能常开。

## 一句话

早期版本 tag 树里的 README 界面截图截自**真实内网环境**，带出 redis 明文口令、mongodb 带账号
连接串、内网 IP、真实命名空间 UUID 与租户名。`main` 与 `v1.9.3` 起已换成 retest 合成数据重拍，
但旧 tag 的 raw 文件与 GitHub 自动源码包**至今公开可读**（本轮实测，见下表），所以这批凭据
必须按「已泄露」处理：轮换。

## 本轮实测的暴露面

取证方式：`git show <tag>:.github/assets/<图> | md5sum` 取仓库内指纹，再用
`curl` 走线上 URL 复核同一指纹——两边逐位一致才算「现在公开可读」，不是「历史上曾经有过」。

| 文件 | 泄露 blob md5 | 仓库内仍带此 blob 的 tag | 线上实测 |
| --- | --- | --- | --- |
| `配置浏览.png` | `0cc2fb179992ae837557dce88f8e3e31` | v1.3.0 ~ v1.9.2（18 个） | raw @v1.3.0、@v1.9.2 均 `200`，指纹相同 |
| `配置对比.png` | `4a06cadebaaa9b9b75d1f2432cb7a869` | v1.3.0 ~ v1.9.2（18 个） | 源码包解包后指纹相同（见下） |
| `配置矩阵.png` | `5a2609b44fdfa9627f839ec9fc23cd8e` | v1.3.0 ~ v1.9.2（18 个） | 源码包解包后指纹相同 |
| `page-1.png` | `de943c20df2c1f03e581e30d2b0412f4` | v1.0.0 | raw @v1.0.0 `200`，指纹相同 |
| `page-1.png` | `6d58d86470926338af2537f9f0a64ad7` | v1.1.0、v1.2.0 | raw @v1.2.0 `200`，指纹相同 |

两类公开路径，都要在提单里点到：

```
https://raw.githubusercontent.com/Adsryen/ConfScope/<tag>/.github/assets/<图名>
https://github.com/Adsryen/ConfScope/archive/refs/tags/<tag>.zip        # 及 .tar.gz
https://codeload.github.com/Adsryen/ConfScope/tar.gz/refs/tags/<tag>
```

源码包一条是实打实解出来看过的：`v1.9.2` 的 tar.gz 1,965,425 字节，包内
`.github/assets/` 三张图的 md5 与上表泄露 blob 逐位一致。也就是说，**只盯着 raw 域名会漏**。

对照面（同样实测）：`main` 与 `v1.9.3` 的 `配置浏览.png` 返回 `200` 且指纹为
`e34050f48681…`——那是合成数据的新图，干净。受影响 tag 合计 **21 个**：v1.0.0、v1.1.0、v1.2.0、
v1.3.0、v1.3.1、v1.4.0、v1.4.1、v1.4.2、v1.5.0、v1.6.0 ~ v1.6.5、v1.7.0、v1.7.1、v1.8.0、
v1.9.0、v1.9.1、v1.9.2。

## 图里能读到什么（按位置，不转录值）

| 图 | 位置 | 形态 | 必须处置 |
| --- | --- | --- | --- |
| `配置浏览.png` | 右栏 `*-auth-dev.yml` 的 `spring.redis` 段，`password` 一行明文 | redis 口令 | 轮换该实例口令 |
| `配置对比.png` | 左栏 `common.yml` 第 5~11 行：`redis.host/port/password/database` + `mongodb.uri` 整条连接串 | redis 口令、mongo 账号+口令、内网 IP `192[.]168[.]0[.]153`、端口 6379/27017、库名 | 轮换 redis 与 mongo 账号；确认 27017 未对公网开放 |
| `配置对比.png` | 右栏同类字段（当年打过码，但 `password` 一行的前缀仍可辨） | 预发/云上实例口令残片 | 一并轮换，别赌打码有效 |
| `配置矩阵.png` | 三个环境的「命名空间」输入框 + 项目名下拉 | 真实 namespace UUID（含 MSE 实例 `52a01124-…`）、租户名 | 非凭据，但足以拼出攻击面；按内部口径评估是否算泄露 |
| `page-1.png` | 右栏网关配置正文与左侧 dataId 列表 | 真实 dataId、命名空间 `xhjy_uat`、租户名（部分打码）、redis 策略行尾 | 同上 |

另有一条实测结论值得记下来，免得下次又去找不存在的资产：**两个旧 Release 的资产列表里根本没有图片**
（只有 7 个二进制 + `update.json`）。泄露面是 tag 树里的仓库文件，不是 Release 附件——
所以「删附件」这条看似直接的路其实无事可删，真正要处理的是 raw 与源码包。

## 轮换清单（按优先级）

1. 内网 `192[.]168[.]0[.]153:6379` redis 的 root / 应用账号口令（`配置对比.png` 左栏整段明文）。
2. 同机 `27017` mongo 的 `root` 口令（连接串整条在图里，含库名与 `authSource=admin`）。
3. 测试环境 redis 的 `spring.redis.password`（`配置浏览.png` 右栏；图上 host 写 `localhost:16379`，
   若那是 SSH 隧道的本地端口，隧道对端实例一起换）。
4. 预发/云上实例：图中该列打过码，但同页另一处口令前缀可读，按「整批换」处理。
5. 命名空间 UUID 与租户名：不是凭据，不需要「轮换」，但如果同一批 UUID 还出现在 CI 变量、
   告警 webhook 或别处公开文本里，按内部规定一并收口。

## 为什么不删 tag、不重写历史（判定记录）

| 方案 | 效果 | 代价 | 结论 |
| --- | --- | --- | --- |
| 轮换凭据 | 唯一真正止血 | 需基础设施侧执行 | **必做** |
| 向 GitHub Support 申请清除指定文件的缓存 | 去掉 raw 与源码包的可读性，不动 Release | 需人工提单、响应时限不可控 | **做**，提单文本见下 |
| 删这 21 个 tag | tag 树随之不可读 | 连带删除 21 个 Release 与其二进制资产，老用户升级链与已回填的发布说明全断；CDN 与已下载副本仍在 | 否 |
| `git filter-repo` 重写历史 + 强推 | 仓库内彻底消失 | 所有现存克隆失效；fork（今日实测 1 个）、镜像、搜索引擎缓存不受影响；发布链要逐条重建 | 否 |

判定理由一句话：**公开在 CDN 上的凭据，一旦存在过就应当视为已烧掉**。力气要花在
「让它不再回潮」和「把该换的换掉」上，而不是追一份追不完的缓存副本。删 tag / 重写历史
属于用可验证的破坏换不可验证的安心，不做。

## 提单文本（github.com/contact 或 support@github.com）

> Subject: Request to purge cached repository content for leaked credentials (ConfScope)
>
> Repository: Adsryen/ConfScope (public).
> Screenshots committed under `.github/assets/` in tags v1.0.0 through v1.9.2 contain
> real credentials (Redis passwords, a MongoDB connection string with account and
> password, internal IP addresses). We have already removed these files from the
> default branch and replaced them with sanitized captures, and we are rotating the
> affected credentials.
>
> Please purge the following from GitHub's caches and stop serving them:
> - `https://raw.githubusercontent.com/Adsryen/ConfScope/<tag>/.github/assets/<file>.png`
>   for tags v1.0.0, v1.1.0, v1.2.0, v1.3.0 … v1.9.2
> - the corresponding auto-generated source archives
>   `https://codeload.github.com/Adsryen/ConfScope/tar.gz/refs/tags/<tag>` and
>   `…/zip.gz/refs/tags/<tag>`
>
> This is a credential-exposure removal request, not a DMCA notice. We are not asking
> to delete the releases or their binary assets.

中文版同义即可，注意写清「不要删除 Release 及其二进制资产」，否则 Support 可能顺手把 tag 一起清了。

## 已落地的闸门（防回潮）

`tests/ux/publicScreenshotsStaySanitized.test.ts`（8 用例，随 preflight 的
`pnpm exec vitest run tests/ux` 自动跑）钉四条：

1. `.github/assets/` 每张图必须在**已人工复核名册**里且 md5 逐位一致；名册不留已删条目。
   换图的正路：`npx playwright test -c tests/retest/shots/playwright.config.ts` →
   肉眼看 `shots/out/` → 拷进 `.github/assets/` → 同一个提交里更新名册。
2. 泄露 blob 黑名单（就是上表 5 个 md5）：仓库内任何图片命中即红。黑名单只存 md5 与一句说明，
   **绝不把凭据原文写进仓库**——否则闸门本身变成第二次泄露。
3. PNG 结构：魔数、1920×1080、非零字节、不得携带 `tEXt/iTXt/zTXt` 元数据块
   （截图工具常把本机绝对路径与用户名写进这些块，图打码了、元数据没打码是同一类事故）。
4. 文档面凭据形态扫描：`README.md` / `CHANGELOG.md` / `docs/**` / `.github/**` 里不得出现
   明文密码赋值、带凭据的连接串、真实内网 IP（占位与合成数据形态放行，见该文件的 `PLACEHOLDER`）。

八条变异对照全部判红（2026-10-22 逐条实跑，每条跑完立即复原，事后核对五张图的 md5 与名册逐位一致）：
名册 md5 打错一位 / 旧泄露图捞回原路径 / 旧泄露图改名塞进 `public/` / PNG 塞入 tEXt 块 /
图截成 0 字节 / README 写进一条带凭据连接串 / 名册留磁盘上已不存在的条目 / 截图尺寸篡改。

## 残余风险（诚实记账）

- 已被下载或被中间缓存持有的副本追不回来 → 只能靠轮换，这也是本文把轮换放第一位的原因。
- 本仓库今日实测有 1 个 fork，fork 的历史不受本仓库任何操作影响。
- 若将来重拍截图，**必须**走 retest 合成数据集；直连真实环境截出来的图哪怕打了码也不许进仓库，
  这条由上面第 1、2 条闸门兜住。
