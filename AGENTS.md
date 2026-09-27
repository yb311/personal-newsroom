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

**唯一例外：新闻助手（2026-09-22 用户要求）。** 右侧「新闻助手」不绑定任何文章，用户问什么就回答什么，
开着「联网」时允许用厂商原生搜索做发现（`packages/generate/src/assistant.ts`）。但溯源红线不变：
搜到的网页要本地下载、抽正文，抽不到就不算来源；Google News 结果只当标题+摘要（kind `news`）；
模型只能引用本会话登记的 `sN`，引用不存在的编号会被改成「无来源」并在界面上标明。

## 已定决策（不要重新讨论）

| 决策 | 选择 | 关键理由 |
|---|---|---|
| 许可证 | **AGPL-3.0** | 能直接内置 RSSHub（也是 AGPL）；防止被做成闭源 SaaS。用户是唯一版权人，将来可双许可 |
| 桌面外壳 | **Electron** | 老项目 58000 行全是 TS，主进程就是 Node，管线原封不动能跑 |
| 存储 | **SQLite + sqlite-vec** | sqlite-vec 是**运行时扩展**不是原生模块，不用 electron-rebuild。better-sqlite3 是原生模块，需要 asarUnpack |
| AI | Vercel AI SDK 统一层：Gemini 优先 + OpenAI + Claude + OpenAI 兼容接口 + Ollama | 业务层只依赖统一 Provider；用户密钥直连厂商 |
| 输出语言 | **用户自己选**，全局默认 + 按 Watch 覆盖 | 顺带简化：daily-brief 的 `titleZh`/`titleEn` 双份字段合并成 `title` + `lang`，token 减半 |
| 平台 | **只 macOS** | launchd / SMAppService。README 里直说不支持 Win/Linux |
| 无 key | **能当纯 RSS 阅读器用** | 最好的上手坡道。所有 AI 功能**优雅降级，不报错不空白** |
| 后台 | **一个 launch agent**（SMAppService 注册名 `com.yb311.personal-newsroom.background`，手写 plist 名 `com.yb311.personal-newsroom.update`，每小时第 16 分钟），worker 的 `auto` 模式自己判断该写每日摘要、查快讯（每 3 小时）还是什么都不做。签名包走 **SMAppService**（`type: 'agentService'`），未签名构建退回 `~/Library/LaunchAgents` 手写 plist。任务跑 bundle 内的「所闻 后台更新.app」（`packaging/worker-helper.mjs`）。**休眠时也要更新**：唤醒组件（`apps/desktop/src/wake.ts`）装一次、输一次管理员密码，root 脚本用 `pmset schedule wake` 约好每日时间和之后每 3 小时的 xx:15:50 唤醒；worker 运行时用 `caffeinate` 不让 Mac 睡回去 | plist 在 bundle 内，卸载即消失；2026-09-24 用户要求后台进程在系统各处显示指向本 app 的名字，并且**必须在休眠时更新、别人安装后也要能用** |
| 单实例锁 | **SQLite `locks` 表** + `BEGIN IMMEDIATE` + 15 秒心跳；App 另有 `requestSingleInstanceLock` | 不用文件锁，`kill -9` 后 flock 清理语义不可靠 |
| 阅读核心 | **Go 程序 `native/reader`（`pnr-reader`）**：Miniflux 的解析/编码/清洗/站点规则 + go-trafilatura 抽正文。**全 TS 决策的唯一例外** | Trafilatura 没有 JS 版；新闻文章 F1：Trafilatura 0.926 vs Readability 0.825（WCXB）。Miniflux 的 reader 包带大量测试。见下文「阅读核心」 |
| 下载在哪 | **一律在 Node（`@pnr/core` 的 `download`）**，Go 只处理字节，不联网 | France 24 等按 TLS 指纹拦截：Go 客户端和 curl 403，Node fetch 200 |
| 各板块分工 | **今日** = 每天一份的日报（今日摘要 + 关注之外 + 往期）；**快讯** = 随时的电讯，一条一件事，几小时查一次；**关注** = 每件事的档案（进展时间线为默认页 → 相关报道 → 设置）；**阅读** = RSS 阅读器；**新闻助手** = 问答；**深度报道** = 把一件事讲透。**同一条新闻只有一个家，别处只放链接** | 2026-09-22 用户指出「昨天到今天」与摘要、快讯重复，分工不清 |
| 进展形态 | 进展判断出的新里程碑 **写进今日摘要**（`generateDigest` 的 `NEW`，「新」= 自上一期摘要生成以来）**+** Watch 页完整时间线（最新在上，新增标「新」）。**时间线上的「新」像未读邮件**：时间线真正出现在屏幕上后记 `watches.seen_at`，下次打开就不再标新（当次仍保留标记），侧栏和列表计数随即归零；一直没看的 7 天后也不算（`NEW_DAYS`）。这和摘要里的「新」（自上一期摘要以来）是两回事，互不影响。摘要每节小标题上方标所属关注，点击进该关注的时间线；侧栏「关注」计数 = 新进展数。**今日不再单列「昨天到今天」** | 共用 `firstSeenAt`，一份数据两种渲染，判断只做一次 |
| 更新按钮 | 工具栏分两半，**左半在列表正上方，放作用于列表的操作**，右半放作用于选中项的操作（同 Mail）。**↻ 只表示「取新内容」**，只在阅读（更新订阅）和快讯（检查新快讯）出现，紧挨列表标题。**「全部更新」是唯一的全局按钮**：只在侧栏标题栏，**侧栏收起时随侧栏一起隐藏**（不在工具栏放只有图标的副本，它会和列表的 ↻ 挨在一起分不清），菜单 ⇧⌘R 始终可用；按住 ⌥ 变成「全部重新生成」（⌥⇧⌘R）。**AI 重写用带文字的按钮，放在被重写的东西上**：今日摘要文首「重新生成」**只重写摘要这一份**（一次调用，不抓取不判定）；单个关注的「立即更新」（先抓取再筛选，有新报道才重读进展）。**所有写作一律增量**（`pipeline.ts`）：进展只在有新过闸报道时重读（`watches.progress_at`）、快讯只看模型没见过的候选（`flash_considered`）、摘要只在有新进展或新关注有材料时重写（`digestDue`）、关注之外一天一次、AI 初筛按关注原话缓存（`prescreen_results`）；`force` 才全部重写 | 2026-09-22 用户反馈四个一样的 ↻ 分不清；2026-09-24 用户要求以省 token 为目标设计按钮，并要一个全部更新的按钮；2026-09-25 用户反馈侧栏收起时阅读页出现两个 ↻ 很奇怪 |
| 右侧分栏 | **新闻助手**：通用问答，不绑定文章，可联网（本地订阅 + Google News + 厂商网页搜索）。**它知道左边打开的是什么**（文章、文章列表、今日摘要/往期、关注之外、快讯、关注、深度报道）：界面只传「是哪一个」（`ScreenFocus`），正文由主进程从数据库完整读取（`packages/generate/src/screen.ts`），打开的文章整篇作为 s1；App 自己写的摘要/时间线/快讯原样给模型，背后的文章登记成 `sN` 供引用。输入框上的眼睛胶囊显示附带了什么，点一下下个问题不带；问题下方记「看着：…」 | 侧栏只放助手；2026-09-25 用户要求助手知道左边在看什么 |
| 助手即 agent | 助手能做按钮能做的事：**工具就是按钮背后的同一个函数**（`apps/desktop/src/agent-tools.ts` 包 `createApi` 和 main.ts 的 `runs.*`），循环在 `packages/generate/src/agent.ts`，每步走 `provider.generate`（replay/成本体检/假模型照常可用），不用厂商原生 tool calling。**风险等级写在工具上、放行由主进程 `gate()` 按权限模式判定**（只看不改 / 每次确认（默认）/ 自动改危险的问我 / 全部自动，胶囊 + ⇧Tab 切换），模型说什么都不算确认。卡片文字由代码从数据库算出，可撤销的给撤销。关注 intent、纠偏 note 必须是用户原话，否则标黄并强制确认。**API key/token 永不做成工具**，像密钥的输入本地拦截；文章正文永不进 agent 步骤 | 2026-09-25 用户要求「所有操作都能让助手完成」，权限「跟 Codex、Claude Code 一样的模式控制，用户可以调整」 |
| 深度报道 | 保留，但**不在侧栏**：从文章/快讯/进展进入，在主区域以文档视图打开，工具栏返回 | 绑定一条新闻，材料快照存 `conversations` 表；失败的首稿不会被当成已存报道恢复 |
| 界面形态 | **按 macOS 应用做布局**：设置是独立窗口（⌘,，System Settings 式分组）、原生右键菜单、状态写在工具栏副标题 | 不要加网页式状态栏、卡片、悬停高亮 |
| 主区域布局 | **今日 / 快讯 / 阅读 / 关注一律「左列表 + 右详情」分栏**（`ListPane.tsx`，方向键切换，列宽共用）。今日列表：今日摘要 → 关注之外 → 往期；**有摘要时不显示要闻**，没摘要时要闻代替。AI 写的文档用编号角标 + 文末来源列表，不用来源名胶囊 | 2026-09-22 用户反馈「太像网页、今日太杂」：长滚动页 + 卡片 + 网格就是网页感的来源 |
| 配色 | **全应用只用 daily-brief 调色板**（`tokens.css`：米白纸色、墨色、砖红、暖灰边框），侧栏、工具栏、控件也一样 | 不用系统灰、系统强调色或窗口 vibrancy——那会和纸色冲突（2026-09-22 用户明确要求） |

