# personal-newsroom 项目说明

给后续 AI 会话看的。**这些决策已经定了，不要重新讨论**，除非用户主动提出要改。
完整架构见 `docs/ARCHITECTURE.zh-CN.md`。

## 与用户沟通

- 用户不熟悉编程语言。解释代码、命令、错误时用大白话说明「这东西是做什么的、为什么改、改了影响哪里」。
- 用户常用例子描述需求。**例子是整体需求的一部分，不能只处理例子里的具体对象**；要先提炼背后的通用意图。
- 涉及命令、文件、环境变量时给准确名称和路径。
- 用户的额度有限。**不要重复探索已经记录在案的东西**，先读这个文件和 `docs/ARCHITECTURE.zh-CN.md`。

## 项目定位

一个只给一个人工作、跑在他自己电脑上的新闻编辑部。本地优先、意图驱动、macOS。

从 `../daily-brief` 引出——那是同一个作者的双语新闻门户（约 58000 行 TypeScript，
Next.js + Vercel + Upstash + R2 + GitHub Actions + Gemini），管线很好但**所有人看到同一份报纸**。
这个项目保留管线，重建它上面的一切。

## 第一原则：少做有损压缩

**整个项目最重要的一条，每个模块都是它的推论。**

不要在用户和 AI 之间塞「编译」层。不把「我想知道习近平最近在干什么」编译成关键词再去匹配——
编译层是脆弱的，而且它的错误不可见、不可恢复（漏一个别名，相关新闻永远不出现，用户不知道自己错过了）。

- 判定相关性 → 把**用户原话整段**放进 prompt，不放编译出的 rubric
- 召回 → 意图向量 + 别名 OR + 检索接口，三路**并集**，不是交集过滤
- 用户纠偏 → 存**原话**，原样喂回
- 进展对比 → 存**完整叙述原文**，不是 factHash
- 深度总结 → **完整抽取正文**，不是压缩后的 evidence pack

**关键区分**：AI 生成的别名和相关词仍然有用，但职责是「召回辅助」不是「判据」。
**只做加法，不做减法。** 所以 `RecallAids` 里**故意没有 exclude 列表**——
关键词级排除是典型有损压缩（「苹果」排水果会连带排掉苹果公司的农业新闻）。
排除只发生在能看到完整上下文的 AI 判定层。

## Google Search grounding 的用法（容易搞反）

**只补细节，不做发现。** 照抄 daily-brief 的 `lib/ai/gemini.ts:536`：

```ts
const usedSearch = !input.article;
```

全仓库 16 个 `useSearchTool` 只有写快讯一个是 true。
发现永远来自自己的源目录；**只有正文抓不到时**才开 `googleSearch` 补**那一条已确定事件**的细节。
prompt 三道锁：锁定 `this exact event`、锁定 `last 24 hours`、
`only facts they confirm` 否则 `publishable: false`。结果标 `basis: 'article' | 'search'`。

发现层用**返回真实 URL 的检索接口**（GDELT、Google News 搜索 RSS），它们吐的链接能拿去抓取验证。

## 已定决策（不要重新讨论）

| 决策 | 选择 | 关键理由 |
|---|---|---|
| 许可证 | **AGPL-3.0** | 能直接内置 RSSHub（也是 AGPL）；防止被做成闭源 SaaS。用户是唯一版权人，将来可双许可 |
| 桌面外壳 | **Electron** | 老项目 58000 行全是 TS，主进程就是 Node，管线原封不动能跑 |
| 存储 | **SQLite + sqlite-vec** | sqlite-vec 是**运行时扩展**不是原生模块，不用 electron-rebuild。better-sqlite3 是原生模块，需要 asarUnpack |
| AI | Gemini 优先 + Ollama | 老项目 prompt 全按 Gemini 调好 |
| 输出语言 | **用户自己选**，全局默认 + 按 Watch 覆盖 | 顺带简化：daily-brief 的 `titleZh`/`titleEn` 双份字段合并成 `title` + `lang`，token 减半 |
| 平台 | **只 macOS** | launchd / SMAppService。README 里直说不支持 Win/Linux |
| 无 key | **能当纯 RSS 阅读器用** | 最好的上手坡道。所有 AI 功能**优雅降级，不报错不空白** |
| 后台 | **SMAppService**（Electron `setLoginItemSettings` 的 `type: 'agentService'`） | plist 在 bundle 内，卸载即消失 |
| 单实例锁 | **SQLite `locks` 表** + `BEGIN IMMEDIATE` + 15 秒心跳 | 不用文件锁，`kill -9` 后 flock 清理语义不可靠 |
| 进展形态 | 顶部「昨天到今天」板块 **+** Watch 页完整时间线 | 共用 `WatchState.timeline` 的 `firstSeenAt`，一份数据两种渲染，判断只做一次 |

