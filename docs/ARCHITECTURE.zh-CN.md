# 所闻（personal-newsroom）架构

本文写的是**代码现在的样子**：每个模块做什么、数据怎么流、为什么这么做。
已定的产品决策和界面约定在 `AGENTS.md`，这里不重复；两边冲突时以代码为准，并同时修正两份文档。

## 1. 定位与第一原则

一个只给一个人工作、跑在他自己 Mac 上的新闻编辑部。管线来自同一作者的 `../daily-brief`
（所有读者看同一份报纸的双语新闻门户），这个项目保留管线，把上面的一切围绕单个读者重建。

**第一原则：少做有损压缩。** 不在用户和 AI 之间塞「编译」层——把「我想知道习近平最近在干什么」
编译成关键词再去匹配，编译漏一个别名，相关新闻就永远不出现，用户也不知道自己错过了。

| 场景 | 不这样做 | 这样做 |
|---|---|---|
| 判定相关 | 拿编译出的关键词匹配 | 用户**原话整段**进判定 prompt |
| 召回候选 | 关键词交集过滤 | 意图向量 + 别名 + 检索接口，三路**并集** |
| 用户纠偏 | 归一化成标签 | 存**原话**，原样喂回 |
| 进展对比 | 存 factHash | 存**完整叙述原文**（`told_records`） |
| 深度报道 | 压缩后的 evidence pack | **完整抽取正文** |

AI 生成的别名、相关词仍然有用，但只做**召回辅助**，不做判据：只做加法，不做减法。
所以 `RecallAids` 故意没有 exclude 列表，排除只发生在能看到完整上下文的 AI 判定层。

唯一的例外是**没有 AI 时**：关注退化成关键词匹配（`packages/recall/src/keywords.ts`），
界面标「关键词匹配 · 未经 AI 判断」。有 AI 时同一组关键词只进 R2 扩大召回。

## 2. 仓库结构

```
apps/
  desktop/     Electron 主进程：窗口、菜单、IPC（ipc.ts）、后台调度（schedule.ts）、
               唤醒组件（wake.ts）、社交源资源包（social.ts）
  renderer/    React 界面：今日 / 快讯 / 阅读 / 关注 + 新闻助手分栏 + 设置窗口
  worker/      无界面 worker，launchd 调起；daily / flashes / fetch / auto 四种模式
packages/      全是纯 Node，不依赖 Electron，worker 和测试都能直接用
  core/        DiscoveredItem 契约、URL 规范化去重、RichBlock、结构化日志、HTTP 下载、开关
  store/       SQLite schema（嵌在 TS 里）、sqlite-vec、locks 表、正文文件读写
  feed/        12 种源适配器、抓取入库、粘贴内容识别、RSSHub 资源包与精选路由
  reader-core/ Go 阅读核心的常驻子进程客户端
  reader/      下载页面 → 阅读核心抽正文 → 落盘；付费墙名单
  ai/          统一 Provider（Gemini / OpenAI / Claude / 兼容接口 / Ollama）、向量、计价、录放
  watch/       关注模型、预置主题、意图向量、召回辅助、纠偏
  recall/      R1/R2/R3 召回、批量判定、意图闸门、关键词匹配
  generate/    今日摘要、进展、快讯、关注之外、搜索补全、深度报道、新闻助手、流程编排
native/reader/ Go 程序 pnr-reader：Miniflux 解析/清洗 + go-trafilatura 抽正文
catalogs/      内置源目录（data/feeds.json）及构建、验证脚本；NOTICE 记来源与许可证
packaging/     worker helper、launch agent plist、签名 entitlements、打包用运行时依赖
scripts/       构建阅读核心、构建 RSSHub 资源包、准备打包、验包、同步 Miniflux
dev/           离线测试、体检工具、界面预览
```

`@pnr/core` 的 `DiscoveredItem` 是所有适配器的统一出口：去重、召回、判定、抽取、排序只写一次，
加一种源只是在 `packages/feed/src/adapters/index.ts` 加一项。

## 3. 一次「全部更新」

流程在 `packages/generate/src/pipeline.ts`，App 的按钮和后台 worker 共用，不许各写一份。