## 从 daily-brief 移植什么

源仓库在 `../daily-brief`。**移植，不 fork**，已经移植完的对应关系见 `docs/ARCHITECTURE.zh-CN.md`。
不要碰 `lib/narration/*`（播客 TTS）、`lib/user/newsletter.ts`、`app/api/share/*`、`app/[lang]/*`、
`lib/storage/kv-cache.ts`、`lib/storage/r2-store.ts`。再从那边搬东西时，`lib/feed/rss-catalog.ts`
的注释要原样保留——那些是血汗经验，说明每个入口为什么这么选。

移植时改过的两处，别改回去：
- **交叉验证闸门换成意图闸门**（`packages/recall/src/gate.ts`）。老闸门是 `evidence-cluster.ts:1553`
  的单点 `cluster.independentOrgCount >= 2`
- **双语字段合并**成单语言 + `lang`

## 视觉

**先把它当作 macOS 软件设计，不是套壳网页。** 窗口工具栏、系统侧栏、可调整分栏、固定的上下文操作和键盘导航是基础；不要用网页页头、营销卡片或手机网页式跳转替代桌面交互。软件控件使用系统字体和中性色，下面的报纸色彩与衬线字体主要用于正文阅读区域。

正文阅读区域沿用 daily-brief 的 `app/globals.css` 设计 token，报纸美学，深浅两套都现成：
`--bg: #f5f2eb`（米白）· `--fg: #1a1a1a` · `--accent: #c0392b`（砖红）·
`--card-radius: 2px` · `--serif: 'Noto Serif SC', 'Playfair Display'` · `--mono: 'JetBrains Mono'`

