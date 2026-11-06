// Reviews: agents that review other people's pull requests for you. A reviewer agent reads the
// change, checks out its head, asks the critical questions the code doesn't answer and decides
// whether anything blocks approval. It writes REVIEW.json next to its brief; nothing goes to
// GitHub until you tick what to send and post it as a pending review under your name. When the
// author pushes, the reviewer re-checks its earlier blockers.

import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';
import { run } from './git.js';
import { ghBin } from './tracker.js';

export const REVIEW_FILE = 'REVIEW.json';
export const reviewPath = (agentId) => path.join(briefDir(agentId), REVIEW_FILE);

const PR_URL = /^<?(https?:\/\/[\w.-]+\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+))/;
const VERDICTS = ['approve', 'approve_with_nits', 'blocked'];
export const VERDICT_LABEL = { approve: 'Approve', approve_with_nits: 'Approve with nits', blocked: 'Blocked' };
const CATEGORIES = ['correctness', 'security', 'data', 'breaking', 'tests', 'performance', 'design', 'other'];
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A pull request link -> { url, owner, repo, number, slug: "owner/repo" }, or null. */
export function parsePrUrl(text) {
  const m = String(text ?? '').trim().match(PR_URL);
  if (!m) return null;
  return { url: m[1], owner: m[2], repo: m[3], number: Number(m[4]), slug: `${m[2]}/${m[3]}` };
}

/** The reviewer's instructions: read-only, the review in `file` as JSON. */
export function reviewerPrompt(file, pr) {
  return [
    `You are reviewing someone else's pull request for the user, who is a requested reviewer on it: ${pr.url}. You don't change it.`,
    `Getting the code: in your folder, run "git fetch origin pull/${pr.number}/head:review/pr-${pr.number}" and "git checkout review/pr-${pr.number}" (fetch again after new pushes). ` +
      `Read the description and discussion (gh pr view ${pr.url} --comments), the diff (gh pr diff ${pr.url}), and as much of the surrounding code as you need to understand what the change touches: callers, tests, config, migrations. ` +
      'Read the linked issue or design doc if there is one. You may build and run the tests.',
    'Never commit, push, edit the pull request, approve, request changes or comment on GitHub: the user decides and posts. Don\'t change files in the repository except to run the tests.',
    'Be critical, like a careful senior reviewer. For each concern, reason it through against the code before you write it down: is it real, how would it fail, who would notice? ' +
      'A blocker is something that should stop approval: a bug, a security or data-loss risk, a breaking change without a migration, a missing test for risky logic, or a change that doesn\'t do what the PR says. Style and taste are nits, never blockers. ' +
      'Questions are what the code and description don\'t answer and the author should: intent, edge cases, rollout and rollback, why this approach.',
    `Write the review to ${file} as JSON, and keep it current:\n` +
      '{\n' +
      `  "pr": "${pr.url}",\n` +
      '  "headSha": "<the commit you reviewed: git rev-parse HEAD>",\n' +
      '  "verdict": "approve" | "approve_with_nits" | "blocked",\n' +
      '  "why": "<one or two sentences: why that verdict>",\n' +
      '  "summary": "<what the change does, in two or three sentences>",\n' +
      '  "blockers": [{ "id": "b1", "title": "<short>", "file": "<path>", "line": <line in the new file, or null>, "category": "correctness|security|data|breaking|tests|performance|design|other", "why": "<how it fails, with evidence from the code>", "unblock": "<what would resolve it>", "status": "open" | "resolved" }],\n' +
      '  "questions": [{ "id": "q1", "question": "<for the author>", "why": "<why it matters>", "file": "<path or null>", "line": <line or null> }],\n' +
      '  "risks": ["<risk that isn\'t a blocker>"],\n' +
      '  "testGaps": ["<behaviour with no test>"],\n' +
      '  "nits": [{ "id": "n1", "text": "<minor>", "file": "<path or null>", "line": <line or null> }],\n' +
      '  "tests": "<what you ran and the result, or why you didn\'t>"\n' +
      '}\n' +
      'Every blocker has a verdict of "blocked" behind it; with no open blockers the verdict is approve or approve_with_nits. Lines are lines of the new file that the diff touches, so they can carry a comment.',
    `When a message says the author pushed, fetch again, re-check each blocker (mark it "resolved" when the new code fixes it, and say how in "why"), review what changed, update headSha and the verdict, and rewrite ${file}.`,
    'Finish each pass with your status as done in the brief and the verdict in one line.',
  ].join('\n\n');
}