```
runDaily
  ingestAll            抓所有启用的源（8 并发），30 天以前的条目不入库
  enrichPending        给最新条目抽正文（feed 自带 ≥150 词全文就不抓网页）
  对每个关注 matchWatch
    prepareWatch       意图向量（原话 embed）+ 召回辅助（AI 生成别名、相关词）
    recallForWatch     R1 ∪ R2 ∪ R3 → 免费排序 → 截断到 40 条
    judgeAll           20 条一批判定，原话 + 纠偏原话进 prompt
    gateWatch          意图闸门
  enrichMatched        给过闸的报道补抽正文（写作要读正文，不读标题）
  writeProgress        进展：只在有新过闸报道时重读时间线
  writeFlashes         快讯：每种输出语言一次调用，只看没给模型看过的候选
  generateDigest       今日摘要：所有关注合并一次调用，只在 digestDue 时重写
  generateOutsidePicks 关注之外：一天一次
```

**顺序是硬约束**：进展必须在摘要和快讯之前。摘要和快讯会把说过的话记进 `told_records`，
先写它们，进展就会把今天的新事全当成「已告诉」。进展另外只读本次运行开始之前的记录（`toldBefore`）。

其他入口：

| 函数 | 按钮 | 做什么 |
|---|---|---|
| `runFlashCheck` | 快讯的 ↻、后台每 3 小时 | 抓取 → 最近 24 小时匹配（不走 R3）→ 写快讯 |
| `runWatch` | 单个关注的「立即更新」 | 抓取 → 只匹配这一个 → 有新过闸报道才重读进展 |
| `rewriteDigest` | 今日摘要的「重新生成」 | 只重写摘要，一次调用，不抓取不判定 |
| 抓取 | 阅读的 ↻ | 只抓订阅，`runs.kind = 'fetch'` |

**一切写作都是增量的**，`force`（按住 ⌥ 的「全部重新生成」）才全部重写：

| 步骤 | 何时才调用模型 | 记在哪 |
|---|---|---|
| AI 判定 | 没判过的 (关注, 条目) | `matches.judged_at` |
| AI 初筛（没有向量模型时） | 关注原话或纠偏变了 | `prescreen_results.fingerprint` |
| 进展 | 上次之后有新过闸报道，或关注被改过 | `watches.progress_at` |
| 快讯 | 有模型没见过的候选 | `flash_considered` |
| 今日摘要 | 今天没写过 / 换了语言 / 有新进展 / 有新关注有材料 | `digestDue` |
| 关注之外 | 今天没写过，或关注、语言变了 | `settings['outside.lastRun']` |

`runs.kind` 只能是 `daily`、`flashes`、`fetch`、`watch`、`digest`。worker 靠「今天目标时间之后有没有
成功的 `daily`」判断还要不要跑，所以单个关注的更新和重写摘要**不能**记成 `daily`；被锁跳过记 `skipped`。

## 4. 源与抓取（`packages/feed`）

### 适配器

| kind | 说明 |
|---|---|
| `rss` | RSS / Atom / RDF，走阅读核心解析；带 ETag / Last-Modified 条件请求 |
| `news_sitemap` / `news_sitemap_index` | Google News sitemap，路透这类没有公开 RSS 的媒体 |
| `telegram` | `t.me/s/<频道>` 网页预览，自己实现，不依赖 RSSHub |
| `hackernews` / `reddit` / `github` | 公开 JSON 接口；Reddit 用 `.rss`（`.json` 对未认证客户端已 403）；GitHub 的 `trending` 用搜索接口 |
| `googlenews` / `bingnews` | 搜索 RSS，R3 召回和深度报道的发现来源 |
| `gdelt` | 可选，默认关闭；熔断而不是退避（见 §11） |
| `rsshub` | 社交平台，三种模式见下 |
| `apify_x` | X（Twitter），用户自己的 Apify token |

适配器只返回 `DiscoveredItem`，不许编造日期：没有日期的条目用首次发现时间并标 `date_estimated`，
界面显示「发现于」。发布方声明的语言不可信，以阅读核心对正文的识别为准。

### 内置目录

`catalogs/data/feeds.json`：约 550 个源，42 个分类、24 个国家，12 个默认启用。
来源和许可证见 `catalogs/NOTICE` 和 §12。生成顺序是 `catalog:build`（只写 `candidates.json`）→
`catalog:verify`（产出 `feeds.json`）→ `catalog:retry`（单线程、每域名间隔 2.5 秒捞回误杀的）。

### RSSHub：按需下载，不随包发