界面细节约定（2026-09-22 打磨时定下，改之前先看）：

- **正文一律衬线**（`app.css` 的 `--reading-serif`：没装 Noto/Playfair 时西文用 Charter、中文用宋体）。
  **中日文两端对齐，西文不对齐**，靠 `lang` 判断：阅读器给文章标 `lang={item.lang}`，
  没记语言的 AI 文档用 `i18n.ts` 的 `scriptLang()` 推断。标题用 `text-wrap: pretty`（中文 balance 会把词拆开），西文标题才 balance
- 引用角标用 `Cites.tsx` 的 `Cited` 包住句子最后一个词，**角标永远不单独起一行**
- **字号和圆角只用 `app.css` 顶部的 token**（文件头注释写了规则）：界面文字用系统字体 `--text-xs/sm/md/lg/xl`（11/12/13/15/20），阅读文字用衬线 `--read-*`；meta 行（来源 · 时间）一律 `--text-sm`，标签/计数/分区标题/控件下的说明一律 `--text-xs`；700 只给窗格标题。
  圆角四档：`--radius-sm` 行内标记 · `--radius-md` 控件与选中态 · `--radius-lg` 容器 · `--radius-xl` sheet 和气泡，药丸用 `--radius-full`。**不要再写裸数字**
- **列表行统一三层**：meta 行（小、灰）→ 标题（粗，永远是主角）→ 两行摘录。关注名、来源名只能出现在 meta 行，不能当标题（2026-09-22 用户反馈快讯把「国际时政」当主标题）
- **AI 写作风格集中在 `packages/generate/src/style.ts` 的 `writingRules()`**，快讯、摘要、进展共用：短句、不堆定语、不写「周一」这类相对时间、不用套话、不下评级式结论。改写作风格改这里，别在各 prompt 里各写一份
- **窗口布局由 `App.tsx` 按宽度算**：助手能停靠就停靠；停靠后工作区不够分栏时**侧栏自动收起**（macOS split view 的做法），
  窗口宽了自动回来；再窄助手才浮在上面。侧栏和助手一样可拖动调宽（记在 localStorage），空间不够时先缩到最小宽度再收起。`SPLIT_MIN` 要和 `@container workspace` 断点保持一致
