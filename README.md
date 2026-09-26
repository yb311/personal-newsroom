# personal-newsroom

**A newsroom that works for one person, and runs on their own computer.**

Local-first, intent-driven personal news intelligence for macOS.

> 🚧 **Status: feature-complete, first release not out yet.** Everything in the
> roadmap below works and is covered by tests, and the signed, notarised release
> pipeline is in place. Until the first `.dmg` ships you have to
> [build it yourself](#building-it-yourself). Star the repo to hear when it does.

[中文说明](README.zh-CN.md)

---

## Why

Every news app personalizes by **tag**: you tick "Technology", "Politics",
"Sports", and everyone who ticks the same boxes sees the same thing.

But that is not how people actually follow the news. You don't want "politics" —
you want to know *what a specific person has been doing this week*, or *whether
that negotiation moved*, or *what changed since yesterday on the one story you
actually care about*.

personal-newsroom takes the sentence you'd say out loud and makes it the unit of
personalization.

## What it does

| | |
|---|---|
| **Today** | Your own daily brief, each section written around **what changed since the last edition**, a few important stories several outlets are covering that none of your watches follow, and earlier editions |
| **Flashes** | Short, fast updates — only the ones that pass your intent filter |
| **Read** | A real reader. Article text extracted and shown in-app, so you don't bounce out to a browser |
| **Watches** | Tick a preset topic, or write a sentence. Either way you can see and edit exactly how it's searching |
| *Any time* | The **News Assistant** side panel: ask about any story or anything in your subscriptions, optionally searching online; every answer line carries a numbered source you can open |
| *On demand* | Open a **deep report** from any story: related coverage read in full, written up with follow-ups, every fact traceable to its source |

**Three things that make it different:**

1. **Intent, not just tags.** Presets exist and are one click. But the ceiling is
   a sentence you write yourself, and the system shows you its reasoning rather
   than hiding it behind a black box.
2. **Everything stays on your machine.** SQLite on your disk, your own API key,
   no account, no server we run. Backup is copying a folder.
3. **It tells you what's *new*.** Not the same story re-summarized every morning —
   what moved since the last time it told you something.

## Honest limitations

We'd rather you know before you install.

- **macOS only (Apple silicon).** Background scheduling, notifications and packaging
  are built on launchd / `SMAppService`. Windows and Linux are not supported and not promised.
- **Updating while the Mac sleeps needs your administrator password once.** Waking the
  Mac on schedule takes a small system component (it only books wakes with `pmset`).
  Without it, updates run only while the Mac is awake. With the lid closed on battery,
  macOS may refuse to wake.
- **Social sources are a separate 63 MB download.** Weibo, Bilibili, Zhihu,
  Xiaohongshu and X have no RSS, so they go through RSSHub — which is 370 MB
  installed and therefore not in the app. Enable it in settings, or point the
  app at an instance you already run. Telegram is implemented natively and
  works out of the box.
- **Twitter/X needs a cookie from you.** There is no free zero-config way to
  read X any more. You supply a logged-in web cookie, or pay for a scraper.
- **Local storage ≠ fully offline.** Your data lives on your disk, but whatever
  gets sent to a cloud AI provider leaves your machine. You can instead use a
  local Ollama model; its available context and quality depend on your local setup.
- **Paywalls are paywalls.** When article text can't be fetched, the reader says
  so and offers to open the page. It does not dress up a summary as the article.
- **The interface comes in Chinese and English** (Settings → General; it follows
  the system by default). That is separate from the language AI writes your
  briefs and flashes in, which is set globally and per Watch.

## Roadmap

| | |
|---|---|
| **M-1** | ✅ Technical de-risking |
| **M0** | ✅ Skeleton: fetch → store → display |
| **M0.5** | ✅ RSSHub integration |
| **M1** ⭐ | ✅ **Reader, usable with no API key** |
| **M2** | ✅ Watches: presets, written intent, visible search plan |
| **M3** | ✅ Recall and relevance judging |
| **M4** | ✅ Brief, flashes, **progress** |
| **M5** | ✅ News assistant: online search, follow-ups, saved source snapshots |
| **M6** | ✅ Background worker; Gemini, OpenAI, Claude, compatible APIs and Ollama |
| **M7** | ⏳ Signed release, auto-update, one-click uninstall, contributing guide |

M1 is deliberately shippable on its own: install it, pick from a catalogue of
~550 curated feeds, read. The AI features layer on top when you add a key.

## Building it yourself

You need an Apple silicon Mac, Node.js 24.15 or later, and Go 1.26 or later (for
the reading core). Xcode is not needed.

```bash
npm ci
```

```bash
npm run package:dir
```

The app lands in `release/mac-arm64/所闻.app`. Without a Developer ID signature
background updates register as a plain `~/Library/LaunchAgents` job instead of a
login item; everything else is the same. For development: `npm run reader:build`
compiles the reading core, `npm run build --workspace=@pnr/desktop` builds the
interface, and `npm run start --workspace=@pnr/desktop` launches it.

## Documentation

The design documents are in Chinese:

- [`docs/ARCHITECTURE.zh-CN.md`](docs/ARCHITECTURE.zh-CN.md) — architecture, data flow, how each part works, field measurements
- [`docs/RELEASING.zh-CN.md`](docs/RELEASING.zh-CN.md) — signing, notarisation and releases
- [`AGENTS.md`](AGENTS.md) — settled decisions, interface conventions, known pitfalls (for contributors and AI agents)

## License

**AGPL-3.0.** This is a tool for people who want to own their own data, so the
license is the one that keeps it that way — nobody can take this and ship it back
to you as a closed cloud service.

It also lets us use [RSSHub](https://github.com/DIYgod/RSSHub) (AGPL-3.0)
directly, which is why Weibo, Bilibili and friends are one click in settings
rather than a Docker install.

## Origin

This project is extracted from `daily-brief`, a bilingual AI news portal that
generates a single edition for all readers. The pipeline there is good — evidence
collection, event clustering with cross-source corroboration, two-stage writing
with citations bound to real sources — but it serves an audience, not a person.
personal-newsroom keeps the pipeline and rebuilds everything above it around one
reader.