微博、B 站、知乎、小红书、X 等没有 RSS，要靠 RSSHub。它是**库**不是服务器
（`init()` + `request(path)`，没有端口和进程管理），但依赖树 415MB，而且路由随网站改版常失效。
所以它不捆进应用，而是我们自己打的版本化资源包（`scripts/build-rsshub-pack.sh`：
压缩 63MB、解压 370MB），下载 → 校验 sha256 → 解压到用户数据目录，全程不碰包管理器。

| 模式 | 说明 |
|---|---|
| `http` | 用户自己的实例，优先级最高，返回标准 RSS，比库模式快 |
| `library` | 已下载的资源包，`import(pathToFileURL(p).href)` 加载 |
| `off` | 都没有，相关源优雅降级不报错 |

**绝不内置公共实例**：那等于把用户的阅读兴趣发给一台陌生服务器。
精选路由清单（`catalogs/data/rsshub-routes.json`）由 `npm run catalog:rsshub -- <资源包目录>`
实测生成，随对方风控变化，要隔段时间重跑。资源包剔掉了 `@sentry`（纯遥测）；
`@opentelemetry`、`youtubei.js`、`patchright` 必须保留，剔了会在调用时才以「模块找不到」失败。

## 5. 阅读核心（`native/reader`）

全 TS 决策的唯一例外。Trafilatura 没有 JS 版，而新闻正文抽取 F1：Trafilatura 0.926 vs Readability 0.825。

- **解析 / 编码 / 清洗**：Miniflux（Apache-2.0）的 reader 包，拷进 `third_party/miniflux`
  （`scripts/sync-miniflux.sh`，只改 import 路径；要加导出放 `_overlay`，不要改拷进来的文件）
- **正文抽取**：go-trafilatura（precision 模式）；Miniflux 站点规则优先，另有少量本项目规则
- **下载一律在 Node**：France 24 等按 TLS 指纹拦截，Go 客户端和 curl 403、Node fetch 200。Go 只处理字节，不联网
- `@pnr/reader-core` 按需启动子进程、崩溃重启、空闲时 unref
- 验收：34 个真实页面人工标注参考正文（`core/testdata/articles`），词级 F1 均值 ≥ 0.9

`@pnr/reader` 负责下载页面和落盘。只直连；用户在环境变量里给了 `JINA_API_KEY` / `FIRECRAWL_API_KEY`
才会经第三方抓取。正文存 `<数据目录>/bodies/` 下的文件，不进数据库；读取时去掉整段都是订阅推销的短段落。
**付费墙挡住就说挡住，阅读器一律不做搜索补全。**

## 6. 关注、召回与判定（`packages/watch`、`packages/recall`）

**关注（Watch）**：预置主题（`presets.ts`，37 个分 5 组，中英两套）和用户自己写的一句话走同一条管线。
字段要点：`intent`（原话，永不压缩）、`keywords`、`sensitivity`（宁可多看 / 平衡 / 宁可少看）、
`outputLang`（不填用全局）、`recallAids`（AI 生成、用户可见可改）。改了原话会清掉意图向量和召回辅助，
并让已判定的报道重新判定。

**召回：三路并集**（`recall.ts`）

| 路 | 做什么 |
|---|---|
| R1 向量 | 原话向量对近期条目向量做 KNN（sqlite-vec，0.75ms/次）。没有向量模型的服务商改用 AI 初筛（`r1_ai`），按原话缓存 |
| R2 别名 | 召回辅助的别名、相关词和关键词做 OR 命中，免费 |
| R3 检索 | 拿原话去查 Google News / Bing News 搜索 RSS，返回真实 URL，挂在占位源 `search:<关注>` 下。快讯检查不走 R3 |

另外把「还没下文的悬念」（`open_questions`）也拿去查。并集后先做**免费排序再截断**（全部更新 40 条、
快讯 30 条），这一步把成本降了 2.3 倍而质量没掉。

**判定**（`judge.ts`）：20 条一批一次调用，prompt 里放原话全文、最近纠偏的原话、标题和摘要，
返回 0–10 分和理由（理由原样给用户看）。

**意图闸门**（`gate.ts`）替换了 daily-brief 的「≥2 独立机构交叉验证」：个人新闻读 Telegram 和小众博客，
天然没有交叉验证，问题从「这条有没有新闻价值」变成「这条值不值得给这个人看」。

| 灵敏度 | 意图分 ≥ | 来源信任 ≥ |
|---|---|---|
| 宁可多看 | 0.45 | 0.25 |
| 平衡 | 0.60 | 0.35 |
| 宁可少看 | 0.75 | 0.50 |