- 阅读区的边距用容器单位（`cqi`），跟着窗格宽度走，不跟窗口宽度走
- 对话框按 macOS sheet 贴在工具栏下方，切换内容时顶边不动；Esc 在 `Dialog` 里自己处理（Chromium 有时不发 `cancel`）
- `main.tsx` 会给设置窗口的 `<html>` 加 `settings-window` 类，CSS 只能写 `div.settings-window`，否则整个窗口缩成内容宽度

## 红线

- **溯源可点**：`sourceRefIds` 绑定机制必须保留——模型不许自己写 URL，只能引用已绑定的来源 id
- **抓不到就说抓不到**：付费墙挡住时诚实降级，不拿摘要冒充正文。**阅读器一律不做 grounding 补全**
- **不填 key 也能用**：AI 不可用的判断集中在 `packages/ai` 一层，上层只问一次
- **成本**：目标 15 美分/天。判定要**批量打包**（20 条一次调用），写作要**跨 Watch 合并**。
  Flash 档 2027-01-01 价格翻倍，这两件事从第一版就要做对，不是以后优化
- **GDELT 限流**：每 IP **5 秒 1 次**，单查**最多 250 条不能翻页**。各 Watch 串行错峰，查询收窄时间窗

## 进度（截至 2026-09-25）

M-1 技术验证到 M6 全部完成（验证结论并进了 `docs/ARCHITECTURE.zh-CN.md` §12）。剩下 M7 开源打磨，见下面「剩余工作」。
**还没发布过任何版本**，所以不需要兼容任何旧数据、旧设置或旧的后台任务——见「踩过的坑」里关于 schema 的一条。

| 包 | 内容 | 验证 |
|---|---|---|
| `@pnr/core` | `DiscoveredItem` 统一契约、`canonicalDedupKey`、`RichBlock`、结构化日志、下载、开关 | — |
| `@pnr/store` | 一个 schema（`001_schema`，**SQL 嵌在 TS 里**）：32 张表 + 2 个 vec0 虚拟表；SQLite 锁；正文文件 | `test:schema` |
| `@pnr/feed` | **12 种源适配器** + 注册表分发 + 粘贴内容自动识别 + 并发入库去重 + RSSHub 资源包 | `test:adapters` · `test:resolve` · `test:ingest` · `test:catalogue` |
| `native/reader` | Go 阅读核心：feed/sitemap 解析、编码识别、正文抽取、HTML 清洗、语言识别 | `reader:test`（含 Miniflux 原有测试 + 34 页抽取基准） |
| `@pnr/reader-core` | 常驻子进程客户端（按需启动、崩溃重启、空闲 unref） | — |
| `@pnr/reader` | 下载页面 → 阅读核心抽取 → 落盘 `{html,text,words}`；付费墙名单 | `test:reader` |
| `@pnr/ai` | Vercel AI SDK Provider（Gemini / OpenAI / Claude / 兼容接口 / Ollama）、无 key 闸门、流式/搜索、向量代次、按请求计价、录放 | `test:ai`（真实 SDK + 模拟 HTTP）· `test:ai-live`（付费实测） |
| `@pnr/watch` | Watch 模型、37 个预置主题（5 组，中英两套）、意图向量、召回辅助、纠偏 | `test:watch` · `test:watches` |
| `@pnr/recall` | R1/R2/R3 三路并集、判定前免费排序截断、批量判定、意图闸门、无 AI 时的关键词匹配 | `test:pipeline` |
| `@pnr/generate` | 流程编排、今日摘要、进展、快讯、关注之外、搜索补全、深度报道、新闻助手 | `test:today` · `test:generate` · `test:flash-cap` · `test:search-fill` · `test:outside` · `test:report` · `test:assistant` |
| `apps/desktop` | Electron 主进程、IPC、菜单、设置窗口、源目录与自定义源、后台调度、唤醒组件 | `test:wake` · 界面逐屏截图验证 |
| `apps/renderer` | 今日 / 快讯 / 阅读 / 关注 + 新闻助手分栏 + 深度报道 + 设置 | `test:i18n` |
| `apps/worker` | 无界面 worker，`auto` / `daily` / `flashes` / `fetch` 四种模式，日志写库 | 实跑 59s 全绿 |
| `assets` | 应用图标：`AppIcon.icon` 是唯一源，`Assets.car`（26+）/ `icon.icns`（26 以前）由 `npm run icon:build` 生成 | 六种外观 + 16/32/64/128 各尺寸目视检查 |

