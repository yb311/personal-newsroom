import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import type { Watch } from '@pnr/watch';
import { log, localDateKey } from '@pnr/core';
import { MATERIAL_COLS, materialBlock, type Material } from './material.ts';

export interface Milestone {
  id: string;
  watchId: string;
  occurredOn: string;
  summary: string;
  itemIds: string[];
  firstSeenAt: number;
  isNew: boolean;
}

const SCHEMA = {
  type: 'object',
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          occurredOn: { type: 'string' },
          summary: { type: 'string' },
          itemIds: { type: 'array', items: { type: 'string' } },
          isNew: { type: 'boolean' },
          answersQuestionIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['occurredOn', 'summary', 'itemIds', 'isNew']
      }
    },
    openQuestions: { type: 'array', items: { type: 'string' } }
  },
  required: ['milestones']
} as const;

/** Progress looks back a week: long enough to tell a story, short enough that
 *  last month's high scorers do not keep coming back. */
const PROGRESS_WINDOW_DAYS = 7;
/** An open question nobody answered in two weeks is dropped. */
const QUESTION_TTL_DAYS = 14;
const MAX_OPEN_QUESTIONS = 5;

export interface ProgressOptions {
  /**
   * Start of the run this pass belongs to. Records told after it came from the
   * same run — today's digest or flashes about the very items being judged —
   * and would make every new development look already told.
   */
  toldBefore?: number;
}

/**
 * "What changed since yesterday" — the hardest and most valuable output.
 *
 * The difficulty is not summarising; it is telling apart a genuine development,
 * the same development reported again in different words, and an unrelated story
 * on the same topic. daily-brief's flash triage solves a similar problem, but it
 * compares against flashes IT published. Here the comparison is against a
 * per-user record of what this person was told, kept as FULL NARRATIVE TEXT
 * rather than a hash, so the model can see the whole picture.
 */
