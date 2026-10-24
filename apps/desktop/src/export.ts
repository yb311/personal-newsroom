import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type SaveDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, localDateKey } from '@pnr/core';
import { backupDatabase, type Db } from '@pnr/store';
import { buildOpml } from '@pnr/feed';
import { buildExport, buildChatExport, toHtml, toMarkdown, type ExportDoc, type ExportFormat, type ExportLabels, type ScreenInput } from '@pnr/generate';
import type zhCN from '../../renderer/src/locales/zh-CN.json';

/**
 * 导出 (File menu and the toolbar's export button): what is open as Markdown,
 * HTML or PDF; the subscriptions as OPML; and the whole library as one zip.
 * The renderer only names what is open; the documents are built from the
 * database (packages/generate/src/export.ts).
 */
type Texts = typeof zhCN.export;
export type ExportResult = { ok: true; path: string; count?: number; skipped?: number } | { ok: false; reason: 'cancelled' | 'missing' | 'failed' };
type Translation = { mode: 'original' | 'bilingual' | 'translation'; target: string };

const EXT: Record<ExportFormat, string> = { markdown: 'md', html: 'html', pdf: 'pdf' };
const FILTER: Record<ExportFormat, string> = { markdown: 'Markdown', html: 'HTML', pdf: 'PDF' };
const run = promisify(execFile);

/** A file name from a headline: no path separators, no characters Finder rejects, not too long. */
const fileName = (title: string): string =>
  (title.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'export');

export function registerExport(deps: { db: Db; dataDir: string; texts: () => Texts; locale: () => string }): void {
  const { db, dataDir } = deps;
  const labels = (): ExportLabels => deps.texts().doc;

  const ask = async (e: IpcMainInvokeEvent, options: SaveDialogOptions): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    const res = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return res.canceled || !res.filePath ? null : res.filePath;
  };

  const save = async (e: IpcMainInvokeEvent, doc: ExportDoc | null, format: ExportFormat, kind: string): Promise<ExportResult> => {
    if (!doc) return { ok: false, reason: 'missing' };
    if (!(format in EXT)) return { ok: false, reason: 'failed' };
    const path = await ask(e, { defaultPath: join(app.getPath('downloads'), `${fileName(doc.title)}.${EXT[format]}`),
      filters: [{ name: FILTER[format], extensions: [EXT[format]] }] });
    if (!path) return { ok: false, reason: 'cancelled' };
    if (format === 'pdf') e.sender.send('app:progress', { phase: 'export' });
    try {
      if (format === 'markdown') writeFileSync(path, toMarkdown(doc, labels()));
      else if (format === 'html') writeFileSync(path, toHtml(doc, labels()));
      else writeFileSync(path, await printPdf(toHtml(doc, labels())));
      log({ event: 'export.document', outcome: 'ok', attrs: { format, kind } });
      return { ok: true, path };
    } catch (err) {
      log({ event: 'export.document', outcome: 'failed', reasonDetail: String(err), attrs: { format, kind } });
      return { ok: false, reason: 'failed' };
    }
  };

  const translation = (t: Translation | undefined): Translation | undefined =>
    t && ['original', 'bilingual', 'translation'].includes(t.mode) && typeof t.target === 'string' ? { mode: t.mode, target: t.target } : undefined;

  ipcMain.handle('export:document', (e, input: { screen: ScreenInput; format: ExportFormat; translation?: Translation }) => {
    if (!input?.screen?.focus) return { ok: false, reason: 'missing' } satisfies ExportResult;
    const doc = buildExport(db, input.screen.focus, { labels: labels(), locale: deps.locale(), translation: translation(input.translation) });
    return save(e, doc, input.format, input.screen.focus.kind);
  });

  ipcMain.handle('export:chat', (e, chatId: string, format: ExportFormat) =>
    save(e, buildChatExport(db, String(chatId), { labels: labels(), locale: deps.locale() }), format, 'chat'));

  ipcMain.handle('export:opml', async (e): Promise<ExportResult> => {
    const T = deps.texts();
    const instance = (db.prepare("SELECT value FROM settings WHERE key = 'rsshub.instanceUrl'").get() as { value: string } | undefined)?.value;
    const opml = buildOpml(db, { title: T.opmlTitle, lang: deps.locale(), rssHubInstance: instance ?? null });
    const path = await ask(e, { defaultPath: join(app.getPath('downloads'), `${fileName(T.opmlTitle)}.opml`), filters: [{ name: 'OPML', extensions: ['opml'] }] });
    if (!path) return { ok: false, reason: 'cancelled' };
    try {
      writeFileSync(path, opml.xml);
      log({ event: 'export.opml', outcome: 'ok', attrs: { count: opml.count, skipped: opml.skipped } });
      return { ok: true, path, count: opml.count, skipped: opml.skipped };
    } catch (err) {
      log({ event: 'export.opml', outcome: 'failed', reasonDetail: String(err) });
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('export:backup', async (e): Promise<ExportResult> => {
    const T = deps.texts();
    const name = `${T.backupName} ${localDateKey()}`;
    const path = await ask(e, { defaultPath: join(app.getPath('downloads'), `${fileName(name)}.zip`), filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (!path) return { ok: false, reason: 'cancelled' };
    e.sender.send('app:progress', { phase: 'backup' });
    const work = mkdtempSync(join(tmpdir(), 'pnr-backup-'));
    try {
      const stage = join(work, fileName(name));
      mkdirSync(stage);
      await backupLibrary(db, dataDir, stage);
      writeFileSync(join(stage, `${fileName(T.readmeName)}.txt`), T.readme.replace('{{dir}}', dataDir));
      rmSync(path, { force: true });
      // ditto keeps Chinese file names as UTF-8 (as Finder's 压缩 does); the --no* flags keep
      // Mac-only extras (resource forks, extended attributes, __MACOSX) out of the zip.
      await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', stage, path]);
      log({ event: 'export.backup', outcome: 'ok' });
      return { ok: true, path };
    } catch (err) {
      log({ event: 'export.backup', outcome: 'failed', reasonDetail: String(err) });
      return { ok: false, reason: 'failed' };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

/** Copies the database (without its keys) and the article bodies into `stage`. */
async function backupLibrary(db: Db, dataDir: string, stage: string): Promise<void> {
  await backupDatabase(db, join(stage, 'newsroom.db'));
  const bodies = join(dataDir, 'bodies');
  if (existsSync(bodies)) cpSync(bodies, join(stage, 'bodies'), { recursive: true });
}

/**
 * Prints an exported page to PDF in a hidden window with scripts off. Remote
 * images get 20 seconds to arrive; a page still loading then is printed as it is.
 */
export async function printPdf(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pnr-export-'));
  const file = join(dir, 'export.html');
  writeFileSync(file, html);
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await Promise.race([w.loadFile(file).catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))]);
    return await w.webContents.printToPDF({ preferCSSPageSize: true, printBackground: false, generateDocumentOutline: true, generateTaggedPDF: true });
  } finally {
    w.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}
