# personal-newsroom — 从 daily-brief 引出的本地优先个人新闻软件

> 本文是开工前写的架构计划，决策部分仍然有效。**两处已被验证结果修订**（见
> `SPIKES.zh-CN.md`）：RSSHub 从「独立进程」改成「库调用」；R3 发现层主力从
> GDELT 换成 Google News 搜索 RSS。**当前实现状态和已知缺口见 `AGENTS.md` 的
> 「进度」一节**，不要以为这里写的都已经原样落地。

## Context（为什么做这件事）

`daily-brief`（`/Users/zhoujingxuan/Documents/GitHub/daily-brief`）是一个已经成型的双语新闻门户：约 58000 行 TypeScript，98 个提交，Next.js 16 + React 19，跑在 Vercel + Upstash Redis + Cloudflare R2 + GitHub Actions 上，AI 用 Gemini。它每天产出 13 篇深度报道、每 3 小时一批快讯、今日摘要和播客，质量门槛很高。

**它的问题不是能力不够，而是所有人看到的是同一份报纸。** 探索确认：整个仓库里没有用户账号、没有偏好存储、没有订阅关注、没有关键词提醒、没有任何按用户重排序的逻辑。story 上虽然有 AI 生成的 `tagsZh/tagsEn`，但只用来显示，不参与任何过滤或检索。排序完全是编辑部视角的。`git log` 里甚至有一条 `a57a99c Remove tomorrow watchlist from digest generation and display` —— 关注列表做过，又被删了。

`personal-newsroom`（`/Users/zhoujingxuan/Documents/GitHub/personal-newsroom`）目前是空壳，只有 README 和 LICENSE，README 已写好定位：*Local-first, intent-driven personal news intelligence for macOS*。

**第一件事是把 LICENSE 从 MIT 换成 AGPL-3.0**（理由见「许可证决定」一节）。现在改零成本，有贡献者之后再改会很痛。

**这个项目要做的是同一个编辑部，只给一个人工作，而且搬进这个人的电脑。**

## 贯穿全局的设计原则：少做有损压缩

这是整个项目最重要的一条，它决定了下面每一个模块怎么设计。

传统做法是在用户和 AI 之间塞一层「编译」：把「我想知道习近平最近在干什么」编译成一串关键词，再拿关键词去匹配。**这一层是脆弱的，而且它的错误是不可见、不可恢复的**——编译漏了一个别名，相关新闻就永远不会出现，用户甚至不知道自己错过了什么。

新原则：**把原始信息完整交给 AI，中间层只做加法不做减法。**

| 场景 | 不这样做 | 这样做 |
|---|---|---|
| 判断一条新闻是否相关 | 拿编译出的关键词去匹配 | **把用户原话整段放进判定 prompt**，让 AI 自己看着办 |
| 召回候选 | 关键词交集过滤 | 意图向量检索 + 别名 OR 召回 + Google 搜索发现，三路**并集** |
| 用户纠偏 | 归一化成标签存起来 | 存用户原话，原样喂回给 AI |
| 进展对比 | 存 factHash 摘要做比对 | 把「昨天完整说了什么」原文给 AI |
| 深度总结 | 压缩后的 evidence pack | 完整抽取正文（按需触发，量小，付得起） |
| 快讯判定 | 截断的 snippet | 完整标题 + 首段 |

**关键区分：编译出的关键词和别名仍然有用，但它们的职责从「判据」降级为「召回辅助」。** 编译错了最多多召回一些噪音，后面的 AI 判定会兜住；而如果拿它做过滤，编译错了就是永久丢失。

### Google 搜索 grounding 的职责：补细节，不做发现

daily-brief 已经给出了正确答案，照抄就行。`lib/ai/gemini.ts:536` 只有一行：

```ts
const usedSearch = !input.article;
```

全仓库 16 个 `useSearchTool` 调用点，**只有写快讯这一个是 true，其余全是 false**。含义很清楚：

- **发现永远来自自己的源目录。** 事件是 RSS 抓来的，已经确定存在了
- **只有正文抓不到时**（付费墙、Cloudflare、抽取太薄），才开 `googleSearch` 让模型去补**这个已确定事件**的细节

prompt 里三道锁（`gemini.ts:571`）：

> `ARTICLE is unavailable. Use Google Search to find reports from the last 24 hours about this exact event and write only facts they confirm. If you cannot confirm the event, set publishable to false.`

1. **this exact event** —— 不是自由发挥去发现新东西，是补一个已锁定的事件
2. **last 24 hours** —— 时间窗口锁死
3. **only facts they confirm / 确认不了就 `publishable: false`** —— 宁可不发，不编

而且 `NewsBrief` schema 上有 `basis: 'article' | 'search'` 字段，**产品层面记录了这条是读原文写的还是搜来的**，可区分、可追溯。

这比「用 grounding 做发现」既更严格也更有用：它顺手解决了付费墙问题——以前抓不到正文只能放弃或降级成摘要，现在可以补出可发布的内容，而且出处标记得清清楚楚。

**发现层不用 grounding，用返回真实 URL 的检索源**（GDELT、Google News 搜索 RSS）。它们和 RSS 一样是「源」，吐出来的是能拿去抓取验证的链接，不是模型转述。这样「少做有损压缩」和「一切可溯源」两条同时成立。

## 语言：用户自己选，而且能按关注分别选

不预设中文或英文，**输出语言是用户设置**：全局设一个默认，每个 Watch 还能单独覆盖（「国际政治我想看英文原味，国内科技给我中文」）。这本来就是「高度自定义」该有的样子。

**这条带来一个意外的简化。** daily-brief 每个字段都是双份的（`titleZh`/`titleEn`、`bodyZh`/`bodyEn`、`tagsZh`/`tagsEn`、`categoryZh`/`categoryEn`），因为它要同时服务中英两个站点。我们**一次只生成一种语言**，所以移植 schema 时把双份字段合并成单份 + 一个 `lang` 字段：

```ts
// daily-brief                      // personal-newsroom
titleZh: string                     title: string
titleEn: string                     lang: string      // 这条内容是哪种语言
bodyZh: string                      body: string
bodyEn: string
tagsZh / tagsEn / categoryZh / ...  tags / category
```

三个好处：**生成 token 直接减半**（15 美分/天的估算就是按单语言算的，双语要涨到 25–30）；prompt 短一半，本地小模型跑得动；schema 和校验逻辑都简单一半。

**注意这不是翻译。** 沿用老项目那条规则——`Write from the facts. Never just translate or reword the source headline.` AI 读英文原文，直接用中文写出事实，而不是先理解再翻译。这是 daily-brief 已经验证过的做法。

阅读器里的**原文永远是原文语言**，不动。v2 的翻译功能是给原文用的，和这里的输出语言是两回事。

界面文案走标准 i18n，先出中文和英文两套，其余交给社区。

## v1 交付什么

| | 内容 |
|---|---|
| **今日** | 每天一份的专属简报（日报）：每个 Watch 一节，**这一节围绕「自上一期以来的新进展」来写**；另有少量「关注之外的要事」和往期 |
| **快讯** | 实时短讯，只推过了你意图闸门的 |
| **阅读** | **简单阅读器**：按源／按时间浏览，直接读抽取好的原文，已读/收藏 |
| **关注** | Watch 管理：勾标签、写意图、看见并修改 AI 的召回辅助信息。**点进一个 Watch 是这件事从头到尾的完整时间线**，新增的里程碑高亮 |
| *按需* | 任意一条新闻都有「深入」入口，现场生成这一条的**内容总结**（带时间线和逐句溯源） |