`npm run test:ci` 是 CI 跑的离线全集（不联网、不花钱），改完代码至少跑它和 `npm run typecheck`。

**源**：内置目录约 550 个（42 分类 24 国家，12 个默认启用）+ 12 种适配器 + RSSHub 打通的几千种。

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
去重由模型对照已有节点的完整叙述，返回 `existingMilestoneId`；代码校验该 id 属于本次提供的节点，另对同日完全相同的叙述兜底去重。不能仅因引用来源重叠就合并事件，一篇报道可能包含多个进展。
快讯用同样的机制，第二次跑也是 0 条。

### RSSHub 分发：已定为按需下载（不随包发）

完整说明见 `docs/ARCHITECTURE.zh-CN.md` §4。要点：

- **不随应用分发**（依赖树 415MB，路由常随网站改版失效，捆进应用就得等我们发版才能修）
- **也不用 npm 运行时安装**（应用不带 npm，解 629 个包失败面太大）。用自己打的版本化资源包
  （`scripts/build-rsshub-pack.sh`，压缩 63MB / 解压 370MB）：下载 + 校验 sha256 + 解压到用户数据目录
- 适配器三种模式：`http`（用户自己的实例，优先）/ `library`（资源包）/ `off`（优雅降级不报错）
- **绝不内置任何公共实例作为默认**，那等于把用户的阅读兴趣发给陌生服务器
- 剔依赖是实测的：只剔 `@sentry`；`@opentelemetry`、`youtubei.js`、`patchright` 剔了会在调用时才以
  「模块找不到」失败，比多 40MB 糟糕

### 剩余工作

- **发布第一个签名公证版本**：流程已接好（`docs/RELEASING.zh-CN.md`，打 `vX.Y.Z` 标签触发），还没正式发过
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

- **发布前 schema 只有一个 `001_schema`**（`packages/store/src/migrations.ts`）：要改表结构就直接改它，
  不写 ALTER、不写兼容旧数据的读取分支；自己的开发库打开时会报「未发布的开发版」，挪开重建即可。
  **发布第一个版本之后**才改成只追加新迁移、永不修改已发布的

- **界面文字只放在词典里**：`apps/renderer/src/locales/zh-CN.json`、`en.json`（i18next + react-i18next），
  组件里不写中文句子；菜单由主进程读同一份词典。主进程和各包返回**原因码**（`duplicate`、
  `route_not_found`、`no_key`…），界面翻译。`npm run test:i18n` 检查两套词典键一致、用到的键都存在、
  组件里没有写死的中文。英文复数用 `_one`/`_other`，中文只写不带后缀的键。
  日期、相对时间、语言名一律用 `src/i18n.ts` 里基于 `Intl` 的函数，不要写死 `'zh-CN'`。
  界面语言（设置 → 通用）和 AI 输出语言（设置 → AI 与语言）是两件事，互不影响；
  主题库在英文界面下给英文名称和原话（`packages/watch/src/presets.ts` 的 `EN`）