判定失败时退回向量距离，不整批丢掉。「是不是新的」不在这里判断，交给能读到已告诉内容的进展和快讯。
**用户纠偏优先于一切**：最近一次 👍/👎 直接决定过不过闸（`corrections.ts`）。

## 7. 写作（`packages/generate`）

共同约定：

- **来源只能引用编号**：模型拿到的每份材料都有 id，输出里只写 `sourceRefIds`，代码校验 id 属于本次材料，
  不许自己写 URL。引用了不存在的编号就去掉或标「无来源」
- **写作风格集中在 `style.ts` 的 `writingRules()`**：短句、不堆定语、不写「周一」这类相对时间、不下评级式结论
- **材料读正文开头，不读标题**（`material.ts`）：只给标题会得到改写过的标题和套话
- 输出语言用户自己选，每次只生成一种语言；不是翻译，是读原文直接用目标语言写事实

| 产出 | 文件 | 要点 |
|---|---|---|
| 进展 | `progress.ts` | 每个关注一次。输入：过闸报道 + 已有时间线节点的**完整叙述** + 已告诉记录 + 悬念。首次跟进是建仓基线，进时间线但不标新；再跑同样材料 0 条新增。去重由模型返回 `existingMilestoneId`，代码校验它属于本次提供的节点。一篇报道可能含多个进展，不能因来源重叠就合并 |
| 今日摘要 | `digest.ts` | 所有关注**合并一次调用**。每节围绕「自上一期摘要以来」的新进展（`NEW`）写，用半句话交代前情。窗口 30 小时，某关注近期没材料时退回 3 天 |
| 快讯 | `flashes.ts` | 一条一件事。重要度 ≥ 6 才发，72 小时内去重，一条快讯可服务多个关注，`follow_up_of` 串起后续 |
| 关注之外 | `outside.ts` | 所有关注都没覆盖、但多家来源在报的事，最多 5 条，附「关注这件事」的建议。没有 AI 时按来源数本地挑。读取时只隐藏已被关注覆盖的那条 |
| 搜索补全 | `search-fill.ts` | **只在快讯的正文抓不到时**，对那一条已确定事件开厂商原生搜索。见下 |

**「新」有两种，互不影响**：摘要里的「新」= 自上一期摘要生成以来首次出现（`milestones.first_seen_at`）；
时间线上的「新」像未读邮件，时间线真正出现在屏幕上后记 `watches.seen_at`，之后不再标新，7 天没看也不算。

### 搜索只补细节，不做发现

照抄 daily-brief `lib/ai/gemini.ts:536` 的 `const usedSearch = !input.article;`：发现永远来自自己的源目录，
**只有正文抓不到时**才搜索补那**一条已确定事件**的细节。prompt 三道锁：锁定 `this exact event`、
锁定 `last 24 hours`、只写搜到的来源 `only facts they confirm`，确认不了就 `publishable: false`。
搜索只用来取证，发布文字由第二次结构化调用基于**本地下载、抽过正文的**来源写出；
结果标 `basis: 'search'`，材料存 `search_materials` / `search_material_sources`。每次运行最多补 5 条，
设置里可关。

## 8. 深度报道与新闻助手

**深度报道**（`report.ts`）：从文章、快讯或进展进入，在主区域以文档视图打开。
流程：用主题查 Google News 补相关报道 → 本地 30 天库里按关键词找 → 模型选至多 8 篇直接相关的 →
下载抽取**完整正文**登记为 `s1…sN` → 流式写作，每个单元带 `sourceRefIds` → 可追问，追问会再补材料。
会话和材料快照存 `conversations` / `conversation_messages` / `conversation_sources`；
崩溃遗留的 pending 回合启动时标为失败，失败的首稿不会被当成已存报道恢复。

**新闻助手**（`assistant.ts`，右侧分栏 ⌘J）：不绑定文章，问什么答什么。**是「搜索不做发现」的唯一例外**
（2026-09-22 用户要求）。每个问题：规划检索词 → 本地订阅（关键词 + 向量，30 天）→ 开着「联网」时
Google News（只当标题 + 摘要，kind `news`）和厂商原生网页搜索（网页本地下载抽正文，抽不到就不算来源）→
流式写作。溯源红线不变：模型只能引用本会话登记的 `sN`，引用不存在的编号改成「无来源」并在界面标明。