**「进展」两种形态都做，但它们共用同一份数据。** 今日摘要的每一节以新增里程碑为主干写成正文，Watch 页的时间线是同一批里程碑的完整视图（新增的标「新」）——底层都是 `WatchState.timeline` 加上「哪些是新增的」这个标记。所以不是做两遍，是同一份数据两种渲染。真正难的是判断「什么算新增」，那个只做一次。

> 2026-09-22 修订：原设计在今日列表里另有一个「昨天到今天」分组，逐条列出新增里程碑。实际用下来它和摘要正文、快讯三处重复，用户分不清三者的区别，所以取消了这个分组：新进展写进摘要（`generateDigest` 的 `NEW` 输入），摘要每节的小标题上方标着所属关注，点它进 Watch 页时间线。

**v1 不做**：每天自动产出的深度报道（改成上面的按需入口）、播客/TTS、邮件订阅、分享卡片、双语 SSR 站点。

### 没有 API key 也能用：纯 RSS 阅读器模式

**不填 key 就能装完即用**，当一个干净的本地 RSS 阅读器：订阅、抓取、正文抽取、按源浏览、已读收藏、内置 900–1200 个源的目录随便挑。

这是这个项目最好的上手坡道。开源项目的首次启动卡点最致命——「先去申请一个 Gemini key」能劝退一大半人。让他先用起来，觉得好，再决定要不要花钱开 AI。

工程上的要求：**所有 AI 功能都要优雅降级，而不是报错**。没有 key 时今日/快讯/关注三个 tab 不是空白页，而是清楚说明「这些需要 AI，去设置里填一个 key 就能开」，并且告诉他大概一天花多少钱。填了 key 之后，之前抓下来的历史内容**立刻可以回溯生成**，不用从头等一天。

### 平台：只做 macOS

后台调度（launchd / SMAppService）、通知、签名公证、菜单栏都按 macOS 一条路做到最好。**README 里直说不支持 Windows 和 Linux，不抄诺**。先把一个平台做到人愿意用，比三个平台都半吊子强。

Electron 本身跨平台，所以将来要出另外两个平台，主要工作量在调度层和打包签名，不是推倒重来。

**明确放到 v2**：AI 整篇翻译、段落级中英对照、划词翻译、OPML 导入导出、按 Watch 维度浏览阅读器、问我的新闻库。
> 虽然 v2 才做，但 §「SQLite schema」里已经把 `translations`、`reading_state` 这些表留好了，v2 不需要改 schema。

## 已确认的技术选型

| 决策 | 选择 | 理由 |
|---|---|---|
| 桌面外壳 | **Electron** | 老项目 58000 行全是 TypeScript，Electron 主进程就是 Node，抓取/聚类/AI 管线原封不动能跑，省掉几个月移植。代价是安装包 150–200MB |
| 本地存储 | **SQLite + sqlite-vec** | 单文件数据库放 Application Support，正文和图片存旁边文件夹，备份就是拷一个文件夹。sqlite-vec 是纯 C 无依赖扩展，配 better-sqlite3 在 Electron 里是成熟组合 |
| AI 供应商 | **Vercel AI SDK 统一层：Gemini 优先 + OpenAI + Claude + OpenAI 兼容接口 + Ollama** | 业务层只依赖项目自己的 Provider 契约；密钥直连厂商，不经过默认网关。搜索能力按厂商实际工具证据判断，本地 Ollama 没有原生搜索时诚实降级 |
| 视觉语言 | **沿用 daily-brief 的报纸美学** | 见下 |

### AI 默认模型与能力（2026-09-21 复核）

默认模型集中在 `packages/ai/src/gemini.ts` 与 `packages/ai/src/vendors.ts`，设置里的高级字段可以覆盖；不要在业务包散写模型名。

| 服务商 | 写作 / 快速 / 向量默认值 | 结构化 | 原生搜索 | 说明 |
|---|---|---|---|---|
| Gemini | `gemini-3.8-flash` / `gemini-3.5-flash-lite` / `gemini-embedding-2` | JSON Schema | Google Search grounding | 向量固定请求 768 维；来源元数据本身也算搜索实际执行证据 |
| OpenAI | `gpt-5.6` / `gpt-5.4-mini` / `text-embedding-3-small` | JSON Schema | Web Search | 使用 Responses API，显式 `store:false`，向量固定请求 768 维 |
| Anthropic | `claude-sonnet-5` / `claude-haiku-4-5` / 无 | JSON Schema | Web Search | 搜索取证和结构化写作分两次请求 |
| OpenAI 兼容接口 | 用户填写；快速模型留空则复用写作模型 | 默认 JSON，可手动声明 Schema | 无统一保证 | 默认按 8K 输入预算；向量模型留空时改用 AI 初筛 |
| Ollama | `qwen3:8b` / 同写作模型 / `nomic-embed-text` | JSON | 无 | 启动时检查 `/api/tags`；实际上下文由用户填写的本地配置决定 |

验证分层：`npm run test:ai` 不需要密钥，使用真实 AI SDK 和模拟 HTTP 覆盖 Responses、Chat Completions、SSE、schema、来源、错误、取消和用量，再覆盖多 Watch 初筛及向量换代；`npm run test:ai-live` 才是需要真实 Gemini 密钥的付费实测。缺少密钥不会被计作离线测试通过。

### 视觉语言：直接移植 daily-brief 的设计 token

`app/globals.css`（7021 行，单文件全局 CSS，普通 class，无 Tailwind）里的 `:root` 变量整套搬过来，深色模式也是现成的：

```
--bg: #f5f2eb        米白报纸底      --accent: #c0392b     砖红强调
--fg: #1a1a1a        近黑正文        --border: #d0cdc4
--card-radius: 2px   几乎直角        --serif: 'Noto Serif SC', 'Playfair Display'
                                     --mono:  'JetBrains Mono'
```

这套「印刷报纸」语言正好适合新闻阅读，而且已经在深浅两个模式下调过。新项目以它为起点，只增不改。`components/ui/rich-content.tsx`（`RichBlock[]` 渲染器）和 `components/news/news-portal.tsx` 的 tab 外壳结构一并参考。

## 不做 fork，按需移植

daily-brief 里约一半代码（`lib/narration/*` 播客 TTS、`lib/user/newsletter.ts` 邮件广播、`app/api/share/*` 分享卡片与微信、`app/[lang]/*` 双语 SSR）用不上，且深度绑定 Vercel / Upstash / R2 / GitHub Actions。新建干净仓库，只移植下面这些**已经调试过、真正值钱**的模块。