export async function generateProgress(
  db: Db, provider: Provider, watch: Watch, lang: string, opts: ProgressOptions = {}
): Promise<Milestone[]> {
  const now = Date.now();
  const items = db.prepare(
    `SELECT ${MATERIAL_COLS}, m.intent_score AS score
     FROM matches m JOIN items i ON i.id = m.item_id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE m.watch_id = ? AND m.passed_gate = 1 AND i.published_at >= ?
     ORDER BY m.intent_score DESC, i.published_at DESC LIMIT 25`
  ).all(watch.id, now - PROGRESS_WINDOW_DAYS * 864e5) as Material[];
  if (items.length === 0) return [];

  const told = db.prepare(
    'SELECT narrative, told_at FROM told_records WHERE watch_id = ? AND told_at < ? ORDER BY told_at DESC LIMIT 30'
  ).all(watch.id, opts.toldBefore ?? now) as { narrative: string; told_at: number }[];

  db.prepare(
    `UPDATE open_questions SET resolved_at = ?, resolved_by = 'expired'
     WHERE watch_id = ? AND resolved_at IS NULL AND asked_at < ?`
  ).run(now, watch.id, now - QUESTION_TTL_DAYS * 864e5);
  const questions = db.prepare(
    'SELECT id, question FROM open_questions WHERE watch_id = ? AND resolved_at IS NULL ORDER BY asked_at DESC'
  ).all(watch.id) as { id: number; question: string }[];

  // First pass for this watch: this is the opening baseline, not a set of
  // developments. Everything goes on the timeline so tomorrow has something to
  // compare against, but nothing is announced as "new since yesterday" — there
  // is no yesterday yet. Decided here rather than left to prompt ordering.
  const priorMilestones = (db.prepare(
    'SELECT COUNT(*) c FROM milestones WHERE watch_id = ?'
  ).get(watch.id) as { c: number }).c;
  const isBaseline = priorMilestones === 0;

  const lines = [
    'ROLE',
    '你在帮一个人跟进他关注的一件事。你的任务是分辨：哪些是真正的新进展，',
    '哪些只是同一件事换个说法又报了一遍，哪些只是同领域但无关的新闻。',
    '',
    'USER_INTENT（他的原话）',
    watch.intent,
    ''
  ];

  if (told.length) {
    lines.push('ALREADY_TOLD（你之前已经告诉过他的完整内容，逐条列出）');
    for (const t of told) lines.push(`[${localDateKey(t.told_at)}] ${t.narrative}`);
    lines.push('');
    lines.push('规则：如果一条新闻讲的还是上面已经说过的事，即使措辞不同、即使来源不同，');
    lines.push('也要把 isNew 标成 false。只有出现了新的事实——新的数字、新的决定、');
    lines.push('新的一步、结果反转、官方确认——才算 isNew=true。');
  } else {
    lines.push('这是第一次跟进这件事，还没有跟他说过任何内容。');
    lines.push('请梳理出这件事目前的来龙去脉，全部标成 isNew=true 作为起点。');
  }

  if (questions.length) {
    lines.push('', 'OPEN_QUESTIONS（上次留下、还没有下文的悬念）');
    for (const q of questions) lines.push(`Q${q.id}: ${q.question}`);
    lines.push('如果某个节点回答了其中的悬念，在该节点的 answersQuestionIds 里写上对应的 Q 编号。');
  }

  lines.push(
    '',
    'OUTPUT',
    `- summary: 一句话说清这个节点发生了什么，用${lang}写，不要写成标题党`,
    '- occurredOn: 事情发生的日期 YYYY-MM-DD。不能晚于引用材料的日期',
    '- itemIds: 支撑这个节点的材料 id，原样照抄，至少一个',
    '- isNew: 相对 ALREADY_TOLD 是不是新的',
    '- answersQuestionIds: 这个节点回答了哪些 OPEN_QUESTIONS（没有就给空数组）',
    `- openQuestions: 这件事里还没有下文、值得明天继续找的悬念，最多 3 条，用${lang}写，`,
    '  写成能拿去搜新闻的具体问题（谁、什么事、结果如何），不要重复上面 OPEN_QUESTIONS 里还没解决的',
    '',
    '3 到 8 个节点，按时间从早到晚。只用材料里的事实。',
    '',
    'MATERIAL'
  );
  for (const it of items) lines.push(materialBlock(it, 400));

  const t0 = Date.now();
  const res = await provider.generate<{ milestones: any[]; openQuestions?: string[] }>(
    lines.join('\n'),
    { schema: SCHEMA as unknown as Record<string, unknown>, model: provider.writeModel, temperature: 0.2 }
  );

  const validIds = new Set(items.map((i) => i.id));
  const dateOf = new Map(items.map((i) => [i.id, localDateKey(i.publishedAt)]));
  const validQuestions = new Map(questions.map((q) => [`Q${q.id}`, q.id]));
  const out: Milestone[] = [];
  const answered: { questionId: number; milestoneId: string }[] = [];

  for (const m of res.data.milestones ?? []) {
    const itemIds = (m.itemIds ?? []).map(String).filter((x: string) => validIds.has(x));
    if (itemIds.length === 0) continue;                       // must cite real material
    const summary = String(m.summary ?? '').trim();
    if (!summary) continue;
    const occurredOn = String(m.occurredOn ?? '').slice(0, 10);
    // Ported from daily-brief's timeline gate: an event cannot be dated after
    // every source that reports it.
    const latestCited = itemIds.map((id: string) => dateOf.get(id) ?? '').sort().pop() ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn) || (latestCited && occurredOn > latestCited)) continue;
    const id = `ms-${watch.id}-${occurredOn}-${now}-${out.length}`;
    out.push({ id, watchId: watch.id, occurredOn, summary, itemIds,
               firstSeenAt: now, isNew: isBaseline ? false : Boolean(m.isNew) });
    for (const q of m.answersQuestionIds ?? []) {
      const qid = validQuestions.get(String(q).trim());
      if (qid !== undefined) answered.push({ questionId: qid, milestoneId: id });
    }
  }

  const kept = persist(db, watch.id, out);
  saveQuestions(db, watch.id, answered, (res.data.openQuestions ?? []).map((q) => String(q).trim()).filter(Boolean), now);
  log({ event: 'progress.generated', entityId: watch.id, elapsedMs: Date.now() - t0,
        attrs: { produced: out.length, kept: kept.length, isNew: kept.filter((m) => m.isNew).length,
                 baseline: isBaseline, answered: answered.length,
                 dropped: (res.data.milestones ?? []).length - out.length,
                 tokensIn: res.usage?.input, tokensOut: res.usage?.output, model: res.model } });
  return kept;
}

/** Marks answered questions resolved and keeps at most a handful open. */
function saveQuestions(db: Db, watchId: string, answered: { questionId: number; milestoneId: string }[],
                       asked: string[], now: number): void {
  const resolve = db.prepare('UPDATE open_questions SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL');
  const exists = db.prepare('SELECT 1 FROM open_questions WHERE watch_id = ? AND question = ? AND resolved_at IS NULL');
  const ins = db.prepare('INSERT INTO open_questions (watch_id, question, asked_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const a of answered) resolve.run(now, a.milestoneId, a.questionId);
    for (const q of asked.slice(0, 3)) if (!exists.get(watchId, q)) ins.run(watchId, q, now);
    const open = db.prepare(
      'SELECT id FROM open_questions WHERE watch_id = ? AND resolved_at IS NULL ORDER BY asked_at DESC, id DESC'
    ).all(watchId) as { id: number }[];
    for (const o of open.slice(MAX_OPEN_QUESTIONS)) resolve.run(now, 'superseded', o.id);
  })();
}

