// Reviews: pull requests you review. Reviewer agents read someone else's change, ask the critical
// questions and find what blocks approval; you pick what to send and post it as a pending review
// under your name (or copy it). PRs where your review is requested and no reviewer has started
// come first, with a box to tick.

import { listenHtml, speakable } from './speak.js';

const VERDICT = { approve: ['Approve', 'ok'], approve_with_nits: ['Approve with nits', 'ok'], blocked: ['Blocked', 'bad'] };
const CHECKS = { passed: ['✓', 'Checks pass'], failed: ['✗', 'Checks failing'], running: ['●', 'Checks running'] };
const CATEGORY = { correctness: 'Correctness', security: 'Security', data: 'Data', breaking: 'Breaking change', tests: 'Tests', performance: 'Performance', design: 'Design', other: 'Other' };

/** The verdict, blockers and questions as parts to read aloud. */
export function reviewerSpeech(row) {
  const r = row?.review;
  if (!r) return [];
  const said = (s) => speakable(String(s ?? '')).replace(/\s+/g, ' ').trim();
  const open = r.blockers.filter((b) => b.status === 'open');
  const parts = [said(`Review of pull request ${row.pr.number}${row.pr.title ? `, ${row.pr.title}` : ''}. Verdict: ${VERDICT[r.verdict]?.[0] ?? 'none yet'}. ${r.why}`)];
  if (r.summary) parts.push(said(`What it does: ${r.summary}`));
  if (open.length) parts.push(said(`${open.length} blocker${open.length === 1 ? '' : 's'}.`), ...open.slice(0, 5).map((b, i) => said(`${i + 1}: ${b.title}. ${b.why}`)));
  const resolved = r.blockers.length - open.length;
  if (resolved) parts.push(`${resolved} earlier blocker${resolved === 1 ? ' is' : 's are'} resolved.`);
  if (r.questions.length) parts.push(said(`Questions for the author: ${r.questions.slice(0, 4).map((q) => q.question).join(' ')}`));
  if (row.stale) parts.push('The author pushed since this review; the reviewer is checking again.');
  return parts.filter(Boolean);
}