| daily-brief 源文件 | 价值 | 移植后改动 |
|---|---|---|
| `lib/feed/rss-catalog.ts` | 27 家主流媒体、约 150 个 feed URL，注释记录了每个入口**为什么这么选**（AP 的 RSS 返 401 且被 robots 禁、CNN 老 feed 2023 年就冻结、Reuters 没有公开 RSS 只能走 sitemap index、Politico sitemap 被 Cloudflare 403） | 注释是血汗经验，原样保留。`FeedConfig` 扩展出 `rsshub` / `telegram` 源类型 |
| `lib/feed/parsers/*` | `DiscoveredItem` / `ParseResult` 契约，RSS/Atom + Google News sitemap 解析器，不变量明确（日期必须真实不许编造、URL 去跟踪参数、标题非空） | 原样。**这个契约是新增源类型的统一出口**——HN、Reddit、Telegram、GDELT 等新适配器只要吐 `DiscoveredItem`，下游所有逻辑（去重、聚类、排序、抽取）一行不改就能用 |
| `lib/feed/multi-layer-fetch.ts` | 三层抓取阶梯：直连 → Jina Reader → Firecrawl | 原样，Jina/Firecrawl key 用户可选填 |
| `lib/feed/feed-transport.ts`、`fetch-orchestrator.ts` | HTTP 传输层、浏览器式请求头、重试 | 去掉远程 Vercel `/api/fetch` 分支 |
| `lib/evidence/evidence-source.ts` | `canonicalDedupKey()` URL 规范化去重（折叠 `www./m./amp.`、保留 query）、新鲜度窗口、每域名配额、可达性探测 | 全局可信白名单改为**用户可编辑的每源信任设置** |
| `lib/evidence/evidence-cluster.ts`（1594 行） | 事件聚类：768 维 embedding → 三路召回 → 确定性分类器 → LLM 成对判定（温度 0、判决缓存）→ 保守并查集 | **≥2 独立机构的交叉验证闸门换成意图闸门**（见 §C） |
| `lib/evidence/evidence-rank.ts` | 新鲜度/交叉验证/权威度/公共影响/事件原发性五维打分 | 保留为「客观重要性」一维，权重大幅下调 |
| `lib/evidence/evidence-enrichment.ts`（1655 行） | 正文抽取：defuddle 和 @extractus/article-extractor **并行跑、按词数取胜**，两者都薄时结构化 DOM 兜底；词数预算；付费墙域名跳过名单 | **地位升级**：从生成管线的一环变成阅读器直接对用户的服务 |
| `lib/ai/gemini.ts` 的两阶段写作 | `generateStoryBodyFromEvidencePack` + `generateStoryHeadlineFromBody`，`sourceRefIds` 绑定机制（模型不许自己写 URL，只能引用已绑定的来源 id） | 改造成**按需深度总结**的引擎 |
| `lib/ai/semantic-embeddings.ts` | 向量封装 + 缓存 | 缓存从 Redis 换 SQLite；**地位升级为主召回路径** |
| `lib/news/brief-service.ts` + 快讯 triage prompt | LLM 0–10 重要度评分卡、`new / follow_up / already_published` 三分类、对比 72 小时窗口（比显示窗口宽，因为媒体常晚一两天才报同一件事）、`relatedFlashId` 后续链 | 评分卡从「对世界重要」改为「对这个用户重要」，prompt 里带用户原话 |
| `lib/news/story-timeline.ts` | 3–12 个里程碑时间线，**只用手上已有材料构建**，硬校验闸门（里程碑日期不能晚于它引用的所有来源——事件不能在发生前被报道） | 演化成「进展」功能的骨架，同时服务按需深度总结 |
| `lib/storage/historical-retrieval.ts`（1040 行） | 90 天混合检索：词法 + 向量 + **实体共现图** + 时间角色分类 | 存储层换 SQLite |
| `lib/core/schemas/*` | Zod schema + 平行 JSON Schema，所有 LLM 调用结构化输出，配 `jsonrepair` 抢救畸形输出 | 原样。这是让 LLM 输出可靠的关键 |
| `lib/core/retry.ts`、`logging.ts`、`config.ts`、`debug-artifacts.ts` | 固定字段的结构化日志信封、分阶段 kill-switch、集中式配置 | 原样 |
| `lib/prompts/news/editorial-rules.ts` | 编辑规则行既注入 prompt **又当作生成后的正则闸门**（过度断言模式、事实风险模式） | 原样，这个双重用法很聪明 |
| `app/globals.css` + `components/ui/rich-content.tsx` + `lib/user/scroll-position.ts` | 设计 token、富文本块渲染器、滚动位置 | 原样移植 |

## 架构设计

### A. Watch —— 标签和意图的统一抽象

标签不是被意图取代，**标签是预置好的 Watch**。用户勾「科技」，系统创建一个 `origin: 'preset'` 的 Watch，它带一段预写的意图描述；用户写一句话，创建 `origin: 'intent'` 的 Watch。**之后两者走完全相同的管线**，用户也能把预置标签改成自己的样子（改了就变成 `customized`）。

```ts
type WatchOrigin = 'preset' | 'intent' | 'customized';

interface Watch {
  id: string;
  origin: WatchOrigin;
  label: string;               // 显示名（预置标签就是「科技」）
  intent: string;              // ★ 用户原话，判定时原样进 prompt，永不压缩
  outputLang?: string;         // 这个关注的输出语言；不填则用全局默认
  active: boolean;
  intentVector: Float32Array;  // 原话的 embedding，主召回路径，存 sqlite-vec
  recallAids: RecallAids;      // 召回辅助——只做加法，不做减法
  state: WatchState;
  corrections: Correction[];   // 用户原话形式的纠偏
}

interface RecallAids {         // AI 生成，用户可见可改，错了不致命
  aliases: string[];           // 「习近平」→「Xi Jinping」「习主席」
  relatedTerms: string[];      // 扩大召回用
  sourceHints: string[];       // 「这类内容多半在这些源」
  updatedAt: string;
  // 注意：没有 exclude 列表。排除只发生在 AI 判定层，因为那里能看到完整上下文。
  // 关键词级别的排除是典型的「有损压缩」——「苹果」排掉水果会连带排掉苹果公司的农业投资新闻。
}

interface WatchState {              // 「我已经告诉过你什么」—— 进展功能的基础
  toldSoFar: ToldRecord[];          // ★ 存完整叙述原文，不是 hash
  timeline: Milestone[];            // 复用 story-timeline 的里程碑结构
  //   每个 Milestone 带 firstSeenAt：今日摘要把自上一期以来新增的写进每一节，
  //   Watch 页时间线渲染全部并高亮同一批。两种形态，一份数据，一次判断
  openQuestions: string[];          // AI 记下的「还没下文的悬念」，明天优先找
  lastRunAt: string;
}

interface Correction {
  itemId: string;
  verdict: 'wanted' | 'not_wanted';
  userNote?: string;           // ★ 用户自己写的理由，原样进 prompt
  at: string;
}
```

**没有「编译」这一步。** 用户原话直接 embed 成 `intentVector`，直接进判定 prompt。`recallAids` 是 AI 在后台生成的辅助材料，随时可以重新生成，用户也能手改——但它只用来**扩大**候选，不用来**筛掉**任何东西。

**冷启动**：新建 Watch（包括勾一个标签）立刻做两件事——拿用户原话去查 GDELT / Google News 搜索，把过去 7 天的相关报道抓回来抽取；同时回溯本地已有的历史。产出一份**建仓简报**，并初始化 `timeline` 和 `toldSoFar`，第二天的「进展」才有对比基线。

**UI 原则**：`recallAids` 摊开给用户看（「我在用这些别名帮你找」），可改。但用户不需要为了让它工作而去改——改是锦上添花，不是必需品。这跟「编译出的关键词必须改对否则不工作」是完全不同的体验。

