# M-1 技术验证结果

验证日期：2026-09-20 · 环境：macOS 15.7.9 arm64 · Node 24.16.0 · Electron 44.4.3

架构计划见 `ARCHITECTURE.zh-CN.md`。本文只记验证结论，**有结论与计划冲突的以本文为准**。

---

## 1. 存储层 ✅ 通过，且比计划预期好

`better-sqlite3@13.0.3` + `sqlite-vec@0.1.9`，在 **Node 和 Electron 下都一次通过**。

| 测试项 | 结果 |
|---|---|
| Electron ABI 兼容 | ✅ **不需要 electron-rebuild** |
| sqlite-vec 加载 | ✅ 预编译 `sqlite-vec-darwin-arm64/vec0.dylib`，运行时扩展 |
| WAL 模式 | ✅ |
| 插入 2000 条 768 维向量 | Node 116ms / Electron 78ms |
| KNN top-10 查询 | **0.75ms/次** —— R1 召回完全不是瓶颈 |
| `locks` 表 + `BEGIN IMMEDIATE` | ✅ 抢锁、拒绝、过期抢占三种情况都正确 |

**为什么不用重建**：better-sqlite3 13.x 用 `prebuilds/<platform>-<arch>.node` 的
prebuildify 布局，二进制里有 60 个未定义的 `napi_*` 符号，是**真正的 Node-API 构建**，
跨 Node(ABI 137) / Electron(ABI 149) 稳定。

> **计划修订**：架构文档里「需要 electron-rebuild」这条作废。仍然需要 `asarUnpack`
> （`.node` 不能从 asar 内加载）。`prebuilds/` 含全平台共 16MB，打包时裁剪到 darwin-* 两个。

### ⚠️ 需要处理：向量的磁盘占用

**每条 768 维向量 3224 字节。** 按 2000 条/天算：

| 周期 | 占用 |
|---|---|
| 每天 | 6.4 MB |
| 每年 | **2.3 GB** |

对一个「数据都在你电脑上」的产品，这个数字必须处理。三个方向：
1. **降维** —— Gemini embedding 支持 Matryoshka 截断输出维度，768→256 可降到约 0.8GB/年
2. **保留策略** —— 老条目只留元数据，向量过期删除（daily-brief 的 embedding 缓存是 90 天）
3. 二者结合

**决定放到 M0 设计 schema 时做，不要等到用户硬盘满了。**

---

## 2. RSSHub ⚠️ 通过，但集成方式与计划不同

### 重大发现：npm 包是**库**，不是服务器

`npm i rsshub` 装出来只有 `dist-lib/`（每条路由一个预打包 `.mjs`），
**没有 `dist/index.mjs`，它 package.json 里的 start 脚本指向的文件不存在**。
对外只导出三个函数：

```ts
init(conf?): Promise<void>
request(path): Promise<Data>      // 直接给路由路径，拿回规范化的 feed 数据
registerRoute(namespace, route, config?): Promise<void>
```

**这比计划里的方案好得多**：不用起 HTTP 服务器、不用管端口、不用健康检查、
不用崩溃重启。直接 `await request('/telegram/channel/durov')` 就拿到数据。
我们本身是 AGPL-3.0，直接链接完全合规。

> **计划修订**：`packages/rsshub/` 从「进程托管」改为「库封装」。
> 架构文档里「端口管理 / 健康检查 / 崩溃重启」和风险表里对应那条全部作废。
> M0.5 的工作量大幅下降。

### 路由实测

`init()` 耗时 271–470ms。**零配置可用的**：

| 源 | 条数 | 耗时 |
|---|---|---|
| Telegram `/telegram/channel/:id` | 20 | 686ms |
| B站热门 `/bilibili/popular/all` | 20 | 606ms |
| 知乎日报 `/zhihu/daily` | 30 | 6565ms |
| GitHub 活动 `/github/activity/:user` | 27 | 547ms |
| Hacker News `/hackernews/index` | 30 | 478ms |
| 36氪 `/36kr/hot-list/:category` | 10 | 8802ms ⚠️ 慢 |

**不可用的**：

| 源 | 原因 |
|---|---|
| 微博（热搜和关键词都是） | **需要 Playwright 浏览器**。它靠无头浏览器取访客 Cookie |
| Twitter/X | 需要用户提供 cookie（与计划一致，已知） |

> 路由路径必须查 `dist-lib/pkg.d.mts` 里的 `RoutePath` 联合类型。
> **路径写错不会抛错，会返回 0 条**，适配器要把「0 条」和「路由不存在」区分开。

### 体积与依赖

- `node_modules` **415 MB**，629 个包
- 大头：`@sentry` 45MB + `@opentelemetry` 30MB = **75MB 遥测**，
  对一个隐私优先的本地软件既不需要也不该带，打包时剔除