助手**知道左边打开的是什么**：界面只传「是哪一个」（`ScreenFocus`：文章、文章列表、摘要、关注之外、
快讯、关注、深度报道），主进程从数据库完整读取（`screen.ts`）。打开的文章整篇作为 s1；
App 自己写的摘要、时间线、快讯原样给模型，背后的文章登记成 `sN` 供引用。

**助手也是 agent**（`agent.ts` + `apps/desktop/src/agent-tools.ts`，2026-09-25 用户要求）：
每轮先跑一步「agent 步骤」（快模型，`operation: assistant_agent`，替代原来的检索规划，所以纯提问不多花一次调用）。
它决定走 `answer`（原来的带引用回答）、`tools`（调用工具，看到结果再走下一步，最多 6 步）还是 `done`（一句说明，单元 kind 为 `note`，不需要来源）。

- **工具 = 按钮背后的同一个函数**：`createApi`（ipc.ts）和 main.ts 的 `runs.*` / `refreshFeeds` 等，锁、`runs` 记录、进度消息照旧。约 45 个：关注（增删改、纠偏、立即更新）、订阅源（目录搜索、订阅/退订、添加/删除、RSSHub 路由）、阅读状态、今日/快讯/全部更新、深度报道、设置、后台、跳转页面。
- **风险等级写在工具定义里**（read / navigate / write / heavy / danger），模型改不了；**权限模式**（只看不改 / 每次确认 / 自动改危险的问我 / 全部自动，`settings.assistant.mode`，输入框胶囊和 ⇧Tab 切换）由 `gate()` 在主进程判定。卡片上「本对话不再询问此类」记在 `assistant_chats.allow_json`。
- 每次调用记一行 `assistant_actions`；卡片文字由工具从数据库算出（`view_json`），不用模型写的字。可撤销的记 `undo_json`，「撤销」调工具的 `undo`。待确认的 24 小时后过期；崩溃时进行中的记失败。模型标了 `more` 的改动确认后，界面以 `resume` 续跑同一个问题。
- **第一原则照旧**：关注的 `intent`、纠偏的 `note` 必须是用户原话；不是用户说过的话时卡片标黄，任何模式都改为确认。`update_watch` 没有 exclude 字段。
- **安全**：文章正文从不进 agent 步骤（工具只返回标题和 id，工具结果在 prompt 里标为不可信数据）；**填 API key / token 不做成工具**，像密钥的输入在本地拦下，不发给模型也不存。
- 离线测试 `npm run test:agent`（脚本化模型 + 真实工具 + 临时数据库）。

## 9. AI 层（`packages/ai`）

业务层只依赖项目自己的 `Provider` 接口（`generate` / `stream` / `embed` / `search`），
底下是 Vercel AI SDK。密钥直连厂商，不走任何网关。

| 服务商 | 写作 / 快速 / 向量默认值 | 原生搜索 |
|---|---|---|
| Gemini | `gemini-3.8-flash` / `gemini-3.5-flash-lite` / `gemini-embedding-2` | Google Search grounding |
| OpenAI | `gpt-5.6` / `gpt-5.4-mini` / `text-embedding-3-small` | Web Search（Responses API，`store:false`） |
| Anthropic | `claude-sonnet-5` / `claude-haiku-4-5` / 无 | Web Search，取证和结构化写作分两次 |
| OpenAI 兼容 | 用户填写，快速模型留空复用写作模型 | 无统一保证 |
| Ollama | `qwen3:8b` / 同写作 / `nomic-embed-text` | 无 |

- 默认模型 ID 集中在 `gemini.ts`、`vendors.ts`，设置里可覆盖；**不要绑定 2.5 Flash-Lite（2026-10-16 退役）**
- **无 key 闸门集中在这一层**：`resolveProvider` 返回 null，上层只问一次，所有 AI 功能优雅降级成
  关键词匹配和纯 RSS 阅读器，不报错不空白
- **向量代次**：向量统一请求 768 维；换了向量模型就把 `ai_runtime.vector_generation` 加一并清空所有向量，
  不同模型的向量绝不混用。没有向量模型时改用 AI 初筛
- **Gemini 批量 embed** 必须 `contents: texts.map(t => ({ parts: [{ text: t }] }))`，传 `string[]`
  会被当成一条内容只返回 1 条向量（静默出错照样计费），`gemini.ts` 有数量校验兜底
- **计价**：每次调用记 `ai_requests`（tokens、搜索次数、费用），日志 attrs 带 `model` / `tokensIn` / `tokensOut`
- **录放**：`PNR_REPLAY=record` 把真实回答按 prompt 录到 `dev/snapshots/`，`replay` 离线重放、零成本