### B. 召回与判定 —— 三路并集，一次判定

| 层 | 做什么 | 成本 | 幸存量（每 Watch） |
|---|---|---|---|
| **R1 向量召回**（主） | 用户原话的 `intentVector` 对当天 item 向量做 top-N。**不需要编译，原话是什么就是什么** | embedding 按 item 缓存（`canonicalDedupKey` 作 key，永久有效），多个 Watch 命中同一条只付一次 · 约 1.5 分/天 | 2000 → 40–80 |
| **R2 别名召回** | `recallAids` 的别名和相关词做 OR 命中，`minisearch`（老项目已有依赖）本地倒排 | **免费** | + 20–40 |
| **R3 检索源发现** | 用用户原话（和别名）去查**返回真实 URL 的检索接口**：**Google News 搜索 RSS**（主力，免费无 key，实测连发 8 次无限流，每次 100+ 条，`hl`/`gl`/`ceid` 支持按 Watch 设语言）+ Bing News 搜索 RSS（补充，daily-brief 已在用）+ GDELT（可选，默认关闭，限流严重见 SPIKES）。**产出的 URL 一律走本地抓取验证。不用 grounding** | **免费** | + 0–40 |
| **判定** | 三路**并集**去重后，**20 条打包一次调用**。prompt 里放用户原话全文 + 纠偏原话 + 完整标题首段，输出 `{id, score 0-10, reason}` | flash-lite 档，约 1.5 分 | → 5–12 |
| **写作** | 今日摘要 1 次（所有 Watch 的入选项**合并成一次调用**）+ 快讯每批 1 次 + 进展对比每 Watch 1 次 | 约 12 分 | 最终产出 |
| **细节补全** | 仅当入选项的正文抓不到时，对那一条开 `googleSearch` 补细节（照抄 `writeNewsBrief` 的三道锁），结果标 `basis: 'search'` | 按请求计费，触发量小 | —— |

按 2026 年 9 月实际报价（Gemini embedding $0.15/M；3.1 Flash-Lite $0.25 in / $1.50 out；3.x Flash $0.75 in / $3.75 out），**合计约 15 美分/天**。R3 的两个检索接口免费，细节补全按触发量计，通常只有零星几条。

⚠️ **Flash 档的 $0.75/$3.75 是促销价，2027 年 1 月 1 日翻倍到 $1.50/$7.50。** 翻倍后约 25–30 美分/天。这意味着**判定的批量打包和写作的跨 Watch 合并从第一版就必须做对，不是以后再优化的事**。另外 Gemini 2.5 Flash-Lite（更便宜）2026 年 10 月 16 日退役，不要绑定它。

按需深度总结和翻译是用户主动触发的，不计入日常成本，但同样按 item 缓存，同一条不重复生成。

**Ollama 模式**：R1 换本地 embedding（nomic-embed / bge-m3），判定和写作本地跑。**R1/R2/R3 三路召回全部照常工作**（GDELT 和 Google News 都是免费 HTTP 接口，跟模型无关），只失去「细节补全」那一步——正文抓不到的条目在本地模式下只能降级或跳过。慢且弱是真问题，对策是收紧 R1 的 top-N，并给本地小模型一套更短更结构化的 prompt——长 prompt 是本地小模型的主要失败源。

### C. 用意图闸门取代交叉验证闸门

老闸门在 `lib/evidence/evidence-cluster.ts:1553` 是**单点**：`cluster.independentOrgCount >= 2`，而且 `allClusters` 已经和 `eligibleClusters` 一起返回了。换闸门是外科手术式改动——只换那个 filter 的判据。

```
show = intentMatch ≥ τ_intent
       AND novelty ≥ τ_novelty
       AND (sourceConfidence × importance) ≥ τ_quality
```

- **`intentMatch`** — 判定层的 LLM 分数归一化；不可用时退化用 R1 余弦
- **`sourceConfidence`** — 变成**每用户、每源**。用户自己加的源 0.9（他自己选的就是信任）／内置精选媒体沿用 `AUTHORITY_WEIGHTS`（AP/Reuters 1.0 → Fox 0.82）／社交内容 0.5 起
- **`novelty`** — 拿 `toldSoFar` 的**完整叙述原文**给 AI 比对，问「这条相对于我昨天说过的，有新东西吗」。这是「只说变化」的执行点
- **`importance`** — 沿用 `evidence-rank.ts` 的客观分，但**权重大幅下调**：个人新闻里「对世界重要」是次要的，「对你重要」是主要的

阈值不暴露给用户，合成一个滑条：**「宁可多看」↔「宁可少看」**。给手感，不给数字。

### D. macOS 后台执行

**进程划分**：UI 进程（Electron）只读 SQLite、渲染、编辑 Watch，随时可关；Worker 是无界面 Node 进程，跑抓取/过滤/生成。

**选 `SMAppService`（macOS 13+）而不是手写 `~/Library/LaunchAgents/*.plist`**：plist 嵌在 app bundle 的 `Contents/Library/LaunchAgents/` 里，会出现在「系统设置 → 通用 → 登录项」让用户自己管，**卸载就是把 app 拖进废纸篓**，plist 跟着消失。手写 plist 在 Ventura 之后一样会进登录项列表，没有额外好处，却会在卸载后留垃圾。**SMAppService 只接受带开发者签名的 app**（本地未签名包会报 code signature doesn't meet the requirements），所以本地构建和开发模式退回到 `~/Library/LaunchAgents` 里的手写 plist，关掉开关时删掉。

**进程名**：两个任务都运行 app 里单独的 `Contents/Frameworks/所闻 后台更新.app`（从 Electron Helper 复制改名，`packaging/worker-helper.mjs`），活动监视器里显示「所闻 后台更新 Helper」，权限弹窗用 bundle 名「所闻 后台更新」。可执行文件名**必须以 " Helper" 结尾**：Electron 靠这个后缀认出 helper 才去上三级找框架，别的名字启动即崩。

**调度**：只有一个任务，`StartCalendarInterval` 每小时第 16 分钟，worker 的 `auto` 模式判断是写每日摘要（过了用户选的时间、今天还没跑）、查快讯（距上次 ≥ 2 小时 45 分）还是直接退出。改时间不用重新注册，两个任务同时启动、重复判定同一批文章的问题也没有了。

**休眠时更新**：launchd 在 Mac 睡着时什么都不跑，只在醒来后补跑一次，所以要让 Mac 自己醒。`pmset schedule wake` 需要 root，于是开启后台更新时装一个唤醒组件（输一次管理员密码）：`/Library/LaunchDaemons/com.yb311.personal-newsroom.wake.plist` 每小时和配置变化时运行 root 所有的 `schedule-wakes.sh`，只调用 pmset 和 date，约好未来 26 小时的唤醒（每日时间，以及之后每 3 小时，都在 xx:15:50，正好赶上第 16 分钟的任务）。worker 在计划运行时用 `caffeinate -i -s -w <pid>` 不让 Mac 睡回去、等网络就绪再开始，跑完自动放开。配置 `wake.conf` 归用户所有，改模式和时间不用再输密码；它记着 app 的位置，app 被删掉后就不再约唤醒。限制：合盖且用电池时 macOS 可能不允许唤醒；普通（非管理员）账户装不了组件。