## 从 daily-brief 移植什么

源仓库在 `../daily-brief`。**移植，不 fork**。不要碰 `lib/narration/*`（播客 TTS）、
`lib/user/newsletter.ts`、`app/api/share/*`、`app/[lang]/*`、`lib/storage/kv-cache.ts`、`lib/storage/r2-store.ts`。

要移植的（完整清单见架构文档）：
`lib/feed/*`（含 `rss-catalog.ts` 的注释——那些是血汗经验，说明每个入口为什么这么选）、
`lib/evidence/*`、`lib/ai/semantic-embeddings.ts`、`lib/news/brief-service.ts`、
`lib/news/story-timeline.ts`、`lib/storage/historical-retrieval.ts`、`lib/core/*`、
`lib/prompts/news/editorial-rules.ts`、`app/globals.css`、`components/ui/rich-content.tsx`。

两处要改的地方：
- **交叉验证闸门换成意图闸门**。老闸门在 `evidence-cluster.ts:1553` 是**单点**
  （`cluster.independentOrgCount >= 2`），而且 `allClusters` 已经和 `eligibleClusters` 一起返回了，
  所以只换那个 filter 的判据即可。
- **双语字段合并**成单语言 + `lang`。

## 视觉

直接用 daily-brief 的 `app/globals.css` 设计 token，报纸美学，深浅两套都现成：
`--bg: #f5f2eb`（米白）· `--fg: #1a1a1a` · `--accent: #c0392b`（砖红）·
`--card-radius: 2px` · `--serif: 'Noto Serif SC', 'Playfair Display'` · `--mono: 'JetBrains Mono'`

## 红线

- **溯源可点**：`sourceRefIds` 绑定机制必须保留——模型不许自己写 URL，只能引用已绑定的来源 id
- **抓不到就说抓不到**：付费墙挡住时诚实降级，不拿摘要冒充正文。**阅读器一律不做 grounding 补全**
- **不填 key 也能用**：AI 不可用的判断集中在 `packages/ai` 一层，上层只问一次
- **成本**：目标 15 美分/天。判定要**批量打包**（20 条一次调用），写作要**跨 Watch 合并**。
  Flash 档 2027-01-01 价格翻倍，这两件事从第一版就要做对，不是以后优化
- **GDELT 限流**：每 IP **5 秒 1 次**，单查**最多 250 条不能翻页**。各 Watch 串行错峰，查询收窄时间窗

## 开工前必须先验证（M-1，不要直接写产品代码）

1. **RSSHub 去掉 Puppeteer 后哪些路由还活着**——Puppeteer 带约 100MB Chromium，
   而 **Electron 自带的 Chromium 不能给 puppeteer 用**。挨个跑 Telegram/微博/B站/知乎/小红书/GitHub
2. RSSHub 打进 Electron 包后多大（过大就退回首次启动下载，AGPL 下两条路都合法）
3. better-sqlite3 + sqlite-vec 在 Electron 里跑通
4. Gemini 模型 ID 对一遍官方列表（**2.5 Flash-Lite 2026-10-16 退役**，不要绑定）；模型 ID 集中到配置
5. 签名公证走一次空壳 app（带自启动 agent + 子进程的 app 公证更严，别留到最后）

## 执行顺序

M-1 技术验证 → M0 骨架 → M0.5 RSSHub 内置 → **M1 ⭐ 纯 RSS 阅读器（可发布，不要 key）**
→ M2 Watch → M3 召回判定 → M4 三种产出 → M5 深度总结 → M6 后台+Ollama → M7 开源打磨