## 10. 存储（`packages/store`）

一个 SQLite 文件 `<数据目录>/newsroom.db`（默认 `~/Library/Application Support/personal-newsroom`，
`PNR_DATA_DIR` 可改），WAL 模式；正文是旁边的文件。备份就是拷这个文件夹。

schema 嵌在 `migrations.ts` 里（打包后的主进程读不到源码旁边的 .sql 文件）。**还没发布过版本，
所以现在只有一个 `001_schema`**；发布之后迁移只追加不修改。打开一个由未发布开发版建的库
（迁移名不认识）会直接报错，挪开重建即可。

| 分组 | 表 |
|---|---|
| 源与条目 | `sources` · `items` · `reading_state` |
| 关注 | `watches` · `corrections` · `matches` · `prescreen_results` · `open_questions` |
| 产出 | `digests` · `milestones` · `milestone_sources` · `told_records` · `flashes` · `flash_considered` · `outside_picks` |
| 搜索补全 | `search_materials` · `search_material_sources` |
| 深度报道 | `conversations` · `conversation_messages` · `conversation_sources` |
| 新闻助手 | `assistant_chats` · `assistant_messages` · `assistant_sources` · `assistant_actions` |
| AI | `ai_runtime` · `embedding_cache_meta` · `watch_vector_meta` · `ai_requests` · `embeddings`、`watch_vectors`（sqlite-vec） |
| 基础设施 | `locks` · `runs` · `events` · `circuit_breakers` · `settings` |

- **`told_records` 存完整叙述原文，不是 hash**，记录所有展示过的内容，这是进展和快讯判断「新」的依据
- milestone 的 id 带运行时间，否则同一天第二次运行的新节点会撞 id 被 `ON CONFLICT DO NOTHING` 静默丢掉
- sqlite-vec 是**运行时扩展**不是 Node 原生模块，不需要 electron-rebuild；虚拟表不支持 `ON CONFLICT`，要先删后插
- 向量约 3.2KB/条（2000 条/天 ≈ 2.3GB/年），每日任务跑 `pruneVectors(db, 180)` 删掉 180 天前的
- **单实例锁**：`locks` 表 + `BEGIN IMMEDIATE` + 15 秒心跳，过期可抢。不用文件锁：`kill -9` 后 flock 清理不可靠
- **worker → 界面**不走 IPC（界面可能没开）：worker 把结构化日志写进 `runs` / `events`，界面下次打开时读

## 11. 后台与唤醒（`apps/desktop/src/schedule.ts`、`wake.ts`、`apps/worker`）

**一个 launch agent**：签名包经 SMAppService 注册为 `com.yb311.personal-newsroom.background`，退回手写 plist 时叫 `com.yb311.personal-newsroom.update`（两个名字必须不同，见 AGENTS.md「踩过的坑」），每小时第 16 分钟运行 worker 的 `auto` 模式，
由 worker 判断：过了用户选的时间且今天还没跑 → 每日任务；距上次快讯检查 ≥ 2 小时 45 分 → 快讯；否则直接退出。
改时间不用重新注册，也不会有两个任务同时启动、重复判定同一批文章。

- **签名包走 SMAppService**（`app.setLoginItemSettings({ type: 'agentService' })`），plist 在 bundle 的
  `Contents/Library/LaunchAgents/`，出现在「登录项与扩展」，app 拖进废纸篓就消失
- SMAppService 拒绝没有开发者签名的 app（Electron 只在 stderr 打一行），所以读回状态，**失败就改用
  `~/Library/LaunchAgents` 里的手写 plist**，关掉开关时删掉
- 任务运行 bundle 内的「所闻 后台更新.app」（`packaging/worker-helper.mjs` 从 Electron Helper 复制改名），
  可执行文件名**必须以 " Helper" 结尾**，否则 Electron 找不到框架、启动即 SIGTRAP
- App 每次启动检查：版本变了就重新注册（新版本带新 worker）

**休眠时也要更新**：launchd 在 Mac 睡着时什么都不跑，所以要让 Mac 自己醒。`pmset schedule wake` 需要 root，
开启后台更新时装一个唤醒组件（输一次管理员密码）：`/Library/LaunchDaemons/com.yb311.personal-newsroom.wake.plist`
每小时和配置变化时运行 root 所有的 `schedule-wakes.sh`，约好未来 26 小时的唤醒（每日时间及之后每 3 小时，
都在 xx:15:50，赶上第 16 分钟的任务）。worker 计划运行时用 `caffeinate -i -s -w <pid>` 不让 Mac 睡回去，
并等网络就绪。

