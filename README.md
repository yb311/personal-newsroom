# personal-newsroom

**A newsroom that works for one person, and runs on their own computer.**

Local-first, intent-driven personal news intelligence for macOS.

> 🚧 **Status: feature-complete with an unsigned directory build verified, but not yet distributed.** Everything in the roadmap
> below works and is covered by tests. What is
> missing is the signed, notarised `.dmg` — until then you have to build it
> yourself. Star the repo to hear when that ships.

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
| **Today** | Your own daily brief, a **"since yesterday"** panel, and a small evidence-backed section for important events outside your watches |
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

- **macOS only.** Background scheduling, notifications and packaging are built on
  launchd / `SMAppService`. Windows and Linux are not supported and not promised.
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
| **M7** | ⏳ Packaging, signing, notarisation |

M1 is deliberately shippable on its own: install it, pick from a catalogue of
~1000 curated feeds, read. The AI features layer on top when you add a key.

Remaining work (signing and notarisation, auto-update) is tracked in `AGENTS.md`.

## License

**AGPL-3.0.** This is a tool for people who want to own their own data, so the
license is the one that keeps it that way — nobody can take this and ship it back
to you as a closed cloud service.

It also lets us bundle [RSSHub](https://github.com/DIYgod/RSSHub) (AGPL-3.0)
directly, which is what makes Telegram, Weibo, Bilibili and friends work without
asking you to install Docker.

## Origin

This project is extracted from `daily-brief`, a bilingual AI news portal that
generates a single edition for all readers. The pipeline there is good — evidence
collection, event clustering with cross-source corroboration, two-stage writing
with citations bound to real sources — but it serves an audience, not a person.
personal-newsroom keeps the pipeline and rebuilds everything above it around one
reader.
