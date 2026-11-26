// Scope fence: an agent asked to fix login that starts rewriting payments is not stuck, it is
// wandering. The areas of the code it changed (a folder such as src/payments) are set against
// what it was asked and planned (INTENT, SPEC, PLAN, its brief): an area none of them names,
// changed in more than a line or two, is drift. Tests, docs and config are never drift, and an
// area the person allowed is in scope from then on. When the intent and plan name no area at all,
// nothing can be judged and nothing is said. No model is asked: each area is a fact to check.

// Folders that hold modules: their area is one level deeper (src/payments, packages/api).
const CONTAINERS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'services', 'internal', 'pkg', 'cmd', 'modules', 'components', 'server', 'client', 'web', 'api']);
const MIN_FILES = 2;
const MIN_LINES = 30;

/** The area of a file: its module folder, or "(top)" for a file at the top. */
export function areaOf(file) {
  const parts = String(file).split('/').filter(Boolean);
  if (parts.length < 2) return '(top)';
  if (CONTAINERS.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/** Tests, docs and config: changed along with any work, never a sign of drift. */
export function incidental(file) {
  const f = String(file).toLowerCase();
  const base = f.split('/').pop();
  return (
    /(^|\/)(tests?|__tests__|spec|e2e|fixtures|docs?|\.github|\.vscode)\//.test(f) ||
    /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|\.(md|txt|rst|lock)$/.test(f) ||
    /^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig.*\.json|\.gitignore|\.eslintrc.*|\.prettierrc.*|dockerfile|makefile|readme.*|changelog.*|license.*)$/.test(base) ||
    /\.config\.[a-z]+$/.test(base)
  );
}

const words = (s) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3));

/** Whether the text names an area: its path, its folder name, or one of its files. */
function named(area, files, text, ws) {
  if (area === '(top)') return files.some((f) => text.includes(f.toLowerCase()) || ws.has(f.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase()));
  const a = area.toLowerCase();
  const leaf = a.split('/').pop();
  if (text.includes(a) || (leaf.length >= 4 && ws.has(leaf))) return true;
  // A singular or plural of the folder ("payment" for payments).
  if (leaf.length >= 5 && (ws.has(leaf.replace(/s$/, '')) || ws.has(`${leaf}s`))) return true;
  return files.some((f) => {
    const base = f.split('/').pop().toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    return text.includes(f.toLowerCase()) || text.includes(base) || (stem.length >= 4 && ws.has(stem));
  });
}

/**
 * The fence: { judged, areas: [{ area, files, lines, inScope, why }], drift: [the out-of-scope
 * areas big enough to mention] }. `files`: { path: { added, removed } } (what it changed so far);
 * `text`: what it was asked and planned; `allowed`: areas the person said are fine.
 */
export function fenceOf({ files = {}, text = '', allowed = [] }) {
  const t = String(text).toLowerCase();
  const ws = words(text);
  const by = new Map();
  for (const [f, c] of Object.entries(files)) {
    if (incidental(f)) continue;
    const a = areaOf(f);
    const e = by.get(a) ?? by.set(a, { area: a, files: [], lines: 0 }).get(a);
    e.files.push(f);
    e.lines += (c?.added ?? 0) + (c?.removed ?? 0);
  }
  const areas = [...by.values()].map((e) => {
    const ok = allowed.includes(e.area) ? 'allowed by you' : named(e.area, e.files, t, ws) ? 'named in what it was asked or planned' : null;
    return { ...e, files: e.files.sort(), inScope: Boolean(ok), why: ok ?? 'not named in what it was asked or planned' };
  });
  // Nothing in the intent or plan names any area it changed: a vague task, which can't be fenced.
  const judged = areas.some((a) => a.inScope && a.why !== 'allowed by you');
  const drift = judged ? areas.filter((a) => !a.inScope && (a.files.length >= MIN_FILES || a.lines >= MIN_LINES)).sort((x, y) => y.lines - x.lines) : [];
  return { judged, areas: areas.sort((x, y) => y.lines - x.lines), drift };
}

/** One line for a drift: "src/payments (3 files, 80 lines)". */
export const driftLine = (d) => `${d.area} (${d.files.length} file${d.files.length === 1 ? '' : 's'}, ${d.lines} line${d.lines === 1 ? '' : 's'})`;

/** What the agent is told when the person pulls it back. */
export const pullBackMessage = (drift) =>
  `You have been changing code outside what you were asked and planned: ${drift.map(driftLine).join('; ')}. Stay within the task. Undo those changes unless the task cannot be done without them; if it cannot, say why in your brief and keep them as small as you can.`;
