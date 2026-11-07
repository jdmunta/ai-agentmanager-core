// Designs: every agent's design doc in one list, the ones waiting for your review first: its name
// and summary, where it's published, the specs it builds on, and the agent and its issue.

import { expandButton, expandable } from './expand.js';

const SAVED = 'agentmgr.designsFilter';
const FILTERS = [
  ['you', 'Waiting for you'],
  ['agent', 'Agents on it'],
  ['done', 'Done'],
  ['all', 'All'],
];

export function initDesigns({ api, $, esc, ago, openAgent, openDoc, toast }) {
  const dialog = $('#designs-dialog');
  const body = $('#designs-body');
  let rows = null;
  let loading = false;
  let loadedAt = 0;
  let again = null;
  let query = '';
  let filter = 'you';
  try {
    filter = localStorage.getItem(SAVED) || 'you';
  } catch {}

  async function load({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      rows = (await api('GET', '/designs')).rows;
      loadedAt = Date.now();
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    } finally {
      loading = false;
    }
    badge();
    render();
  }

  /** The button's count: design docs waiting for your review. */
  function badge() {
    const n = rows ? rows.filter((r) => r.group === 'you').length : 0;
    const el = $('#designs-count');
    if (el) {
      el.textContent = n ? String(n) : '';
      el.title = n ? `${n} design docs waiting for your review` : '';
    }
  }

  const ext = (label, url, title = '') => `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(label)} ↗</a>`;

  function card(r) {
    const links = [
      r.written ? `<button class="link" data-design-read="${esc(r.agent.id)}" title="Read DESIGN.md here">Read</button>` : '<span class="hint">not written yet</span>',
      r.page?.url ? ext('Design page', r.page.url, 'The Artifact the agent published') : r.page?.note ? `<span class="hint" title="${esc(r.page.note)}">page not published</span>` : '',
      r.google ? ext('Google Doc', r.google) : '',
      ...r.specs.map((s) => ext(s.label, s.url, s.title ?? '')),
    ].filter(Boolean);
    const dot = r.agent.busy ? '<span class="dot busy" title="Working"></span>' : r.agent.running ? '<span class="dot idle" title="Session open"></span>' : '';
    return `<article class="design-card stage-${esc(r.stage)}">
        <header>
          <h3>${esc(r.title)}</h3>
          <span class="hint">${esc(ago(r.updatedAt))}</span>
        </header>
        <div class="design-meta">
          <button class="link" data-design-open="${esc(r.agent.id)}" title="Open the agent's session">${dot}${esc(r.agent.name)}</button>
          ${r.agent.project ? `<span class="hint">${esc(r.agent.project)}</span>` : ''}
          ${r.issue ? (r.issue.url ? ext(r.issue.key, r.issue.url) : `<span>${esc(r.issue.key)}</span>`) : ''}
          <span class="design-note">${esc(r.note)}</span>
        </div>
        ${r.summary ? `<p class="design-summary">${esc(r.summary)}</p>` : ''}
        <div class="design-links">${links.join('<span class="sep">·</span>')}</div>
      </article>`;
  }

  function render() {
    if (!dialog.open) return;
    if (!rows) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const count = (g) => (g === 'all' ? rows.length : rows.filter((r) => r.group === g).length);
    const q = query.trim().toLowerCase();
    const shown = rows
      .filter((r) => filter === 'all' || r.group === filter)
      .filter((r) => !q || [r.title, r.summary, r.agent.name, r.agent.project, r.issue?.key].some((s) => String(s ?? '').toLowerCase().includes(q)));
    const empty = !rows.length
      ? 'No design docs yet. Agents write one once their plan is settled (Design doc, on by default when you create an agent).'
      : q
        ? 'No design doc matches.'
        : filter === 'you'
          ? 'No design doc is waiting for your review.'
          : 'None here.';
    const focused = document.activeElement?.dataset?.designs === 'search';
    body.innerHTML = `
      <div class="issues-head">
        <h2>Designs</h2>
        <div class="chips" role="tablist">${FILTERS.map(([k, label]) => `<button class="chip ${k === filter ? 'active' : ''}" role="tab" aria-selected="${k === filter}" data-designs-filter="${k}">${label} <span class="count">${count(k)}</span></button>`).join('')}</div>
        <input type="search" class="designs-search" data-designs="search" placeholder="Search" value="${esc(query)}" aria-label="Search design docs" />
        <span class="spacer"></span>
        <button class="small" data-designs="copy" title="Copy this list as Markdown, to paste into Slack, Jira or a doc" ${shown.length ? '' : 'disabled'}>Copy</button>
        <button class="small" data-designs="refresh" title="Look again now">↻</button>
        ${expandButton(dialog)}
        <button class="small" data-designs="close" title="Close (Esc)">Close</button>
      </div>
      ${shown.length ? `<div class="designs-list">${shown.map(card).join('')}</div>` : `<p class="hint issues-empty">${esc(empty)}</p>`}`;
    if (focused) {
      const s = body.querySelector('[data-designs="search"]');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  }

  body.addEventListener('input', (e) => {
    if (e.target.dataset.designs !== 'search') return;
    query = e.target.value;
    render();
  });

  body.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-design-open]');
    if (o) {
      dialog.close();
      return openAgent(o.dataset.designOpen);
    }
    const rd = e.target.closest('[data-design-read]');
    if (rd) {
      dialog.close();
      return openDoc(rd.dataset.designRead);
    }
    const f = e.target.closest('[data-designs-filter]');
    if (f) {
      filter = f.dataset.designsFilter;
      try {
        localStorage.setItem(SAVED, filter);
      } catch {}
      return render();
    }
    const b = e.target.closest('[data-designs]')?.dataset.designs;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load();
    if (b === 'copy') {
      try {
        const { markdown } = await api('GET', `/designs?group=${encodeURIComponent(filter)}&q=${encodeURIComponent(query)}&format=markdown`);
        await navigator.clipboard.writeText(markdown);
        toast?.('Copied as Markdown');
      } catch (err) {
        toast?.(`Couldn't copy: ${err.message}`, 5000);
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
    const wait = dialog.open ? 1500 : Math.max(5000, 30_000 - (Date.now() - loadedAt));
    again = setTimeout(() => {
      again = null;
      load({ quiet: true });
    }, wait);
  }

  load({ quiet: true });
  expandable(dialog, render);
  return { open, changed, isOpen: () => dialog.open };
}