const list = (xs, n, f) => (Array.isArray(xs) ? xs : []).slice(0, n).map(f).filter(Boolean);
const lineOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** REVIEW.json, cleaned up: unknown values dropped, ids filled in, lengths capped. */
export function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const blockers = list(raw.blockers, 30, (b, i) =>
    b?.title || b?.why
      ? {
          id: String(b.id || `b${i + 1}`),
          title: clip(b.title || b.why, 200),
          file: b.file ? clip(b.file, 300) : null,
          line: lineOf(b.line),
          category: CATEGORIES.includes(b.category) ? b.category : 'other',
          why: clip(b.why, 2000),
          unblock: clip(b.unblock, 1000),
          status: b.status === 'resolved' ? 'resolved' : 'open',
        }
      : null,
  );
  const open = blockers.filter((b) => b.status === 'open').length;
  let verdict = VERDICTS.includes(raw.verdict) ? raw.verdict : open ? 'blocked' : null;
  // An open blocker always blocks, whatever the verdict says.
  if (open && verdict !== 'blocked') verdict = 'blocked';
  return {
    pr: raw.pr ? String(raw.pr) : null,
    headSha: /^[0-9a-f]{7,40}$/i.test(raw.headSha ?? '') ? raw.headSha : null,
    verdict,
    why: clip(raw.why, 1000),
    summary: clip(raw.summary, 1500),
    blockers,
    questions: list(raw.questions, 30, (q, i) =>
      q?.question ? { id: String(q.id || `q${i + 1}`), question: clip(q.question, 1000), why: clip(q.why, 1000), file: q.file ? clip(q.file, 300) : null, line: lineOf(q.line) } : null,
    ),
    risks: list(raw.risks, 20, (r) => (r ? clip(r, 600) : null)),
    testGaps: list(raw.testGaps, 20, (r) => (r ? clip(r, 600) : null)),
    nits: list(raw.nits, 40, (n, i) => (n?.text ? { id: String(n.id || `n${i + 1}`), text: clip(n.text, 600), file: n.file ? clip(n.file, 300) : null, line: lineOf(n.line) } : null)),
    tests: clip(raw.tests, 1000),
    openBlockers: open,
  };
}