M1 刻意设计成能独立发布：真实反馈比闭门三个月有用，签名公证提前趟平，而且它本身就是上手坡道。

---

## 进度（截至 2026-09-20）

**M-1 到 M6 的主线功能已完成并验证。** 打包签名公证之外，还有一批 M0-M6 范围内
**写完主线后才发现漏掉**的小项，见下面「已知缺口」——不要假设某个模块因为标了
✅ 就是计划里写的每一条都做了，动工前先看这一节，别重新发现一遍。

| 包 | 内容 | 验证 |
|---|---|---|
| `@pnr/core` | `DiscoveredItem` 统一契约、`canonicalDedupKey`、`RichBlock`、结构化日志 | — |
| `@pnr/store` | 18 张表 + 2 个 vec0 虚拟表、3 个迁移（**SQL 嵌在 TS 里**）、SQLite 锁 | `test:schema` |
| `@pnr/feed` | **11 种源适配器** + 注册表分发 + 粘贴内容自动识别 + 并发入库去重 | `test:adapters` 15/15 · `test:resolve` · `test:ingest` |
| `@pnr/reader` | 三层抓取、双引擎按词数取胜、结构化兜底、样板过滤、落盘 | `test:reader` |
| `@pnr/ai` | Provider 抽象（Gemini + Ollama）、无 key 闸门、向量缓存、按模型计价 | `test:ai` |
| `@pnr/watch` | Watch 模型、10 个预置标签、意图向量、召回辅助、纠偏 | `test:watch` |
| `@pnr/recall` | R1/R2/R3 三路并集、判定前免费排序截断、批量判定、意图闸门 | `test:pipeline` |
| `@pnr/generate` | 今日摘要（跨关注合并一次调用）、进展、快讯、按需深度总结 | `test:generate` · `test:flash-deep` |
| `apps/desktop` | Electron 主进程、IPC、今日/快讯/阅读/关注四 tab、设置、源目录与自定义源、后台调度 | 界面逐屏截图验证 |
| `apps/worker` | 无界面 worker，`daily` / `flashes` / `fetch` 三种模式，日志写库 | 实跑 59s 全绿 |
| `assets` | 应用图标：`AppIcon.icon` 是唯一源，`Assets.car`（26+）/ `icon.icns`（26 以前）由 `npm run icon:build` 生成 | 六种外观 + 16/32/64/128 各尺寸目视检查 |

**源**：内置目录 575 个（42 分类 24 国家）+ 11 种适配器 + RSSHub 打通的几千种。

### 实测数字（不是估算）

| | |
|---|---|
| 完整一天 | **$0.029**（抓 1092 条 + 抽正文 + 2 关注召回判定 + 摘要 + 进展） |
| 快讯 + 深度总结 | $0.016 |
| worker daily 全程 | 59 秒，0 失败，69 条结构化事件 |
| KNN 检索 | 0.75ms/次 |
| 向量占用 | 3224 字节/条 ≈ 2.3GB/年，靠 `pruneVectors` 控制 |
| 判定前截断 | 成本降 2.3 倍，质量没掉 |

### 「进展」的验证结论（最难的功能）

三种情况都已验证正确：
1. **首次跟进** = 建仓基线，进时间线但不标新增（`isBaseline` 显式判断，不依赖执行顺序）
2. **同样材料再跑** = 0 条新增
3. **注入真实新发展** = 准确识别并标记

关键：`told_records` 存**完整叙述原文**不是 hash，且记录**所有**展示过的节点；
去重用「日期 + 引用来源重叠」，不是字符串相等——模型每次措辞都不同。
快讯用同样的机制，第二次跑也是 0 条。

### RSSHub 分发：已定为按需下载（不随包发）

**不随应用分发**。它的依赖树 415MB，会让安装包从 200MB 涨到 600MB；而且路由随网站改版经常失效、社区修得很快，捆进应用意味着用户要等我们发版才拿得到修复。

**也不用 npm 运行时安装**——应用不带 npm，在用户机器上解 629 个包的依赖树，失败面太大。
改成我们自己打一个版本化归档（`scripts/build-rsshub-pack.sh`），下载 + 校验 sha256 + 解压，全程不碰包管理器。

适配器有三种模式（`packages/feed/src/adapters/rsshub.ts`）：