**提权边界**：root 脚本只调 pmset 和 date；它读的 `wake.conf` 归用户所有，只取数字和一个只做存在性检查的
app 路径——**绝不能让 root 执行 app bundle 里的任何东西**（bundle 用户可写）。app 被删后脚本发现路径不在了
就不再约唤醒。限制：合盖用电池时 macOS 可能不允许唤醒；非管理员账户装不了组件。

## 12. 实测记录

开工前（M-1，2026-09-20，macOS 15.7 arm64、Node 24.16、Electron 44.4）和开发中实测得到的结论。
代码注释里提到「实测」的地方指这里。

### 存储

better-sqlite3 13.x 是真正的 Node-API 构建（prebuildify 布局），跨 Node 和 Electron ABI 稳定，
**不需要 electron-rebuild**，但 `.node` 不能从 asar 里加载，要 `asarUnpack`。sqlite-vec 同理，
加载路径要把 `app.asar` 换成 `app.asar.unpacked`。插入 2000 条 768 维向量：Node 116ms / Electron 78ms。

### GDELT：不可靠，降为可选

文档说「每 IP 每 5 秒 1 次」，实测远不止：触发 429 后退避重试、静默 2/5/10 分钟都还是 429，
约 25 分钟后才恢复，恢复后 30 秒单发一次又 429。社区实测一致：**越退避越糟**，封锁是 IP 级的。
另外关键词短于 3 个字符时返回 **HTTP 200 + 错误文字**，429 返回纯文本不是 JSON，单查最多 250 条不能翻页。

所以：默认关闭；开启后收到 429 就**熔断 30 分钟**（`circuit_breakers` 表），期间直接跳过，**禁止退避重试**；
三种响应（JSON、纯文本 429、200 + 错误文字）都要处理；失败静默，GDELT 永远是加分项。
Horizon 能不管限流，是因为它跑在 GitHub Actions 上每次换 IP、一天只跑一次；桌面应用是用户家里一个固定 IP。

### Google News 搜索 RSS：R3 主力

`https://news.google.com/rss/search?q=<词>&hl=<语言>&gl=<地区>&ceid=<地区>:<语言>`。免费、无 key，
中英文查询各 100+ 条，**连发 8 次不同关键词全部 200**，关键词无长度限制，返回标准 RSS。
`hl`/`gl`/`ceid` 正好对上按关注设输出语言。Bing News 搜索 RSS 可用但条数少（约 5 条），作补充。

### RSSHub

npm 包是库不是服务器（见 §4）。零配置可用：Telegram、B 站热门、知乎日报、GitHub、Hacker News、36 氪（慢）。
微博需要浏览器（路由内部取访客 Cookie），X 需要用户 cookie。**B 站大部分路由现在也会退回浏览器模式**，
精选清单里只剩热门 / 每周必看 / 入站必刷。出错不抛异常而是返回 `{ error: { message } }`：
消息为空 = 路由不存在；含 `browserType.launch` = 需要浏览器（资源包不带）；含 `: 403` 之类 = 对方网站拒绝。

### Telegram

`t.me/s/<频道>` 无需登录、key、代理，每页 20 条，`?before=<id>` 翻页。部分频道关闭了预览。

### 其他源

- 默认 Node UA 会被不少媒体 403，验证目录用 Safari UA；同域名并发太高会自伤 429
- RDF（RSS 1.0）和 sitemapindex 容易被误判成死链（DW、路透就这么被误杀过）
- AP 的 sitemap 对家用 IP 返回 403，已移出默认启用
- OSS Insight 趋势接口 2026-03-01 起停用，「GitHub 新星仓库」改用 GitHub 搜索接口

### 成本（实测）

| | |
|---|---|
| 完整一天 | **$0.029**（抓 1092 条 + 抽正文 + 2 个关注召回判定 + 摘要 + 进展） |
| 快讯 + 深度报道 | $0.016 |
| worker 每日任务全程 | 59 秒，0 失败 |

目标是 15 美分/天。Gemini Flash 档 2027-01-01 起价格翻倍，所以**判定批量打包、写作跨关注合并**从第一版就做对了，
不是以后的优化。`npm run audit:recall` 按日志汇总各阶段真实花费。

## 13. 来源与许可证