**单实例锁**：Redis 没了，用 SQLite 自己。一张 `locks` 表，`BEGIN IMMEDIATE` 事务拿锁，存 `{ name, holderPid, heartbeatAt, expiresAt }`，心跳 15 秒（沿用老项目节奏），过期视为死锁可抢占。WAL 模式让 UI 读不被写阻塞。**不用文件锁**——进程被 `kill -9` 后 flock 在 macOS 上的清理语义不够可靠，而心跳过期是显式的。

**Worker → UI 通信**：不用 IPC（UI 可能根本没开）。Worker 把结构化日志（沿用 `lib/core/logging.ts` 的固定字段信封）写进 SQLite 的 `runs` / `events` 表，UI 启动时读出来渲染「最近几次运行」和错误；失败时发一条系统通知。

**首次运行同意流**：明确说「要装一个后台任务，这样你不开软件它也能帮你收新闻」，给「现在装／以后再说」，设置里随时能关。

### E. 阅读器（v1 简单版）

正文抽取从「生成管线的一环」变成直接对用户的服务。

**【已改，2026-09-21】** 原计划沿用 `evidence-enrichment.ts` 的双引擎（defuddle vs extractus 按词数取胜 + 结构化兜底）。实际用下来「按词数取胜」会让把导航、推荐区一起抓进来的那个引擎胜出（Japan Times 一篇抓出 22 个导航列表、32 张图），而且自写的 XML 解析不解数字实体、不识别 GBK。现改为 Go 阅读核心 `native/reader`：

- **解析 / 编码 / 清洗**：直接复用 Miniflux（Apache-2.0）的 reader 包，含它自带的测试
- **正文抽取**：go-trafilatura（Trafilatura 2.2 的 Go 移植，同一测试集 F1 0.914 vs Python 版 0.912），precision 模式；Miniflux 站点规则优先，另有少量本项目站点规则
- **下载留在 Node**：部分网站按 TLS 指纹拦截 Go 客户端
- **优先用 feed 自带全文**，够 150 词就不抓网页
- 验收：34 个真实页面（含 GB2312 页面）人工标注参考正文，词级 F1 均值 ≥ 0.9

v1 只做四件事：

- **按源／按时间浏览** —— 传统 RSS 阅读器的基本形态
- **原文直读** —— 抽取结果用 `rich-content.tsx` 的 `RichBlock[]` 渲染器显示
- **抓不到就说抓不到** —— 付费墙、Cloudflare 挡住时诚实降级到摘要 + 一个「在浏览器打开」按钮，不拿摘要冒充正文。注意这里和写作侧的「细节补全」是两回事：**阅读器不做 grounding 补全**，因为读原文的场景下模型转述冒充不了原文；补全只发生在我们自己写摘要/快讯的时候，而且会标 `basis: 'search'`
- **阅读状态** —— 已读、收藏、滚动位置（`lib/user/scroll-position.ts` 有现成实现）

翻译三件套、OPML、按 Watch 维度浏览，全部 v2。

### F. 按需深度总结

任意一条新闻（摘要里的、快讯里的、阅读器里的）都有「深入」入口。点了之后现场跑：

1. `relatedReportsForStory`（共享实体 ≥2）从本地库里找这条的相关报道
2. 用这条的标题和实体去查 GDELT / Google News 搜索，补本地库里没有的相关报道，**拿到的 URL 走本地抓取验证**
3. `enrichEvidenceForStory` 抓并抽取这些报道的正文
4. 两阶段写作生成内容总结，**输入是完整抽取正文而不是压缩后的 evidence pack**（按需触发，量小，付得起）
5. 若关键报道的正文抓不到，对那几条走「细节补全」（`googleSearch` + 三道锁），并在总结里标出哪些依据是搜来的
6. `story-timeline` 生成时间线，走那个硬校验闸门
7. **`sourceRefIds` 绑定机制保留**：模型不许自己写 URL，只能引用已绑定的来源 id，所以总结里每一句都能点回原文那一段

结果按 item 缓存。这就是「来源验证、原文查找、来源理解」那一条龙的最后一环。

### 新仓库模块布局

```
personal-newsroom/
├── apps/
│   ├── desktop/            Electron 主进程 + 窗口 + SMAppService 注册 + 首运行同意流
│   ├── renderer/           React UI（今日 / 快讯 / 阅读 / 关注 四 tab + 设置）
│   └── worker/             无界面 worker 入口，供 launchd 调起
├── packages/
│   ├── feed/               ← 移植 lib/feed/*，src/adapters/ 下 12 种源适配器
│   │                         （rss/sitemap/sitemapindex/telegram/hackernews/reddit/github/
│   │                         googlenews/bingnews/gdelt/rsshub/apify_x）。OSS Insight 的趋势接口
│   │                         2026-03 起官方停用，改用 GitHub 搜索接口做「新星仓库」（github 源的 trending）
│   │                         【已改】RSSHub 不是独立包/独立进程，是 feed 包里的一个适配器
│   │                         （见 SPIKES §2：它是库不是服务器，`await request(path)` 直接拿数据，
│   │                         没有端口/健康检查/崩溃重启这些东西，此处原计划已作废）
│   ├── evidence/           ← 移植 lib/evidence/*，闸门换成意图闸门
│   ├── watch/              【全新】Watch 模型、recallAids 生成、纠偏、预置标签目录
│   ├── recall/             【全新】R1/R2/R3 三路召回 + 批量判定编排
│   ├── reader/             【全新】正文服务、阅读状态（v2 扩翻译）
│   ├── ai/                 Provider 抽象（Gemini / OpenAI / Claude / 兼容接口 / Ollama）+ 统一生成、流式、向量与搜索取证
│   │                         + 移植 semantic-embeddings
│   ├── store/              【全新】SQLite schema、迁移、sqlite-vec、locks、runs/events
│   ├── generate/           摘要、进展、快讯、搜索补全、深度报道、新闻助手与视野补充
│   └── core/               ← 移植 schemas / retry / logging / config / debug-artifacts
└── catalogs/               内置源目录 + NOTICE + 许可证归属
```

`packages/*` 全是纯 Node，不依赖 Electron —— worker 能独立跑，测试能在 CI 里跑，将来做 CLI 或其他平台不用重构。

### SQLite schema（一次设计到位）

`sources` · `items`（原始条目 + 正文指针 + 抽取状态）· `watches` · `matches`（item × watch 的分数与 AI 给的理由）· `digests` · `flashes` · `milestones` · `search_materials` · `assistant_chats` / `assistant_messages` / `assistant_sources` · `outside_picks` · `translations` · `reading_state` · `embeddings`（sqlite-vec）· `ai_requests` · `runs` / `events` · `locks`。

迁移 006–010 分别负责多厂商 AI 运行态、可溯源搜索补全、深度报道会话、视野补充和新闻助手。新闻助手保存每一轮实际使用的完整材料快照；旧 `deep_summaries` 在发现演示库仍有数据后改名为 `legacy_deep_summaries` 备份，不参与新功能。

这张表单覆盖 v1 全部内容加 v2 的翻译，不留「以后再加表」的坑。

## 信源策略

三层：**打包进仓库的精选目录** + **运行时可导入的外部目录** + **用户自定义**。

已经做过许可证尽调——「反正也不要钱」是对的，但**免费不等于能打包进 MIT 项目再分发**。