/** Unanswered questions for the watch page, newest first. */
export function openQuestions(db: Db, watchId: string): { id: number; question: string; askedAt: number }[] {
  return db.prepare(
    `SELECT id, question, asked_at AS askedAt FROM open_questions
     WHERE watch_id = ? AND resolved_at IS NULL ORDER BY asked_at DESC`
  ).all(watchId) as { id: number; question: string; askedAt: number }[];
}

/**
 * Persists milestones and records what was said.
 *
 * `firstSeenAt` is what lets the same dataset serve both views: the "since
 * yesterday" panel shows milestones first seen today, the watch page shows the
 * whole timeline with those highlighted. One judgement, two renderings.
 */
function persist(db: Db, watchId: string, milestones: Milestone[]): Milestone[] {
  // Existing milestones, keyed by date plus the items they cite. Exact string
  // matching is not enough: the model rewords the same event slightly on every
  // run, so near-duplicates would pile up and look like fresh developments.
  const priorRows = db.prepare(
    `SELECT m.id, m.occurred_on AS occurredOn, m.summary,
            (SELECT group_concat(item_id) FROM milestone_sources WHERE milestone_id = m.id) AS items
     FROM milestones m WHERE m.watch_id = ?`
  ).all(watchId) as { id: string; occurredOn: string; summary: string; items: string | null }[];

  const priorByDate = new Map<string, { summary: string; items: Set<string> }[]>();
  for (const r of priorRows) {
    const bucket = priorByDate.get(r.occurredOn) ?? [];
    bucket.push({ summary: r.summary, items: new Set((r.items ?? '').split(',').filter(Boolean)) });
    priorByDate.set(r.occurredOn, bucket);
  }

  const isDuplicate = (m: Milestone): boolean => {
    for (const prior of priorByDate.get(m.occurredOn) ?? []) {
      if (prior.summary === m.summary) return true;
      // Same day and at least one shared source: the same development.
      if (m.itemIds.some((id) => prior.items.has(id))) return true;
    }
    return false;
  };

  const insMs = db.prepare(
    `INSERT INTO milestones (id, watch_id, occurred_on, first_seen_at, summary, is_new, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
  );
  const insSrc = db.prepare(
    'INSERT INTO milestone_sources (milestone_id, item_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  );
  const insTold = db.prepare(
    'INSERT INTO told_records (watch_id, narrative, surface, surface_id, told_at) VALUES (?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  const kept: Milestone[] = [];
  db.transaction(() => {
    for (const m of milestones) {
      if (isDuplicate(m)) continue;
      kept.push(m);
      insMs.run(m.id, watchId, m.occurredOn, m.firstSeenAt, m.summary, m.isNew ? 1 : 0, now);
      for (const id of m.itemIds) insSrc.run(m.id, id);
      // Record EVERY milestone we surfaced, not only the ones flagged new:
      // if the user could see it on the timeline, we told them, and tomorrow's
      // pass must know that.
      insTold.run(watchId, m.summary, 'progress', m.id, now);
      const bucket = priorByDate.get(m.occurredOn) ?? [];
      bucket.push({ summary: m.summary, items: new Set(m.itemIds) });
      priorByDate.set(m.occurredOn, bucket);
    }
  })();
  return kept;
}

/** Milestones first seen today — the "since yesterday" panel. */
export function newSinceYesterday(db: Db, watchId: string, hours = 36): Milestone[] {
  return (db.prepare(
    `SELECT id, watch_id AS watchId, occurred_on AS occurredOn, summary,
            first_seen_at AS firstSeenAt, is_new AS isNew
     FROM milestones WHERE watch_id = ? AND is_new = 1 AND first_seen_at >= ?
     ORDER BY occurred_on DESC`
  ).all(watchId, Date.now() - hours * 3600_000) as any[])
    .map((r) => ({ ...r, isNew: Boolean(r.isNew), itemIds: sourcesOf(db, r.id) }));
}

/** The whole timeline — the watch page. */
export function timeline(db: Db, watchId: string): Milestone[] {
  return (db.prepare(
    `SELECT id, watch_id AS watchId, occurred_on AS occurredOn, summary,
            first_seen_at AS firstSeenAt, is_new AS isNew
     FROM milestones WHERE watch_id = ? ORDER BY occurred_on`
  ).all(watchId) as any[])
    .map((r) => ({ ...r, isNew: Boolean(r.isNew), itemIds: sourcesOf(db, r.id) }));
}

const sourcesOf = (db: Db, milestoneId: string): string[] =>
  (db.prepare('SELECT item_id AS id FROM milestone_sources WHERE milestone_id = ?').all(milestoneId) as { id: string }[])
    .map((r) => r.id);