- **加载数据的 effect 不要依赖 `t`**：切界面语言会让 `t` 变，依赖它的 effect 会重跑、把表单重置
- **列表行必须带 `role="option"`（列表 `role="listbox"`）**：没有角色的 `<article>` 在辅助功能树里没有可按的动作，VoiceOver 和自动化测试都点不到
- **设置行里的控件不能用 `justify-content: flex-end` 硬撑**：内容超宽时会向左溢出、盖住左边的说明文字（「自建 RSSHub 地址」那一行）。控件要能收缩，长说明的行用 `Row wide`
- **搜索发现的文章挂在占位源下**（id 以 `search:` 开头，名字是「搜索发现」「Report discovery」），这个名字说的是怎么找到的，不是谁发的。
  界面上的来源名一律走 `ipc.ts` 的 `SOURCE_NAME`（占位源返回 null，界面显示「新闻搜索」），不要直接 `s.name AS sourceName`
- **深度报道盖在当前板块上面，不替换它**（`App.tsx` 的 `workspace-tab` 用 `hidden`）：今日/快讯/关注的选中项是组件内部状态，卸载就丢，返回时会回到默认项
- **启动时的异步检查不能覆盖用户的操作**：App 启动后若有摘要会切到今日，必须先看用户是否已经点过别处（`navigated`）

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
- **RSSHub 出错不抛异常，而是返回 `{ error: { message } }`**：消息为空=路由不存在；
  含 `browserType.launch`=路由偷偷需要浏览器（资源包不带）；含 `: 403` 之类=对方网站拒绝。
  适配器按这三种分别报告（`classify`），别再统称「路由不存在」
- **B 站大部分路由现在会退回浏览器模式**（B 站接口对未登录请求风控），所以精选清单里只剩
  热门/每周必看/入站必刷。精选清单由 `npm run catalog:rsshub -- <资源包目录>` 实测生成，
  结果随对方网站风控变化，隔一段时间要重跑
- **静音 RSSHub 输出的 `quietly` 必须计数**：并发请求时第二个调用会把第一个调用换上的空函数
  当成「原函数」存下，导致整个进程的日志永久静音
- **OSS Insight 的趋势排行 2026-03-01 起官方停用**（返回空结果并说明原因），「GitHub 新星仓库」
  改用 GitHub 搜索接口（近 7 天创建、按星标排序），源地址写 `trending` 或 `trending:<语言>`
- **每日流程必须先进展、后摘要**。摘要会把内容记进 `told_records`；先写摘要，
  进展判断就会把今天的新事全当成「已告诉」。进展另外只读本次运行开始之前的记录
  （`generateProgress` 的 `toldBefore`）。流程在 `packages/generate/src/pipeline.ts`，
  app 和 worker 共用，别再各写一份
- **「今天」一律用 `localDateKey()`（本地日期）**，不要 `toISOString().slice(0,10)`：
  北京时间 7:15 的每日任务是 UTC 前一天 23:15
- **milestone 的 id 要带运行时间**。只用「关注+日期+序号」时，同一天第二次运行的新节点
  会和早上的撞 id，被 `ON CONFLICT DO NOTHING` 静默丢掉
- **离线跑流程**：`PNR_DISABLE_FETCH/EXTRACT/SEARCH=1`（`@pnr/core` 的 `flags`），
  `dev/today.test.ts` 用脚本化的假模型验证今日/快讯的全部逻辑，不联网、不花钱。
  `PNR_REPLAY=record` 把真实模型的回答按 prompt 录到 `dev/snapshots/`（不入库），
  之后 `PNR_REPLAY=replay` 离线重放、零成本；改了 prompt 就是新的键，会报缺快照
- **开发体检**：`npm run doctor` 只读地查环境、数据库、密钥、RSSHub，回显开关和阈值；
  `npm run audit:recall`（`PNR_DATA_DIR=<数据目录的拷贝>`）用 👍/👎 和可选标注文件
  量 R1/R2/R3、并集和「仅关键词」的召回率、判定准确度和各阶段花费。
  新加的模型调用要在日志 attrs 里带 `model`、`tokensIn`、`tokensOut`，体检才算得到