- **`patchright-core` 14MB** —— 一个 Playwright 隐身分支，是 `rsshub` 的直接依赖。
  `-core` 意味着不含浏览器二进制，微博那类路由会在运行时报
  `Executable doesn't exist ... npx playwright install`
- Electron 44.4.3 自带 **Node 24.21.0**，满足 rsshub 的 `^24.15.0`
  → **不用额外打包 Node 运行时**

**待决策（M0.5）**：415MB 直接内置会让安装包到 ~600MB，太大。三个方向：
1. 剔除 sentry/otel/未用路由后重新打包（预计能砍掉一半以上）
2. 首次启动下载（AGPL 下同样合法，纯工程取舍）
3. 只内置我们自己实现的高价值路由，RSSHub 作为可选增强

微博要不要支持，取决于愿不愿意再背约 150MB 的 Chromium。
**建议：微博自己实现（走移动端 API），不为它背一个浏览器。**

---

## 3. R3 发现层 ✅ 已解决，但方案换了

### GDELT ❌ 不可靠，降为可选

文档说「每 IP 每 5 秒 1 次」。实测远不止：

| 尝试 | 结果 |
|---|---|
| 密集测试后触发限流 | 429 |
| 退避重试 6 次 × 8 秒 | 仍 429 |
| 静默 120s / 300s / 600s | 仍 429 |
| 静默约 25 分钟后 | **HTTP 200，恢复** |
| 再过 30 秒单发一次 | **又 429** |

两个独立问题：

1. **粘性惩罚窗口**：触发后要十几到二十几分钟才恢复，而且恢复后单发一次仍可能再被拦。
   实际可用频率远低于「5 秒 1 次」
2. **查询语法限制**：关键词长度必须 ≥3。查 `Xi Jinping` 会返回
   `Your search contained a keyword that was too short.`——**而且这个错误是 HTTP 200**，
   不看响应体根本发现不了

另外 429 返回**纯文本不是 JSON**。也就是说适配器要处理三种情况：正常 JSON、
纯文本 429、HTTP 200 但内容是错误提示。

> **计划修订**：GDELT **不能作为 R3 主力**。架构文档里「各 Watch 串行错峰
> （20 个 Watch ≈ 100 秒）」的做法会直接把用户 IP 打进惩罚窗口。具体处理见下。

### 别人是怎么处理的（已查证）

**`Thysrael/Horizon` 的 `src/scrapers/gdelt.py`（185 行）：没有任何限流处理。**
搜 `sleep|retry|backoff|429|throttle|rate limit` 零命中。它的做法是
`raise_for_status()` 把 429 变成异常 → `except` 捕获 → `logger.warning` → `return []`。
文件头注释承认「GDELT 在瞬时错误时可能返回非 JSON 或空响应」，对策也只是返回空列表。

**它能这么干，是因为跑在 GitHub Actions 里**：每次运行都是全新 runner IP，
IP 级惩罚不累积；一天只跑一次；GDELT 只是十个源之一，拿不到就算了。
**桌面应用用的是用户家里那一个固定 IP，处境完全不同，不能照抄。**

**社区实测（与本次结果一致，且更严重）**：

- 6 秒间隔 → 7 次只有 1 次通过；16 秒间隔 → 12 次只有 4 次通过
- **越退避越糟**：「收到 429 就退得更慢」这个本能反应，正是让你一直被拦的原因
- 封锁是 IP 级的，持续时间远长于触发它的那次违规
- 推荐做法是**熔断（circuit breaker）而不是退避重试**：
  解析 `Retry-After`，打开端点级熔断开关，后续调用直接快速失败，不要继续打 GDELT
- 要把所有 GDELT 请求（包括调试时的探索性请求）当作**同一个全局预算**

### 从 Horizon 学到的有用的东西

它的查询构造值得抄——GDELT 的语言和国家过滤是**查询操作符**不是独立参数：

```
query = f"{关键词} sourcelang:{语言} sourcecountry:{国家}"
```

这意味着**一次查询就能覆盖多语言多地区**，正好配合「全局预算」：
不要每个 Watch 发一次，而是把多个 Watch 的关键词合成**一次广查**，本地再分发匹配。

### GDELT 最终处理方式

默认关闭。开启后：

1. **每次运行全局一次查询**，不是每个 Watch 一次。用 `sourcelang:`/`sourcecountry:` 操作符和
   OR 关键词把多个 Watch 合成一发
2. **熔断，不退避**。收到 429 → 熔断 30 分钟，期间直接跳过不发请求。
   **明确禁止「退避重试」**，实测和社区数据都证明它适得其反