### 内置目录的来源

| 来源 | 许可证 | 内容 |
|---|---|---|
| **`Thysrael/Horizon`** | **MIT** | ⭐ 目前最接近的项目，最有价值的不是源列表而是**源适配器的实现知识**：10 种源类型的端点、鉴权和限流做法——Hacker News（含 top-N 评论）、Reddit（子版/用户帖 + 评论摘要）、Telegram 公开频道、Twitter/X（走 Apify）、GitHub（用户事件 + 仓库 release）、**GDELT**（全球新闻库，支持自定义查询）、Google News 搜索 RSS、OSS Insight 趋势仓库、OpenBB 财经。另有配套的 `Thysrael/Horizon-Site` 社区源市场 |
| **`plenaryapp/awesome-rss-feeds`** | **CC0-1.0（公共领域）** | 约 500 个推荐源 + 250+ 国家新闻源，覆盖 25+ 国家、40+ 主题分类，全是 OPML。**零法律风险，最好的打包对象** |
| **`imsyy/DailyHotApi`** | **MIT** | 50+ 中文平台：B站、微博、知乎、抖音、快手、豆瓣、贴吧、V2EX、百度、头条、新浪、网易、腾讯新闻、澎湃、CSDN、IT之家、少数派、掘金、简书、虎扑、酷安、NGA、NodeSeek、52破解、虎嗅、爱范儿、果壳、HelloGitHub，外加天气预警、地震速报、历史上的今天 |
| **`ourongxing/newsnow`** | **MIT** | 40+ 中文源，源定义在 `shared/sources` 和 `server/sources`，有完整类型定义 |
| **daily-brief 自己的 `rss-catalog.ts`** | 自有 | 27 家国际主流媒体、约 150 个 feed URL，带「为什么这么选」的注释 |
| **`kagisearch/kite-public`** | 数据标 CC BY-NC | 社区维护的高质量目录，门槛是每个分类至少 25 个源、只收公开 RSS 不爬站。**取 URL、独立验证、并进我们自己的目录**，不搬他们的文件（见下） |

合并去重后，内置目录预计 **900–1200 个 RSS 源**，覆盖国际主流媒体、25+ 国家本地新闻、40+ 主题、50+ 中文平台；外加从 Horizon 借鉴实现的 **8 种非 RSS 源类型**（HN、Reddit、Telegram、GitHub、GDELT、Google News 搜索、OSS Insight、Apify-X），再加 RSSHub 打通的几千种社交内容。出处和许可证全部写进 `catalogs/NOTICE`。

借鉴 Horizon 的适配器时是**重写而不是复制**——它是 Python，我们是 TypeScript，真正值钱的是它趟出来的端点选择、鉴权方式和限流经验，不是代码本身。即便如此 MIT 的归属声明照写。

### Kagi 的源列表：照拿，但过我们自己的流水线

`kagisearch/kite-public` 的 `kite_feeds.json` 代码 MIT、数据标的是 CC BY-NC 4.0。**但你说得对，那就是一堆链接。** URL 本身是事实，事实不受版权保护；一份链接清单能主张的保护极薄。

所以做法不是放弃，是**不原样搬那个文件**：

1. 把里面的 feed URL 全部取出来，**逐个跑我们自己的可达性探测和新鲜度检查**（这一步本来就要做，老项目 `evidence-source.ts` 有现成的）
2. 活的源并进我们自己的目录，用**我们自己的分类、自己的信任权重、自己的元数据**
3. 和 `awesome-rss-feeds`（CC0）去重——重叠大概率不小，很多本来就是公共领域那份里已经有的

出来的是我们自己验证、自己编排的目录，不是他们那份文件的副本。`NOTICE` 里写一句「部分源发现自 kite-public」，够了。

### RSSHub：直接内置，因为我们自己也是 AGPL-3.0

**这是「推特、Telegram 都能看」的唯一现实解法**（截至 2026-09，1987 个 namespace / 3815 条路由，覆盖 Twitter/X、Telegram、微博、B站、知乎、小红书、GitHub）。让用户自己去装 Docker 等于这个功能不存在，不做。

RSSHub 是 AGPL-3.0，**所以本项目也用 AGPL-3.0**（见下面的「许可证决定」）。同许可证之后整个问题消失：可以自由内置、自由分发，不需要任何 arm's-length 论证。

**默认做法 —— 内置，开箱即用**

- 安装完就有，用户不需要点任何按钮、不需要联网下载、不需要 Docker 或终端
- 作为**独立进程**由 app 拉起，通过 `http://127.0.0.1:<port>/...` 调用（这仍然是对的工程做法——隔离崩溃、独立重启、端口管理，只是不再是法律要求）
- 合规动作就三件：保留它的 LICENSE 和版权声明、在「关于」里给出源码获取方式、修改过的部分要公开。都是一次性的
- 界面上保留「连接到已有实例」的输入框，给自己已经跑了一个的人用
- 更新路径：随我们发版更新，外加一个「检查 RSSHub 更新」按钮走 npm 拉新版，不用等我们发版

**兜底 —— 最高价值的十几条路由自己实现**

Telegram（`t.me/s/`）、微博、B站、知乎、GitHub 这些用 TypeScript 自己写一份内置。路由知识（哪个端点、哪些参数）本身不受版权保护。这样即使 RSSHub 进程崩了、或者上游路由失效，产品的核心社交源也不会死。**这是工程冗余，不是法律备胎。**

### 许可证决定：AGPL-3.0

仓库现在的 MIT 改成 **AGPL-3.0**。现在改几乎零成本（一个提交，还没有外部贡献者，全部代码归属清晰），有了贡献者之后再改会很痛。

**为什么合适**

- RSSHub 能直接内置，不用绕
- 和产品理念一致：这是个「你的数据归你」的本地优先软件，AGPL 是对用户自由保护最强的许可证
- 防止别人拿去做一个闭源的云端 SaaS 版本——对这个项目来说这恰恰是最该防的
- **你是唯一版权人，将来想商业化随时可以双许可**：对外 AGPL，谁要闭源用单独谈。AGPL 是做这件事最好的底子

**依赖兼容性**

要移植/借鉴的全部兼容：daily-brief 是自有代码；`awesome-rss-feeds` 是 CC0；`DailyHotApi` / `newsnow` / `Horizon` 是 MIT，MIT 可以并入 AGPL 作品（保留各自声明）；Electron 和 npm 依赖以 MIT/Apache-2.0/BSD 为主，AGPL-3.0 与 Apache-2.0 兼容。

**AGPL 解决不了的**

Kagi 的 `kite_feeds.json` 标的是 CC BY-NC。**NC 限制的是商业使用，而 AGPL 明确允许商业使用，两者仍然冲突。** 所以那份还是走上面「取 URL、独立验证、并进我们自己目录」的路子，不因为换了许可证就能原样搬。

**代价，说清楚**

部分公司禁止员工给 AGPL 项目提交代码，也有用户对 AGPL 软件有顾虑。对一个个人桌面应用来说这个影响远小于对一个库，但不是零。

### 已核实的能力边界，必须写进 README

