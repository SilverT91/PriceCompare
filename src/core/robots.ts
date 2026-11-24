// robots.txt evaluation following RFC 9309: the group for our product token, else the "*" group;
// the longest matching rule wins and Allow wins a tie; "*" and "$" are supported.
// A 4xx robots.txt means "no rules"; 5xx or an unreachable robots.txt means "disallow everything".

export const ROBOTS_TOKEN = 'price-compare';

export type RobotsMode = 'rules' | 'allow_all' | 'disallow_all';

export interface RobotsRecord {
  mode: RobotsMode;
  /** [allow, pattern] pairs of the group that applies to us. */
  rules: [boolean, string][];
  status: number | null;
  note?: string;
}

export function parseRobots(text: string, token = ROBOTS_TOKEN): [boolean, string][] {
  const groups: { agents: string[]; rules: [boolean, string][] }[] = [];
  let agents: string[] = [];
  let rules: [boolean, string][] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (inRules) {
        groups.push({ agents, rules });
        agents = [];
        rules = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (value) rules.push([key === 'allow', value]);
    }
  }
  if (agents.length) groups.push({ agents, rules });
  const tok = token.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a === tok));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function normalisePath(p: string): string {
  // Compare in percent-encoded form, but decode unreserved characters so "%7E" and "~" match.
  return p.replace(/%[0-9a-f]{2}/gi, (m) => {
    const c = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
  });
}

function matchLength(pattern: string, path: string): number {
  let pat = normalisePath(pattern.replace(/[^\x00-\x7f]/g, (c) => encodeURIComponent(c)));
  const anchored = pat.endsWith('$');
  if (anchored) pat = pat.slice(0, -1);
  const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path) ? pat.length : -1;
}

export function robotsAllows(rec: RobotsRecord, url: string): boolean {
  if (rec.mode === 'allow_all') return true;
  if (rec.mode === 'disallow_all') return false;
  const u = new URL(url);
  if (u.pathname === '/robots.txt') return true;
  // Encode the way a browser sends it (URL already percent-encodes non-ASCII).
  const path = normalisePath((u.pathname || '/') + u.search);
  let bestLen = -1;
  let bestAllow = true;
  for (const [allow, pattern] of rec.rules) {
    const n = matchLength(pattern, path);
    if (n > bestLen || (n === bestLen && allow && !bestAllow)) {
      bestLen = n;
      bestAllow = allow;
    }
  }
  return bestAllow;
}

export function robotsFromResponse(status: number | null, text: string | null): RobotsRecord {
  if (status === null) return { mode: 'disallow_all', rules: [], status, note: 'robots.txt unreachable' };
  if (status >= 500) return { mode: 'disallow_all', rules: [], status, note: `robots.txt HTTP ${status}` };
  if (status >= 400) return { mode: 'allow_all', rules: [], status, note: `robots.txt HTTP ${status} (no rules)` };
  return { mode: 'rules', rules: parseRobots(text ?? ''), status };
}