export function initReviews({ api, $, esc, ago, openAgent, toast }) {
  const dialog = $('#reviews-dialog');
  const body = $('#reviews-body');
  const ext = (label, url, title = '') => `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(label)} ↗</a>`;
  let rows = null;
  let loading = false;
  let loadedAt = 0;
  let again = null;
  let openId = null;
  // The open review's items picked to send, by agent id.
  const picks = new Map();
  // Requested PRs ticked to start a reviewer, by URL.
  const ticked = new Set();
  let busy = false;

  async function load({ quiet = false, fresh = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      rows = (await api('GET', `/reviews${fresh ? '?fresh=1' : ''}`)).rows;
      loadedAt = Date.now();
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    } finally {
      loading = false;
    }
    badge();
    render();
  }

  /** The button's count: requests with no reviewer, blocked reviews, and ones the author pushed to. */
  function badge() {
    const n = rows ? rows.filter((r) => !r.agent || r.stale || r.review?.verdict).filter((r) => !r.posted || r.stale).length : 0;
    const el = $('#reviews-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = n ? `${n} pull request${n === 1 ? '' : 's'} to look at` : '';
    }
  }

  const prLabel = (r) => `${r.pr.repo ? `${esc(r.pr.repo)}` : ''}#${esc(r.pr.number)}`;

  function verdictHtml(r) {
    if (!r.agent) return '<span class="verdict new">Requested</span>';
    const v = r.review?.verdict;
    if (!v) return `<span class="verdict wait">${r.agent.busy || r.status === 'reviewing' ? 'Reviewing…' : 'No review yet'}</span>`;
    const n = r.review.openBlockers;
    return `<span class="verdict ${VERDICT[v][1]}">${VERDICT[v][0]}${n ? `: ${n} blocker${n === 1 ? '' : 's'}` : ''}</span>`;
  }

  function defaults(r) {
    if (!picks.has(r.agent.id)) picks.set(r.agent.id, new Set([...r.review.blockers.filter((b) => b.status === 'open').map((b) => b.id), ...r.review.questions.map((q) => q.id)]));
    return picks.get(r.agent.id);
  }

  const where = (x) => (x.file ? `<code class="rv-where">${esc(x.file)}${x.line ? `:${esc(x.line)}` : ''}</code>` : '');
  const box = (id, picked, label) => `<input type="checkbox" data-rv-pick="${esc(id)}" ${picked.has(id) ? 'checked' : ''} aria-label="Send: ${esc(label)}" />`;

  function detail(r) {
    const rv = r.review;
    if (!rv) return `<p class="hint">The reviewer is reading the change. Its blockers and questions show here when it has written them.</p>`;
    const picked = defaults(r);
    const blockers = rv.blockers.map(
      (b) => `<li class="rv-item ${b.status}">
        ${b.status === 'open' ? box(b.id, picked, b.title) : '<span class="rv-done" title="Resolved">✓</span>'}
        <div><strong>${esc(b.title)}</strong> <span class="rv-cat">${esc(CATEGORY[b.category] ?? b.category)}</span> ${where(b)}${b.status === 'resolved' ? ' <span class="hint">resolved</span>' : ''}
          <p>${esc(b.why)}</p>${b.unblock ? `<p class="hint">To resolve: ${esc(b.unblock)}</p>` : ''}</div></li>`,
    );
    const questions = rv.questions.map((q) => `<li class="rv-item">${box(q.id, picked, q.question)}<div>${esc(q.question)} ${where(q)}${q.why ? `<p class="hint">${esc(q.why)}</p>` : ''}</div></li>`);
    const nits = rv.nits.map((n) => `<li class="rv-item">${box(n.id, picked, n.text)}<div>${esc(n.text)} ${where(n)}</div></li>`);
    const plain = (title, xs) => (xs.length ? `<h4>${title}</h4><ul class="rv-plain">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    const posted = r.posted ? `<p class="hint">Posted ${esc(ago(r.posted.at))} as a pending review: ${ext('finish it on GitHub', r.posted.url)}${r.posted.moved ? ` (${r.posted.moved} line comment(s) went in the body)` : ''}</p>` : '';
    return `
      <p class="rv-why"><strong>${esc(VERDICT[rv.verdict]?.[0] ?? 'No verdict yet')}.</strong> ${esc(rv.why)}</p>
      ${rv.summary ? `<p>${esc(rv.summary)}</p>` : ''}
      ${r.stale ? '<p class="rv-stale">The author pushed since this review. The reviewer has been told to check again.</p>' : ''}
      ${blockers.length ? `<h4>Blockers</h4><ul class="rv-list">${blockers.join('')}</ul>` : '<h4>Blockers</h4><p class="hint">None found.</p>'}
      ${questions.length ? `<h4>Questions for the author</h4><ul class="rv-list">${questions.join('')}</ul>` : ''}
      ${plain('Risks', rv.risks)}
      ${plain('Test gaps', rv.testGaps)}
      ${nits.length ? `<h4>Nits</h4><ul class="rv-list">${nits.join('')}</ul>` : ''}
      ${rv.tests ? `<h4>Tests</h4><p>${esc(rv.tests)}</p>` : ''}
      ${posted}
      <div class="rv-actions">
        <button class="primary small" data-rv="post" ${picked.size && !busy ? '' : 'disabled'} title="Create a pending review on GitHub, under your name, with the ticked items. Nothing is visible to the author until you submit it there.">Post ${picked.size} as pending review</button>
        <button class="small" data-rv="copy" title="Copy the ticked items as Markdown">Copy</button>
        ${listenHtml(`reviewer:${r.agent.id}`, { title: 'Read the verdict, blockers and questions aloud', label: 'Explain' })}
      </div>`;
  }

  function card(r) {
    const check = r.pr.checks?.state && CHECKS[r.pr.checks.state] ? ` <span class="checks ${esc(r.pr.checks.state)}" title="${CHECKS[r.pr.checks.state][1]}">${CHECKS[r.pr.checks.state][0]}</span>` : '';
    const state = r.pr.state && r.pr.state !== 'OPEN' ? ` <span class="hint">${esc(r.pr.state.toLowerCase())}</span>` : r.pr.isDraft ? ' <span class="hint">draft</span>' : '';
    if (!r.agent) {
      return `<article class="rv-card requested ${ticked.has(r.pr.url) ? 'ticked' : ''}">
        <header>
          <input type="checkbox" data-rv-start="${esc(r.pr.url)}" ${ticked.has(r.pr.url) ? 'checked' : ''} aria-label="Start a reviewer for ${esc(r.pr.title ?? r.pr.url)}" />
          <h3>${ext(`${r.pr.repo ?? ''}#${r.pr.number}`, r.pr.url)} ${esc(r.pr.title ?? '')}</h3>
          ${verdictHtml(r)}
        </header>
        <div class="design-meta"><span class="hint">${r.pr.author ? `by ${esc(r.pr.author)} · ` : ''}your review is requested · ${esc(ago(r.updatedAt))}</span></div>
      </article>`;
    }
    const isOpen = openId === r.agent.id;
    const dot = r.agent.busy ? '<span class="dot busy" title="Working"></span>' : r.agent.running ? '<span class="dot idle" title="Session open"></span>' : '';
    return `<article class="rv-card ${esc(r.review?.verdict ?? 'pending')} ${r.stale ? 'stale' : ''}">
        <header data-rv-toggle="${esc(r.agent.id)}" role="button" tabindex="0" aria-expanded="${isOpen}">
          <span class="rv-caret">${isOpen ? '▾' : '▸'}</span>
          <h3>${prLabel(r)} ${esc(r.pr.title ?? '')}${check}${state}</h3>
          ${r.stale ? '<span class="verdict wait" title="The author pushed since this review">New commits</span>' : ''}
          ${r.posted ? '<span class="hint">posted</span>' : ''}
          ${verdictHtml(r)}
        </header>
        <div class="design-meta">
          ${ext('Pull request', r.pr.url)}
          <button class="link" data-rv-open="${esc(r.agent.id)}" title="Open the reviewer's session: ask it about the change">${dot}${esc(r.agent.name)}</button>
          ${r.review ? `<span class="hint">${r.review.questions.length} question${r.review.questions.length === 1 ? '' : 's'} · ${esc(ago(r.updatedAt))}</span>` : ''}
        </div>
        ${isOpen ? `<div class="rv-detail">${detail(r)}</div>` : ''}
      </article>`;
  }

  function render() {
    if (!dialog.open) return;
    if (!rows) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const requested = rows.filter((r) => !r.agent);
    const mine = rows.filter((r) => r.agent);
    const focused = document.activeElement?.dataset?.rv === 'url' ? document.activeElement.value : null;
    body.innerHTML = `
      <div class="issues-head">
        <h2>Reviews</h2>
        <form class="rv-new" data-rv-form>
          <input type="url" data-rv="url" placeholder="Pull request link to review" aria-label="Pull request link" required />
          <button class="small primary" type="submit" title="Start a reviewer agent: it reads the change and finds what blocks approval; nothing is posted">Review</button>
        </form>
        <span class="spacer"></span>
        <button class="small" data-rv="refresh" title="Look again now, including GitHub">↻</button>
        <button class="small" data-rv="close" title="Close (Esc)">Close</button>
      </div>
      ${requested.length ? `<div class="issues-pickbar"><span>${requested.length} pull request${requested.length === 1 ? '' : 's'} where your review is requested.</span>
          <button class="small primary" data-rv="start" ${ticked.size && !busy ? '' : 'disabled'}>Review ${ticked.size || ''} with agents</button>
          <button class="small" data-rv="dismiss" ${ticked.size && !busy ? '' : 'disabled'} title="Take the ticked ones off this list">Dismiss</button></div>` : ''}
      ${rows.length ? `<div class="designs-list">${[...requested, ...mine].map(card).join('')}</div>` : '<p class="hint issues-empty">No reviews yet. Paste a pull request link above, or turn on "GitHub reviews" in Assistant to find the ones where your review is requested.</p>'}`;
    if (focused !== null) {
      const u = body.querySelector('[data-rv="url"]');
      u.value = focused;
      u.focus();
    }
  }

  const rowOf = (id) => rows?.find((r) => r.agent?.id === id) ?? null;

  async function copy(r) {
    const picked = picks.get(r.agent.id) ?? new Set();
    const rv = r.review;
    const lines = [`Review of ${r.pr.url}`, `${VERDICT[rv.verdict]?.[0] ?? ''}: ${rv.why}`];
    for (const b of rv.blockers.filter((x) => picked.has(x.id))) lines.push(`- **Blocker: ${b.title}**${b.file ? ` (\`${b.file}${b.line ? `:${b.line}` : ''}\`)` : ''}: ${b.why}${b.unblock ? ` To resolve: ${b.unblock}` : ''}`);
    for (const q of rv.questions.filter((x) => picked.has(x.id))) lines.push(`- **Question:** ${q.question}${q.file ? ` (\`${q.file}${q.line ? `:${q.line}` : ''}\`)` : ''}`);
    for (const n of rv.nits.filter((x) => picked.has(x.id))) lines.push(`- Nit: ${n.text}${n.file ? ` (\`${n.file}${n.line ? `:${n.line}` : ''}\`)` : ''}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast?.('Copied as Markdown');
    } catch (e) {
      toast?.(`Couldn't copy: ${e.message}`, 5000);
    }
  }

  body.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-rv-form]')) return;
    e.preventDefault();
    const url = body.querySelector('[data-rv="url"]').value.trim();
    try {
      const a = await api('POST', '/reviews', { url });
      toast?.(`Reviewer ${a.name} started`);
      openId = a.id;
      await load();
    } catch (err) {
      toast?.(err.message, 6000);
    }
  });

  body.addEventListener('change', (e) => {
    const s = e.target.closest('[data-rv-start]');
    if (s) {
      if (s.checked) ticked.add(s.dataset.rvStart);
      else ticked.delete(s.dataset.rvStart);
      return render();
    }
    const p = e.target.closest('[data-rv-pick]');
    if (p && openId) {
      const set = picks.get(openId) ?? new Set();
      if (p.checked) set.add(p.dataset.rvPick);
      else set.delete(p.dataset.rvPick);
      picks.set(openId, set);
      render();
    }
  });

  const toggle = (id) => {
    openId = openId === id ? null : id;
    render();
  };
  body.addEventListener('keydown', (e) => {
    const t = e.target.closest('[data-rv-toggle]');
    if (t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle(t.dataset.rvToggle);
    }
  });

  body.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-rv-open]');
    if (o) {
      dialog.close();
      return openAgent(o.dataset.rvOpen);
    }
    // Links, boxes and Listen do their own thing.
    if (e.target.closest('a, input, [data-say]')) return;
    const t = e.target.closest('[data-rv-toggle]');
    if (t) return toggle(t.dataset.rvToggle);
    const b = e.target.closest('[data-rv]')?.dataset.rv;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load({ fresh: true });
    if (b === 'start' || b === 'dismiss') {
      busy = true;
      render();
      const urls = [...ticked];
      try {
        if (b === 'dismiss') {
          await api('POST', '/reviews/dismiss', { urls });
        } else {
          const failed = [];
          for (const url of urls) {
            try {
              await api('POST', '/reviews', { url });
            } catch (err) {
              failed.push(err.message);
            }
          }
          toast?.(failed.length ? `Started ${urls.length - failed.length}; ${failed.join('; ')}` : `Started ${urls.length} reviewer${urls.length === 1 ? '' : 's'}`, failed.length ? 7000 : 3000);
        }
        ticked.clear();
      } finally {
        busy = false;
        await load();
      }
      return;
    }
    const r = rowOf(openId);
    if (!r?.review) return;
    if (b === 'copy') return copy(r);
    if (b === 'post') {
      busy = true;
      render();
      try {
        const res = await api('POST', `/reviews/${r.agent.id}/post`, { ids: [...(picks.get(r.agent.id) ?? [])] });
        toast?.(`Pending review created with ${res.ids.length} item${res.ids.length === 1 ? '' : 's'}: submit it on GitHub`, 6000);
        window.open(res.url, '_blank', 'noopener');
      } catch (err) {
        toast?.(err.message, 7000);
      } finally {
        busy = false;
        await load();
      }
    }
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
  }

  /** An agent changed: look again shortly while open, and now and then for the count. */
  function changed() {
    if (!dialog.open && again) return;
    clearTimeout(again);
    const wait = dialog.open ? 1500 : Math.max(5000, 60_000 - (Date.now() - loadedAt));
    again = setTimeout(() => {
      again = null;
      load({ quiet: true });
    }, wait);
  }

  load({ quiet: true });
  return { open, changed, isOpen: () => dialog.open, speech: (id) => reviewerSpeech(rowOf(id)), show: (id) => ((openId = id), dialog.open ? render() : open()) };
}
