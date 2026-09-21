/**
 * The RSSHub routes the app offers ready-made, and turning a pasted web
 * address into one of them.
 *
 * The list is data (catalogs/data/rsshub-routes.json), produced by
 * catalogs/verify-rsshub.ts from RSSHub's own route metadata: names, parameter
 * descriptions, examples and "radar" rules (RSSHub's mapping from a site's
 * page addresses to routes). Only routes that need no cookie, key or browser
 * and returned items when tried are included.
 */
export interface RouteParam {
  key: string;
  /** RSSHub's description, e.g. "用户 id, 可在 UP 主主页中找到". */
  description: string;
  optional: boolean;
  options?: { value: string; label: string }[];
  default?: string;
  /** Parameters that only tune output (embed, routeParams …); not shown in forms. */
  advanced?: boolean;
}

export interface CuratedRoute {
  id: string;
  platform: string;
  name: string;
  /** Full route template, e.g. "/bilibili/user/video/:uid/:embed?". */
  path: string;
  example: string;
  params: RouteParam[];
  /** Page-address patterns that map to this route, e.g. "space.bilibili.com/:uid". */
  sources: string[];
  site: string | null;
}

let curated: CuratedRoute[] = [];
/** Installs the bundled route list; the main process loads it at start-up. */
export function setCuratedRoutes(routes: CuratedRoute[]): void { curated = routes; }
export const curatedRoutes = (): CuratedRoute[] => curated;

const segmentsOf = (template: string): { name: string | null; optional: boolean; literal: string }[] =>
  template.split('/').filter(Boolean).map((seg) => {
    const m = seg.match(/^:([A-Za-z0-9_]+)(\{[^}]*\})?(\?)?$/);
    return m ? { name: m[1]!, optional: Boolean(m[3]), literal: '' } : { name: null, optional: false, literal: seg };
  });

/**
 * Builds a route from its template and the values the person entered. Missing
 * optional parameters are dropped from the end; a missing required one, or an
 * optional one followed by a filled one, makes the route unusable (null).
 */
export function fillRoute(route: Pick<CuratedRoute, 'path'>, values: Record<string, string | undefined>): string | null {
  const out: string[] = [];
  let gap = false;
  for (const seg of segmentsOf(route.path)) {
    if (!seg.name) { if (gap) return null; out.push(seg.literal); continue; }
    const v = values[seg.name]?.trim();
    if (!v) { if (!seg.optional) return null; gap = true; continue; }
    if (gap) return null;
    out.push(encodeURIComponent(v));
  }
  return `/${out.join('/')}`;
}

/** Matches a page address against one radar source pattern; returns captured values. */
function matchSource(source: string, url: URL): Record<string, string> | null {
  const [hostPattern, ...pathPattern] = source.split('/');
  const host = url.hostname.toLowerCase();
  const want = (hostPattern ?? '').toLowerCase();
  if (host !== want && host !== `www.${want}` && `www.${host}` !== want) return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const values: Record<string, string> = {};
  const pattern = pathPattern.filter(Boolean);
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p === '*' || p.startsWith('*')) {
      if (p.length > 1) values[p.slice(1)] = parts.slice(i).join('/');
      return values;
    }
    const part = parts[i];
    const param = p.match(/^:([A-Za-z0-9_]+)(\?)?$/);
    if (param) {
      if (part === undefined) { if (param[2]) continue; return null; }
      values[param[1]!] = part;
      continue;
    }
    if (part !== p) return null;
  }
  return parts.length <= pattern.length ? values : null;
}

/**
 * Finds the first curated route a page address belongs to, e.g.
 * https://sspai.com/u/urfp0d9i/posts → /sspai/author/urfp0d9i.
 * The route is filled from its own template with the values the address
 * yields; radar targets are not trusted, since some point at routes that
 * need a login.
 */
export function matchRouteFromUrl(routes: CuratedRoute[], input: string): { route: CuratedRoute; path: string } | null {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`); } catch { return null; }
  for (const route of routes) {
    for (const source of route.sources) {
      const values = matchSource(source, url);
      if (!values) continue;
      const path = fillRoute(route, values);
      if (path) return { route, path };
    }
  }
  return null;
}