项目是 **AGPL-3.0**：能直接使用 RSSHub（也是 AGPL）；防止被做成闭源 SaaS；作者是唯一版权人，将来可双许可。

内置目录的来源（详见 `catalogs/NOTICE`）：`plenaryapp/awesome-rss-feeds`（CC0）、daily-brief 自己的
`rss-catalog.ts`（注释记录了每个入口为什么这么选）、`Thysrael/Horizon`（MIT，借鉴的是非 RSS 源的端点和限流经验，
用 TS 重写）、`imsyy/DailyHotApi` 和 `ourongxing/newsnow`（MIT）。`kagisearch/kite-public` 的数据是 CC BY-NC，
与 AGPL 允许商用冲突，所以不搬它的文件，只取 URL 过我们自己的验证流水线，用我们自己的分类和权重。

## 14. 开发与验证

| 命令 | 做什么 |
|---|---|
| `npm run typecheck` | 全仓库类型检查 |
| `npm run test:ci` | CI 跑的离线测试全集（不联网、不花钱） |
| `npm run reader:build` / `reader:test` | 编译 / 测试 Go 阅读核心（含抽取基准） |
| `npm run doctor` | 只读地查环境、数据库、密钥、RSSHub，回显开关和阈值 |
| `npm run audit:recall` | 用 👍/👎 和可选标注文件量 R1/R2/R3、并集和「仅关键词」的召回率、判定准确度和各阶段花费（`PNR_DATA_DIR` 指向数据目录的拷贝） |
| `npm run preview` | 用真实数据目录的快照在普通浏览器里渲染界面（`PNR_DATA_DIR=… npm run preview`，先 `npm run build --workspace=@pnr/desktop`） |
| `npm run package:dir` | 打未签名目录包并跑 `scripts/verify-package.sh` |
| `npm run icon:build` | 从 `assets/AppIcon.icon` 重新生成图标（需要 Xcode 26，产物已提交） |

需要联网或密钥、不进 CI 的：`test:ingest`、`test:adapters`、`test:reader`、`test:rsshub`、
`test:pipeline`、`test:generate`、`test:flash-deep`、`test:ai-live`。`dev/full-run.ts` 是真实跑一整天并导出结果的手动脚本。

环境变量：

| 变量 | 作用 |
|---|---|
| `PNR_DATA_DIR` | 数据目录 |
| `PNR_DISABLE_FETCH` / `EXTRACT` / `SEARCH` | 离线跑流程（`@pnr/core` 的 `flags`） |
| `PNR_REPLAY=record\|replay`、`PNR_SNAPSHOT_DIR` | 录制 / 重放模型回答 |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 设置里没填密钥时的后备；`PNR_IGNORE_ENV_KEY=1` 忽略它们 |
| `JINA_API_KEY` / `FIRECRAWL_API_KEY` | 可选的第三方网页抓取 |
| `PNR_READER_BIN` | 指定阅读核心可执行文件 |
| `PNR_RSSHUB_PACK` | 测试和体检用的 RSSHub 资源包目录 |
| `PNR_WORKER_MODE`、`PNR_SCHEDULED_RUN` | launch agent 传给 worker |

`dev/today.test.ts` 用脚本化的假模型验证今日 / 快讯 / 进展的全部逻辑。改 prompt 会让录制的快照失效，要重新录。

发布流程见 `docs/RELEASING.zh-CN.md`。

## 15. 已知风险

| 风险 | 对策 |
|---|---|
| 「进展」最难：要分清真进展、换说法的重复、同主题无关新闻 | `told_records` 存完整原文让模型看全貌；三种情况（首次建仓、同样材料再跑、注入新发展）都有离线测试 |
| 向量召回漏掉「意图对但用词完全不同」的新闻 | 三路并集：R2 别名和 R3 检索补 R1 的盲区；判定便宜、漏召回贵，所以截断放宽 |
| 搜索补出来的内容可信度低于原文 | 三道锁；来源必须本地下载抽正文；`basis: 'search'` 在数据和界面都标出；只在写作侧，阅读器不用 |
| RSSHub 路由随上游改版失效 | 资源包按需下载可随时更新；Telegram 自己实现，核心社交源不依赖它 |
| 签名公证：带 launch agent 和子进程的 app 更严 | 发布流程已接好（`docs/RELEASING.zh-CN.md`），签名包和 DMG 都跑 `verify-package.sh` |
| Electron 包体 | 接受；RSSHub 不随包发 |
