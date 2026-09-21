import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Content security policy for the built app. Article bodies are sanitised by
 * the reader core before they reach the page; this is the second line: even if
 * something slipped through, no script from an article could run and nothing
 * could be posted anywhere. Images and media load from any site because
 * articles embed them from publishers' CDNs, some still over plain http.
 *
 * Build only: the dev server injects an inline script for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src https: http: data: blob:',
  'media-src https: http:',
  'frame-src https:',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

const contentSecurityPolicy = (): Plugin => ({
  name: 'pnr-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }]
});

export default defineConfig({
  root: resolve(import.meta.dirname, '../renderer'),
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  build: { outDir: resolve(import.meta.dirname, 'dist/renderer'), emptyOutDir: true },
  server: { port: 5173, strictPort: true }
});