3. **三种响应都要处理**：正常 JSON、纯文本 429、HTTP 200 但正文是错误提示
4. 关键词 ≥3 字符，否则返回 HTTP 200 + `keyword was too short`
5. **失败静默**，学 Horizon 那一点：GDELT 永远是加分项，不是依赖项，拿不到就当没有


### Google News 搜索 RSS ✅ 新的 R3 主力

免费、无需 key、**实测无限流**：

| 测试 | 结果 |
|---|---|
| 英文查询 `Xi Jinping` | HTTP 200，**102 条** |
| 中文查询 `习近平`（`hl=zh-CN&gl=CN&ceid=CN:zh-Hans`） | HTTP 200，**100 条** |
| **连发 8 次不同关键词**（模拟 8 个 Watch） | **8 次全部 HTTP 200，每次 100–102 条** |

```
https://news.google.com/rss/search?q=<关键词>&hl=<语言>&gl=<地区>&ceid=<地区>:<语言>
```

每项都优于 GDELT：条数更多（100+ vs 250 上限但拿不到）、原生多语言、
**关键词无长度限制**、无限流、返回标准 RSS 可直接喂现有解析器。
`hl`/`gl`/`ceid` 三个参数正好对接「输出语言按 Watch 设置」那条设计。

### Bing News 搜索 RSS ✅ 可用，作为补充

`https://www.bing.com/news/search?q=<关键词>+when:1d&format=rss` → HTTP 200，5 条。

条数少得多，但 **daily-brief 的 `evidence-source.ts` 已经在用它**
（`site:<域名> when:1d` 做单源兜底），移植过来零成本。适合做「某个源今天有没有更新」的探测，
不适合做广度发现。

### R3 最终设计

1. **主力：Google News 搜索 RSS** —— 每个 Watch 一次查询，无限流顾虑
2. **补充：Bing News 搜索 RSS** —— 沿用 daily-brief 的单源兜底用法
3. **可选：GDELT** —— 默认关闭，设置里可开。给需要非英语小语种全球覆盖的高级用户，
   附带上面那套限流纪律


## 4. Gemini 模型 ID ✅ 全部有效

账号可见 58 个模型。daily-brief 在用的全部还在：

| 用途 | 模型 ID | 状态 |
|---|---|---|
| 写作 | `gemini-3.7-flash` | ✅ |
| 快模型 / 聚类判定 | `gemini-3.1-flash-lite` | ✅ |
| 聚类分组 / 时间线 | `gemini-3.8-flash` | ✅ |
| 向量 | `gemini-embedding-2` | ✅ 支持 `embedContent` |
| —— | `gemini-2.5-flash-lite` | ⚠️ 还在，但 2026-10-16 退役，**不要绑定** |

**新增可选项**：`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.8-flash`。
T2 判定层选型时值得对一遍价格。

> 照计划执行：**模型 ID 集中到一处配置**，不要散在代码里。

---

## 5. Telegram 直抓 ✅ 通过

不依赖 RSSHub 也能自己实现：

- `t.me/s/<channel>` —— **无需登录、无 API key、无代理**，HTTP 200
- 每页 **20 条**消息（`tgme_widget_message_wrap`），带 ISO 时间戳
- `?before=<id>` 分页正常
- 此前资料说「部分频道关闭预览」，实测 `NewlearnerChannel` 仍可抓

**这条自己实现，不走 RSSHub**，省一个依赖且更可控。

---

## 6. 签名与公证 ⏳ 未验证

需要 Apple Developer 账号，本轮未做。**仍是最高风险的未知项**，
因为带自启动 agent + 子进程的 app 公证要求更严。**M0 阶段就要用空壳 app 走通一次。**

---

## 汇总

| # | 项 | 结论 |
|---|---|---|
| 1 | 存储层 | ✅ 通过，比预期好（免重建）。**但向量 2.3GB/年要处理** |
| 2 | RSSHub | ⚠️ 通过。**是库不是服务器，集成更简单**。415MB 待瘦身；微博要浏览器 |
| 3 | R3 发现层 | ✅ **已解决**。GDELT 不可靠已降为可选，**Google News 搜索 RSS 接任主力**（实测连发 8 次无限流，每次 100+ 条，中英文都行） |
| 4 | Gemini 模型 | ✅ 全部有效 |
| 5 | Telegram | ✅ 零配置可用，自己实现 |
| 6 | 签名公证 | ⏳ 未验证，**最高剩余风险** |

**没有一项导致架构推倒重来。** 两条要改，都已有结论：
1. RSSHub 从「进程托管」改「库封装」—— 变简单了，M0.5 工作量大幅下降
2. R3 主力从 GDELT 换成 Google News 搜索 RSS —— 换完之后反而更好（条数更多、原生多语言、无限流）

剩余最高风险：**签名公证仍未验证**。