- **Miniflux 的 reader 包在 `internal/` 下，Go 不许跨模块 import**，所以是拷进
  `native/reader/third_party/miniflux` 的（`scripts/sync-miniflux.sh`，只改 import 路径）。
  `config`/`locale`/`mediaproxy` 是手写替身，给它加导出用 `native/reader/_overlay`，
  **不要直接改拷进来的文件**，下次同步会被覆盖
- **Miniflux 对没有日期的条目会填「现在」**。阅读核心据此判断（日期 ≥ 解析开始时刻）
  并标 `dateEstimated`，不能把它当真实发布时间
- **发布方声明的语言不可信**：路透社 sitemap 把西语、法语文章都标成 `en`。
  语言以正文识别（py3langid，限定新闻常见语种）为准，声明只作兜底
- **抽取基准的参考正文是人工标注的**（`core/testdata/articles/*.json` 的 `body` 选择器）。
  标注时只按页面本身判断，别为了分数去贴合抽取器的输出
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
- **后台 helper 的可执行文件名必须以 " Helper" 结尾**（「所闻 后台更新 Helper」）。Electron 靠这个后缀判断自己是 helper、去上三级找 Electron Framework；
  叫「所闻 后台更新」会在启动 Node 时直接 SIGTRAP。bundle 的显示名可以随便取
- **SMAppService 拒绝没有开发者签名的 app**，Electron 只在 stderr 打一行 `Unable to set login item`，不抛异常。
  以前开关因此「点了又弹回去」；现在读回状态，失败就改用手写 plist（`schedule.ts`）
- **唤醒组件以 root 运行，只许执行它自己那个 root 所有的脚本**（只调 pmset 和 date）。它读的 `wake.conf` 归用户所有，
  只取数字和一个只做存在性检查的 app 路径——**绝不能让 root 执行 app bundle 里的任何东西**（bundle 用户可写，等于提权）。
  app 被拖进废纸篓后脚本发现路径不在了就不再约唤醒，别人卸载后 Mac 不会继续被叫醒。离线测试 `npm run test:wake`
- **SMAppService 的任务名不能和手写 plist 的任务名相同**：`~/Library/LaunchAgents` 里的 plist 一旦用过某个 Label，
  后台任务管理（BTM）就给它留一条停用的「老式 agent」记录，之后 SMAppService 注册同名任务永远报 `Operation not permitted`
  （smd 日志：`disposition=[disabled…]`、`Job is not allowed to bootstrap`）。所以两边名字分开（`.background` / `.update`）。
  两个 plist 和唤醒组件的 plist 都要写 `AssociatedBundleIdentifiers`（数组），否则「登录项与扩展」里显示证书主人名或「sh」、空白图标。
  排查时看 `sfltool dumpbtm` 和 `/usr/bin/log show --predicate 'process == "smd"'`（zsh 自带一个 `log`，必须写全路径）
- **后台任务被锁跳过时 outcome 记 `skipped`，不能记 `ok`**：worker 靠「今天目标时间之后有没有成功的 daily run」判断是否还要跑
- **任何 run 的 kind 不要随便写 'daily'**：worker 靠「今天之后有没有成功的 daily run」决定要不要跑每日任务。
  单个关注的更新记为 `watch`，重写摘要记为 `digest`
- **不是所有源都有发布时间**（知乎日报等）。契约不许编造日期，但整源丢弃更糟：
  用首次发现时间并置 `publishedAtEstimated`，界面显示「发现于」而不是「发布于」
- **「关注之外」读取时不能按配置指纹过滤**：指纹包含关注列表，关注其中一条就会让当天其余推荐全部消失。
  `readOutsidePicks` 只隐藏已被关注覆盖的那条（措辞与建议相同，或报道已过某个关注的闸门），指纹只用于判断要不要重新生成
- **正文里的订阅推销段落（「Sign up here.」等）在 `readBody` 读取时去掉**（`packages/store/src/bodies.ts` 的 `isPromo`），
  只删整段都是推销的短段落，所以已下载的旧正文也会干净。路透社图集留下的「Purchase Licensing Rights」链接和「[1/49]」图片计数也在这里去掉