/** The reviewer's REVIEW.json: { review, updatedAt } or null (missing or not JSON yet). */
export function readReview(agentId) {
  try {
    const file = reviewPath(agentId);
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    // Tolerate a fenced block or text around the object.
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const review = normalizeReview(JSON.parse(json));
    return review ? { review, updatedAt: st.mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

/** What to tell a reviewer when the author pushed. */
export const recheckMessage = (pr, head) =>
  `The author pushed new commits to ${pr.url} (head ${String(head).slice(0, 12)}). Fetch them, re-check each blocker (resolved or still open), review what changed, and update the review.`;

const where = (x) => (x.file ? `\`${x.file}${x.line ? `:${x.line}` : ''}\`` : '');

/** Each item you can send, by id: what it says as a comment. */
function items(review) {
  const out = [];
  for (const b of review.blockers.filter((x) => x.status === 'open')) {
    out.push({ id: b.id, kind: 'blocker', file: b.file, line: b.line, text: `**Blocker: ${b.title}**\n\n${b.why}${b.unblock ? `\n\nTo resolve: ${b.unblock}` : ''}` });
  }
  for (const q of review.questions) out.push({ id: q.id, kind: 'question', file: q.file, line: q.line, text: `**Question:** ${q.question}${q.why ? `\n\n${q.why}` : ''}` });
  for (const n of review.nits) out.push({ id: n.id, kind: 'nit', file: n.file, line: n.line, text: `Nit: ${n.text}` });
  return out;
}

/**
 * The review as you'd send it: the picked items (all open blockers and questions when `ids` is
 * not given). Comments with a file and line go on those lines; the rest go in the body.
 */
export function reviewDraft(review, ids = null) {
  const all = items(review);
  const want = ids ? new Set(ids) : null;
  const picked = all.filter((i) => (want ? want.has(i.id) : i.kind !== 'nit'));
  const inline = picked.filter((i) => i.file && i.line);
  const general = picked.filter((i) => !(i.file && i.line));
  const head = review.openBlockers ? `${review.openBlockers} thing${review.openBlockers === 1 ? '' : 's'} to resolve before this can be approved.` : '';
  const body = [head, ...general.map((i) => `${i.text.replace(/\n\n/g, '\n')}${i.file ? `\n(${where(i)})` : ''}`)].filter(Boolean).join('\n\n');
  return { body, comments: inline.map((i) => ({ path: i.file, line: i.line, side: 'RIGHT', body: i.text })), picked: picked.map((i) => i.id) };
}

/** The whole review as Markdown, to read or paste. */
export function reviewMarkdown(row) {
  const r = row.review;
  const head = `## Review of ${row.pr.title ? `${row.pr.title} ` : ''}(${row.pr.url})`;
  if (!r) return `${head}\n\nThe reviewer is still reading the change.`;
  const sec = (title, xs) => (xs.length ? `### ${title}\n${xs.join('\n')}` : null);
  return [
    head,
    `**${VERDICT_LABEL[r.verdict] ?? 'No verdict yet'}**${r.why ? `: ${r.why}` : ''}`,
    r.summary,
    sec('Blockers', r.blockers.map((b) => `- ${b.status === 'resolved' ? '~~' : ''}**${b.title}**${b.status === 'resolved' ? '~~ (resolved)' : ''} ${where(b)} (${b.category})\n  ${b.why}${b.unblock ? `\n  To resolve: ${b.unblock}` : ''}`)),
    sec('Questions for the author', r.questions.map((q) => `- ${q.question} ${where(q)}${q.why ? `\n  ${q.why}` : ''}`)),
    sec('Risks', r.risks.map((x) => `- ${x}`)),
    sec('Test gaps', r.testGaps.map((x) => `- ${x}`)),
    sec('Nits', r.nits.map((n) => `- ${n.text} ${where(n)}`)),
    r.tests ? `### Tests\n${r.tests}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One row per reviewer agent, then requested PRs that have none (newest first). */
export function reviewRows(views, requested = [], read = readReview) {
  const rows = [];
  const taken = new Set();
  for (const v of views) {
    if (!v.reviewing) continue;
    const pr = (v.prs ?? []).find((p) => p.url === v.reviewing.url) ?? {};
    const got = read(v.id);
    const review = got?.review ?? null;
    taken.add(v.reviewing.url);
    const head = pr.head ?? null;
    rows.push({
      pr: { url: v.reviewing.url, repo: v.reviewing.slug, number: v.reviewing.number, title: pr.title ?? v.reviewing.title ?? null, state: pr.state ?? null, isDraft: Boolean(pr.isDraft), checks: pr.checks ?? null, head },
      agent: { id: v.id, name: v.name, running: Boolean(v.runtime?.running), busy: Boolean(v.runtime?.busy) },
      review,
      updatedAt: got?.updatedAt ?? v.createdAt ?? null,
      // The author pushed since this review was written.
      stale: Boolean(review?.headSha && head && !head.startsWith(review.headSha) && !review.headSha.startsWith(head)),
      posted: v.reviewing.posted ?? null,
      status: !review ? (v.runtime?.busy || v.status === 'preparing' ? 'reviewing' : 'no review') : review.verdict ?? 'reviewing',
    });
  }
  for (const p of requested) {
    if (taken.has(p.url)) continue;
    rows.push({ pr: { url: p.url, repo: p.repo, number: p.number, title: p.title ?? null, state: 'OPEN', author: p.author ?? null }, agent: null, review: null, updatedAt: p.updatedAt ?? null, stale: false, posted: null, status: 'requested' });
  }
  const rank = { requested: 0, blocked: 1, approve_with_nits: 2, approve: 3, reviewing: 4, 'no review': 5 };
  return rows.sort((a, b) => Number(b.stale) - Number(a.stale) || (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

/** PRs where your review is requested, from GitHub: [{ url, repo, number, title, author, updatedAt }]. */
export async function requestedReviews() {
  if (process.env.AGENTMGR_NO_GH) return [];
  try {
    const out = await run(ghBin(), ['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '50', '--json', 'url,title,repository,author,updatedAt,number'], { timeout: 30_000 });
    return JSON.parse(out || '[]').map((p) => ({ url: p.url, repo: p.repository?.nameWithOwner ?? parsePrUrl(p.url)?.slug ?? null, number: p.number, title: p.title, author: p.author?.login ?? null, updatedAt: p.updatedAt }));
  } catch {
    return [];
  }
}

export class Reviews {
  constructor({ manager, store, log = () => {} }) {
    this.manager = manager;
    this.store = store;
    this.log = log;
    this.requested = { at: 0, list: [] };
    this.onPrs = (agent) => this.recheck(agent);
    manager.on('prs', this.onPrs);
  }

  close() {
    this.manager.off('prs', this.onPrs);
  }

  /** The reviewer agent for a PR, if there is one. */
  agentFor(url) {
    return this.store.list().find((a) => a.reviewing?.url === url) ?? null;
  }

  /** The project whose repository is the PR's, else its GitHub URL. */
  where(pr, project) {
    if (project) {
      const p = String(project).replace(/^@/, '');
      if (!this.manager.resolveProject(p)) throw err(400, `No project @${p}; see agentmgr project ls`);
      return { project: p };
    }
    const slug = pr.slug.toLowerCase();
    const match = this.manager.listProjects().find((p) => {
      const repo = String(p.repo ?? '').toLowerCase().replace(/\.git$/, '');
      return repo.endsWith(`/${slug}`) || repo.endsWith(`:${slug}`) || String(p.key ?? '').endsWith(`/${slug}`);
    });
    return match ? { project: match.shortcut } : { repo: `https://github.com/${pr.slug}.git` };
  }

  /** Start a reviewer for a PR link. */
  start({ url, project = null, startedBy = null, notes = '' } = {}) {
    const pr = parsePrUrl(url);
    if (!pr) throw err(400, 'Give a pull request link (https://github.com/<owner>/<repo>/pull/<number>)');
    const prev = this.agentFor(pr.url);
    if (prev) throw err(409, `${prev.name} (${prev.id}) already reviews ${pr.url}`);
    const title = this.requested.list.find((p) => p.url === pr.url)?.title ?? null;
    const intent = `Review ${pr.url}${title ? `: ${title}` : ''}${notes ? `\n\n${String(notes).trim()}` : ''}`;
    return this.manager.create({
      ...this.where(pr, project),
      intent,
      name: `review-${pr.repo}-${pr.number}`.toLowerCase(),
      reviewing: { url: pr.url, slug: pr.slug, number: pr.number, title },
      ...(startedBy ? { startedBy } : {}),
    });
  }

  /** Requested PRs, refreshed at most once a minute. */
  async requestedList({ fresh = false } = {}) {
    if (fresh || Date.now() - this.requested.at > 60_000) this.requested = { at: Date.now(), list: await requestedReviews() };
    return this.requested.list;
  }

  async rows({ fresh = false } = {}) {
    const views = this.store.list().filter((a) => a.reviewing).map((a) => this.manager.view(a));
    const skip = new Set(this.store.data.reviewsDismissed ?? []);
    return reviewRows(views, (await this.requestedList({ fresh })).filter((p) => !skip.has(p.url)));
  }

  /** Requested PRs you won't have an agent review: off the list. */
  dismiss(urls = []) {
    const list = (this.store.data.reviewsDismissed ??= []);
    let n = 0;
    for (const u of urls.map((x) => parsePrUrl(x)?.url).filter(Boolean)) {
      if (!list.includes(u)) {
        list.push(u);
        n += 1;
      }
    }
    if (list.length > 300) list.splice(0, list.length - 300);
    this.store.save();
    return { dismissed: n };
  }

  row(ref) {
    const a = this.manager.mustGet(ref);
    if (!a.reviewing) throw err(400, `${a.name} isn't reviewing a pull request`);
    return reviewRows([this.manager.view(a)])[0];
  }

  /** After the author pushes: tell the reviewer once per new head. */
  recheck(agent) {
    if (!agent?.reviewing) return;
    const pr = agent.prs?.[agent.reviewing.url];
    const got = readReview(agent.id);
    if (!pr?.head || pr.state !== 'OPEN' || !got?.review?.headSha) return;
    const reviewed = got.review.headSha;
    if (pr.head.startsWith(reviewed) || reviewed.startsWith(pr.head)) return;
    if (agent.reviewing.recheckedFor === pr.head) return;
    this.manager.patch(agent.id, { reviewing: { ...agent.reviewing, recheckedFor: pr.head } });
    try {
      this.manager.tell(agent.id, recheckMessage(pr, pr.head), { source: 'reviews' });
      this.log(`review: ${agent.name}: author pushed ${pr.head.slice(0, 7)}, re-checking`);
    } catch {}
  }

  /**
   * Post the picked items as a pending review on GitHub, under your name: you finish and submit it
   * there. A line GitHub can't comment on goes in the body instead.
   */
  async post(ref, { ids = null } = {}) {
    const a = this.manager.mustGet(ref);
    if (!a.reviewing) throw err(400, `${a.name} isn't reviewing a pull request`);
    const got = readReview(a.id);
    if (!got) throw err(409, 'No review written yet');
    const draft = reviewDraft(got.review, ids);
    if (!draft.picked.length) throw err(400, 'Pick at least one blocker, question or nit to send');
    if (process.env.AGENTMGR_NO_GH) throw err(503, 'GitHub is off (AGENTMGR_NO_GH)');
    const { slug, number } = a.reviewing;
    // gh reads the payload from a file: comments with lines need real JSON, not -f fields.
    const file = path.join(briefDir(a.id), 'review-post.json');
    const send = async (payload) => {
      fs.writeFileSync(file, JSON.stringify(payload));
      try {
        const out = await run(ghBin(), ['api', '-X', 'POST', `repos/${slug}/pulls/${number}/reviews`, '--input', file], { timeout: 30_000 });
        return JSON.parse(out || '{}');
      } finally {
        fs.rmSync(file, { force: true });
      }
    };
    const base = { ...(got.review.headSha ? { commit_id: got.review.headSha } : {}), body: draft.body || ' ' };
    let res;
    let moved = 0;
    try {
      res = await send({ ...base, comments: draft.comments });
    } catch (e) {
      // 422: a line outside the diff. Put those comments in the body instead.
      if (!/422|Unprocessable|line/i.test(e.message) || !draft.comments.length) throw err(502, `GitHub refused the review: ${clip(e.message, 300)}`);
      moved = draft.comments.length;
      const extra = draft.comments.map((c) => `${c.body.replace(/\n\n/g, '\n')}\n(\`${c.path}:${c.line}\`)`);
      try {
        res = await send({ ...base, body: [draft.body, ...extra].filter(Boolean).join('\n\n') });
      } catch (e2) {
        throw err(502, `GitHub refused the review: ${clip(e2.message, 300)}`);
      }
    }
    const posted = { at: new Date().toISOString(), url: res.html_url ?? `${a.reviewing.url}/files`, ids: draft.picked, moved };
    this.manager.patch(a.id, { reviewing: { ...a.reviewing, posted } });
    return posted;
  }
}