- **Twitter/X 是唯一需要用户动手的**。RSSHub 我们帮他装好了，但 X 路由**还需要一份登录后的 web cookie**（至少 `auth_token` 和 `ct0`）——这是 X 自己的限制，谁也绕不过。产品里做成一个图文引导页（在浏览器里怎么复制这两个值），而不是让用户去读 RSSHub 文档。另一条路是 Apify 的 X 抓取 actor（Horizon 走的就是这条），付费但稳定，用户本来就要填 key，多填一个不增加心智负担。
  **这一条要在 README 里明说**，别让人以为装上就能看推特
- **Telegram**：公开频道走 `t.me/s/<channel>` 的 web 预览，**不需要登录、不需要 API key、不需要代理**，还支持 `?before=` 翻页读历史。这条我们自己实现，不依赖 RSSHub。部分频道关闭了公开预览，那些退回 RSSHub 路由。**真正做到开箱即用**
- **本地存储 ≠ 完全离线**：用户的 key 发给 Gemini 的内容还是出网了，抓取和检索接口也都要联网。要写明白

### 竞品定位（已核实）

**商业产品**：Particle、Ground News、Feedly、Inoreader、Kagi News、Briefly —— 全部是云端 + 标签/主题订阅。

**开源同类里最接近的是 `Thysrael/Horizon`**（Python，MIT，本地 CLI / Docker，多家 LLM 可选，GitHub Actions 定时）。它已经把「多源聚合 → AI 打分过滤 → 生成中英日报」这条链做通了，值得认真对待。三处关键差异：

| | Horizon | personal-newsroom |
|---|---|---|
| 个性化的单位 | **profile** —— 可复用的「编辑规则集」（`tech-news`、`tech-blog`、`ai-creator`），是跨用户共享的模板，你挑一个或写一个 | **Watch** —— 你自己那句话（「我想知道习近平最近在干什么」）。Horizon 的 profile 大致对应我们的「预置标签」，不是我们的上限 |
| 进展追踪 | 无 | **「相比昨天变了什么」是核心产出之一**。这是我们最强的差异点 |
| 读原文 | 产出 Markdown 日报发到 GitHub Pages／邮件／webhook，读原文还是要点出去 | **一条龙**：推送、原文、溯源、理解在同一个软件里。而且有本地库，日报之后还能回头查 |

有两处 Horizon 的做法我们直接采纳：

- **`profile: "auto"`** —— 不预先把某个源绑定到某个 profile，而是让 AI 拿每一条去和所有 profile 比。这正是「少做有损压缩」，是对我们方向的独立印证
- **配置里的 `${VAR_NAME}` 替换** —— 私有 feed URL、自定义请求头、webhook 地址都用环境变量占位符，密钥不进配置文件。干净，照抄

它明确没做的是成本管理（文档里没有 token 预算或限流），这恰好是我们 §B 三层漏斗要解决的问题。

## 执行顺序

架构在上面已经一次性设计完整，下面只是**落地的先后**，不是「先做个简版以后重构」。

**M-1 技术验证** — 先只做「待验证」那张表里的五件事，不写产品代码：RSSHub 去 Puppeteer 后哪些路由还活着、打包后多大、better-sqlite3 + sqlite-vec 在 Electron 里跑通、Gemini 模型 ID 对一遍、签名公证走一次空壳 app。这几样任何一个爆掉都会改变架构，放在最前面。

**M0 骨架** — Electron 外壳 + 完整 SQLite schema + 移植 feed 层 + 移植 globals.css 设计 token + 合并并验证内置源目录 + 按 Horizon 的经验补 8 种非 RSS 适配器 + 自己实现 Telegram 等高价值路由（全部吐 `DiscoveredItem`）。端到端跑通：抓取 → 入库 → 能看到原文。

**M0.5 RSSHub 内置** — 打包进应用、拉起本地进程、健康检查、端口管理、崩溃重启、检查更新，外加 AGPL 合规动作（LICENSE 随包、「关于」页给源码链接）。做得早是因为它决定了源的天花板，而且是独立模块，不阻塞别的。

**M1 ⭐ 第一个能发布的版本：纯 RSS 阅读器** — 阅读 tab 做完（按源浏览、原文直读、已读收藏）+ 源管理与目录挑选 + i18n 框架（中英两套）+ macOS 打包签名公证全流程走通。

> 这一版**不需要 API key 就能用**，可以真的发出去。好处有三：真实用户的反馈比闭门再做三个月有价值得多；签名公证这种最容易在最后一刻爆炸的事提前趟平；而且它本身就是完整产品的上手坡道，不是丢弃的原型。

**M2 Watch 系统** — 预置标签目录 + 原话直接 embed + `recallAids` 生成与可视编辑 + 输出语言设置（全局 + 按 Watch 覆盖）+ 冷启动（GDELT/Google News 回溯 7 天 + 本地历史）+ 纠偏。

**M3 召回与判定** — R1/R2/R3 三路并集 + 批量判定 + 意图闸门 + **召回体检工具**（同时记录真实 token 用量，用来修正成本模型）。批量打包和跨 Watch 合并从第一版就做对。

**M4 三种产出** — 今日摘要、快讯、**进展**（写进今日摘要 + Watch 页完整时间线，共用 `firstSeenAt` 一份数据）。进展最难，留足时间，先在两三个 Watch 上做对再铺开。

**M5 新闻助手** — App 级右侧分栏（⌘J），不绑定文章：规划检索词 → 本地订阅（关键词 + 向量）→ 联网时 Google News 与厂商网页搜索（网页本地抽正文）→ 流式写作 → 逐条溯源；可追问、取消、查看和删除历史对话。

**M6 后台与供应商** — SMAppService + launchd 调度 + 休眠补跑 + 首运行同意流；Provider 接口接上 Ollama。

**M7 开源打磨** — README（含诚实的能力边界和 X 的 cookie 引导）、NOTICE、自动更新、一键卸载、贡献指南。

## 需要守住的几条

- **少做有损压缩。** 这是第一原则，上面每个模块都是它的推论
- **溯源可点。** 摘要和深度总结里每一句都能点回原文那一段。`sourceRefIds` 绑定机制必须保留
- **grounding 只补细节，不做发现。** 发现走源目录和检索接口（GDELT / Google News），它们吐真实 URL；grounding 只在正文抓不到时补某一条已确定事件的细节，并标 `basis: 'search'`
- **抓不到就说抓不到。** 付费墙和 Cloudflare 挡住时诚实降级
- **冷启动不能等到明天。** 新建 Watch（包括勾标签）立刻出建仓简报；刚填上 key 的用户也要能立刻对已抓到的历史回溯生成，不用等一天
- **不填 key 也能用。** 所有 AI 功能优雅降级，不是报错、不是空白页
- **防信息茧房。** 一个可关掉的小板块「重要但你没关注」

## 已知风险