| 模式 | 说明 |
|---|---|
| `http` | 用户自己的实例，**优先级最高**。它返回标准 RSS，直接复用现成解析器，零新代码，而且比库模式快 3 倍（不用冷加载路由模块） |
| `library` | 下载好的资源包，`import()` 时必须用 `pathToFileURL()`，传文件路径在 ESM 下不可靠 |
| `off` | 都没有。**优雅降级不报错**——Telegram 是自己实现的，核心社交源不依赖它 |

**绝不内置任何公共实例作为默认。** 那等于把用户的阅读兴趣发给一台陌生服务器，跟产品承诺直接冲突。官方 `rsshub.app` 现在也已经 403 了。

**剔依赖是实测出来的，不是猜的**：

| 剔除 | 省 | 结果 |
|---|---|---|
| `@sentry` | 45MB | ✅ 剔掉。纯遥测，本地优先的软件不该带 |
| `@opentelemetry` | 30MB | ❌ 保留。**运行时硬依赖，init() 直接抛** |
| `youtubei.js` | 22MB | ❌ 保留。init 能过，但 YouTube 路由会在调用时挂 |
| `patchright` | 19MB | ❌ 保留。同上，浏览器类路由会挂 |

后两个虽然能剔，但会把失败**推迟到用户点某个源的时候，而且报「模块找不到」而不是真实原因**，比多 40MB 糟糕。

最终：**压缩 63MB，解压 370MB**。资源包放用户数据目录，应用更新不受影响，随时可删除腾空间。

### 已知缺口（计划里写了，代码里没有）

按影响排序，都不大但都是真缺口：

| 缺口 | 影响 | 属于哪个里程碑 |
|---|---|---|
| **首次运行同意流缺失** | 计划要求装后台任务前明确征询、给「现在装/以后再说」。renderer 和 main 都没有这个界面，后台调度是静默注册的 | M6 |
| **`openQuestions` 不持久化** | `packages/generate/src/progress.ts` 生成了这个字段但没存，等于每次都是一次性输出，攒不成「明天优先找」的线索——`WatchState` 设计里这是「进展」功能的一部分 | M4 |
| **每 Watch 输出语言，UI 未暴露** | `watches.output_lang` 字段和 `watch.ts` 的读写都有，但 `Watches.tsx` 里没有让用户单独设置某个 Watch 输出语言的控件，目前只有全局一个 | M2 |
| **UI 文案没有 i18n 框架** | 渲染层字符串硬编码中文，没有字符串表。计划要求「先出中文英文两套」——这里说的是界面本身，跟按 Watch 设置的*内容*输出语言是两回事，内容那条是做了的 | M1 |
| **「召回体检」工具缺失** | 计划要求一个工具汇总 R1/R2/R3 各自召回率、记录真实 token 用量，用来修正成本模型。现在只有 `judge.ts` 里按次记的日志，没有汇总脚本 | M3 |
| **`NEWS_DISABLE_*` kill-switch 没移植** | 老项目「离线调试复用本地快照」的开发工具没有对应实现，`PNR_IGNORE_ENV_KEY` 是个不同用途的旗标 | 验证方式 |
| **OSS Insight / Apify-X 适配器未实现** | `packages/core/src/types.ts:47` 和 `migrations.ts:23` 只留了 `apify_x` 这个类型占位，没有对应适配器；OSS Insight 连占位都没有。当前 11 种适配器里没有这两个 | M0 |

### 剩余工作

- **打包签名公证**（需 Apple 开发者账号）—— 唯一剩余的高风险项
- 上面「已知缺口」表里的各项
- 自动更新、一键卸载、贡献指南

### 打包时的图标接线（别漏了其中一半）

macOS 26 换了图标体系：系统自己画形状、阴影和高光，App 只交分层素材，
还要支持 Dark / Tinted / Clear 六种外观。26 以前仍然只认 `.icns`。
**两套都要放进包里，各认各的 Info.plist 键**：

| 放进 `Contents/Resources/` | Info.plist | 谁在用 |
|---|---|---|
| `assets/Assets.car` | `CFBundleIconName = AppIcon` | macOS 26+ |
| `assets/icon.icns` | `CFBundleIconFile = icon` | macOS 15 及更早 |

- 只给 `.icns` → 26 上能显示，但没有 Liquid Glass、不跟随深色/着色模式。
- 只给 `Assets.car` → 26 以前拿不到图标。
- `npm run icon:build` 需要 Xcode 26（用它的 `ictool` 和 `actool`）；
  产物已提交，所以**只有改图本身才需要 Xcode**，打包和日常开发都不需要。
- `actool` 自己也会顺手吐一个 `.icns`，但只到 256pt，Finder 大图标会糊，
  所以 `icon.icns` 由脚本按 Apple 的 Big Sur 网格（1024 画布里 824 的纸 +
  下移 8pt 的阴影）重新出一份完整尺寸的，那个网格数值是从 `actool` 的产物上量的。

### 踩过的坑（别再踩）

- **`total += await f()` 在并发 worker 里是丢失更新竞态**。JS 先读左值再 await，
  await 期间别的 worker 改了它，回来一加就覆盖。已在 `ingestAll` 修正为各 worker
  本地累加后 `reduce`。新增并发代码时注意同类写法
- **验证 feed 是否存活时，RDF（RSS 1.0，`<rdf:RDF>`）和 sitemapindex（条目是
  `<sitemap>` 不是 `<url>`）容易被误判成死链**。DW 和路透就是这么被误杀的
- **默认 Node UA 会被不少媒体 403**，`catalogs/verify.ts` 用的是 Safari UA
- **并发太高会自伤 429**（同域名多个 feed 同时打）。verify 并发降到 12，
  另有 `retry.ts` 单线程 + 每域名 2.5 秒间隔做第二轮捞回
- **Gemini 批量 embed 必须用 `contents: texts.map(t => ({ parts: [{ text: t }] }))`**。
  直接传 `string[]` 会被 SDK 当成**一条内容的多个 part**，只返回 1 条向量——
  静默出错，召回全废，而且照样计费。已在 `gemini.ts` 加数量校验兜底
- **sqlite-vec 的虚拟表不支持 `ON CONFLICT`**，要先 DELETE 再 INSERT
- **Node 的 `--experimental-strip-types` 不支持构造函数参数属性**
  （`constructor(private x: T)`），也不支持 enum / namespace / 装饰器。用显式字段
- **`import.meta.url` 在 esbuild 打成 CJS 后是 undefined**。主进程要用的资源
  （迁移 SQL 等）一律嵌进代码，不要在运行时读源码旁边的文件
- **defuddle 在 jsdom 下会往 stderr 刷超长选择器错误**，它内部吞掉了不影响结果，
  已在 `extract.ts` 里临时静音 `console.error`
- **`catalogs/build.ts` 只写 `candidates.json`**，`feeds.json` 由 `verify.ts` 产出。
  顺序是 build → verify → retry，别让 build 覆盖验证过的结果
- **Reddit 的 `.json` 接口已对未认证客户端封禁（403），但 `.rss` 仍开放**
- **AP 的 sitemap 对家用 IP 返回 403**，换什么请求头都没用。机房 IP 可以，
  所以 daily-brief 在 CI 里能用。已把 AP 移出默认启用
- **RSSHub 不能被 esbuild 打包**，必须 `--external:rsshub`。它用动态 glob
  （`import(\`./routes/${ns}/...\`)`）按路由分块，而且有顶层 await，打 CJS 必挂
- **动态 `import()` 传文件系统路径在 ESM 下不可靠**，必须 `pathToFileURL(p).href`。
  从下载的资源包里加载 RSSHub 时踩过
- **`.gitignore` 里不带前导斜杠的 `data/` 会匹配任意层级**，
  差点把 `catalogs/data/` 整个源目录排除掉。要写 `/data/`
- **RSSHub 自己往 stdout 写日志**（包括路由不存在时的完整堆栈），而且
  `LOG_LEVEL` 必须在 `import` **之前**设，它在模块求值时就读了。
  适配器另外还拦截了 stdout/stderr 兜底
- **不是所有源都有发布时间**（知乎日报等）。契约不许编造日期，但整源丢弃更糟：
  用首次发现时间并置 `publishedAtEstimated`，界面显示「发现于」而不是「发布于」