| 风险 | 说明 | 对策 |
|---|---|---|
| **「进展」是最难的功能** | 判断「相比昨天有什么新变化」比生成摘要难得多——要分清真进展、换个说法的重复、和无关的同主题新闻 | 老项目的快讯 triage 已在做类似三分类（`new / follow_up / already_published`）；关键是 `toldSoFar` 存完整原文而不是 hash，让 AI 看到全貌。M4 先在两三个 Watch 上做对再铺开。**两种展示形态不增加难度**——共用 `firstSeenAt`，判断只做一次 |
| **没有 key 的降级路径散落各处** | 三个 tab、所有生成功能都要有无 key 分支，容易漏 | 在 `packages/ai` 层做一个统一的「AI 是否可用」闸门，上层只问一次；M1 就把无 key 路径当作**默认路径**做，而不是事后补的特例 |
| **向量召回可能漏掉「意图对但用词完全不同」的新闻** | 这是去掉关键词过滤后的主要残余风险 | 三路并集正是为此——R2 别名和 R3 检索接口补 R1 的盲区。另外把 top-N 放宽，让判定层去筛（判定便宜，漏召回贵） |
| **grounding 补出来的内容可信度低于原文** | 模型转述可能失真，而且不可复现 | 照抄 daily-brief 的三道锁（锁定具体事件、锁定 24 小时、确认不了就 `publishable: false`）；`basis: 'search'` 在数据层和 UI 上都标出来；**只在写作侧触发，阅读器一律不用**；能抓到正文时永远优先用正文 |
| **Electron 包体和启动速度** | 150–200MB，冷启动 1–2 秒 | 接受。相比 58000 行重写的代价，这个代价小得多 |
| **源目录合并的质量参差** | 900–1200 个源里必然有死链和低质源 | 移植老项目的可达性探测，在构建期就跑一遍剔死链；首次启动只激活精选子集，其余在「添加源」里按需开启 |
| **托管 RSSHub 进程的运维负担** | 端口冲突、进程崩溃、路由随上游改版失效、安装包变大 | 健康检查 + 自动重启 + 失败时清楚告诉用户哪一步挂了；**最高价值的十几条路由我们自己实现**，不把核心社交源的命门交给一个外部进程 |
| **AGPL 可能劝退部分贡献者和用户** | 有公司禁止员工参与 AGPL 项目 | 对个人桌面应用影响有限，且换来的是「不能被做成闭源 SaaS」这个实实在在的保护。作为唯一版权人，将来有需要可以双许可 |
| **Flash 价格 2027 年翻倍** | 同样负载从 15 分涨到 25–30 分/天 | 批量打包和跨 Watch 合并从一开始就做对 |

## 技术前提：已验证的和待验证的

### 已验证

| 前提 | 结论 |
|---|---|
| **Electron 能不能注册 SMAppService** | **能。** `app.setLoginItemSettings` 的 `type` 支持 `'agentService'`，对应 `Contents/Library/LaunchAgents` 里的 plist。不需要写原生模块 |
| **sqlite-vec 在 Electron 里怎么装** | **比预期简单。** 它是 SQLite **运行时扩展**（`db.loadExtension()`），不是 Node 原生模块，不需要 electron-rebuild。官方有 arm64-darwin 预编译产物，也有单文件 amalgamation 源码可自行编译 |
| **better-sqlite3 在 Electron 里** | 是原生模块，是已知有坑但路径成熟的那类：需要 `asarUnpack`，需要 electron-rebuild，做 universal 包还要给 `@electron/universal` 配 `x64ArchFiles` |
| **GDELT DOC 2.0 API** | **免费、无需 key、无需登录**。返回 title / url / domain / sourceCountry / language / publishedAt / socialImage，正好能喂 `DiscoveredItem`，支持 65 种语言。**但有两个硬限制**：每 IP **每 5 秒 1 次请求**（超了返 429），单次查询**最多 250 条且不能翻页** |
| **Telegram `t.me/s/`** | 无需登录/key/代理，支持 `?before=` 翻页读历史。部分频道关了公开预览 |
| **Twitter/X** | RSSHub 路由必须要用户提供 `auth_token` + `ct0` cookie。或者走 Apify（付费）。没有零配置路径 |

**GDELT 的两个限制直接影响设计**：5 秒一次意味着 N 个 Watch 的查询必须串行错峰（20 个 Watch ≈ 100 秒，后台 worker 里完全可以接受，但不能并发打）；250 条无翻页意味着查询要收窄（锁死时间窗口、拆分查询），不能指望一次捞全。

### 待验证（开工前要做技术验证，不要直接写产品代码）

| 待验证 | 为什么要紧 | 怎么验 |
|---|---|---|
| **RSSHub 能否无 Puppeteer 运行** | Puppeteer 会带约 100MB 的 Chromium，安装包直接爆。RSSHub 在 arm64 上默认就不装 puppeteer 依赖，靠 `CHROMIUM_EXECUTABLE_PATH` 外挂——**但 Electron 自带的 Chromium 不能给 puppeteer 用**，这两个不通用 | 先装一个不带 puppeteer 的 RSSHub，把我们真正要用的路由（Telegram、微博、B站、知乎、小红书、GitHub）挨个跑一遍，**列出哪些必须要 Puppeteer**。那些路由要么放弃、要么自己实现 |
| **RSSHub 打进 Electron 包之后有多大** | 它依赖很多，可能显著拉大安装包 | 实际打一个包量一下。如果过大，退回「首次启动下载」方案——AGPL 下两条路都合法，纯粹是工程取舍 |
| **Gemini 模型 ID 是否仍有效** | 计划里引用的 `gemini-3.7-flash` / `gemini-3.1-flash-lite` / `gemini-embedding-2` 来自 daily-brief 代码。**2.5 Flash-Lite 2026-10-16 退役**，其他也可能变 | 开工时对一遍官方模型列表，把模型 ID 集中到配置里，不要散在代码中 |
| **成本模型的两个假设** | 「2000 条/天」和各层幸存率都是估算，不是实测。整个 15 美分/天的结论建在上面 | M2 做召回体检时**同时记录真实 token 用量**，用真实数字修正。如果偏差大，先调的是 T3 进入量 |
| **macOS 签名与公证** | 带自启动 agent + 拉起子进程的 app，公证要求更严 | 早做一次完整的签名/公证/Gatekeeper 走查，别留到 M6 |

## 验证方式

- `npm run doctor`（`dev/doctor.ts`）：跑管线前校验 key、回显所有开关和 tunable（已实现）
- 开关 `PNR_DISABLE_FETCH/EXTRACT/SEARCH` 和 `PNR_REPLAY=record|replay`（模型回答录成本地快照、离线重放，对应老项目 `NEWS_DISABLE_EVIDENCE` 的语义）（已实现）
- 移植 `dev/reliability/*.test.ts` 的 `node:test` 测试和三个体检工具（聚类 A/B 对比、聚类瓶颈体检、全文预算体检）
- **专门的召回体检**：给定一组人工标注「这条应该被 X 关注命中」的样本，量出 R1/R2/R3 各自的召回率和三路并集的召回率。这是验证「去掉关键词过滤是对的」的唯一硬证据。已实现为 `npm run audit:recall`（`dev/recall-audit.ts`），另外量「仅关键词」的召回率作对照，并按日志汇总各阶段真实 token 和费用
- **无 key 路径单独验收**：全新安装、不填任何 key，能挑源、能抓、能读原文、能收藏。三个 AI tab 给的是清楚的说明而不是空白或报错
- **端到端验收**：勾一个「科技」标签 + 建一个「习近平最近在干什么」的意图 Watch（一个设中文输出、一个设英文）→ 两者都立刻出建仓简报 → 今日 tab 看到围绕新进展写成的摘要 → 点进 Watch 看到完整时间线且今天新增的高亮 → 阅读 tab 能直接读到原文 → 对其中一条点「深入」拿到带时间线的内容总结，每句能点回原文 → 关掉软件、第二天早上打开，后台已经跑过了，能看到新的变化
