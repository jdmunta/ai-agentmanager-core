// AI News: the frontier labs' latest releases in one list, newest first, each with a short summary
// and its links. The daemon reads the release notes (and searches the web for the top labs once a
// day) on its own; Refresh looks now. New since you last looked is marked, and counted on the button.

import { expandButton, expandable } from './expand.js';

const SAVED = 'agentmgr.newsLab';

export function initNews({ api, $, esc, ago, toast }) {
  const dialog = $('#news-dialog');
  const body = $('#news-body');
  let data = null;
  let lab = 'all';
  let query = '';
  let again = null;
  try {
    lab = localStorage.getItem(SAVED) || 'all';
  } catch {}

  async function load({ quiet = false } = {}) {
    try {
      data = await api('GET', '/news');
    } catch (e) {
      if (!quiet) toast?.(e.message, 5000);
    }
    badge();
    render();
  }

  function badge() {
    const n = data?.newCount ?? 0;
    const el = $('#news-count');
    if (!el) return;
    el.textContent = n ? String(n) : '';
    el.title = n ? `${n} new since you last looked` : '';
  }

  /** "Today", "Yesterday", "Monday, Nov 9" (with the year when it isn't this one). */
  function dayLabel(date) {
    const d = new Date(`${date}T12:00:00`);
    const today = new Date();
    const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
    // A release dated today somewhere ahead of this time zone is still today's news here.
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
  }

  function item(i) {
    const extra = i.links.filter((l) => l.url !== i.url).slice(0, 4);
    return `<li class="news-item${i.isNew ? ' new' : ''}">
      <div class="news-meta"><span class="tag news-lab" data-lab="${esc(i.lab)}">${esc(i.lab)}</span> <span class="hint">${esc(i.label)}</span>${i.isNew ? ' <span class="tag news-new">new</span>' : ''}</div>
      <a class="news-title" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      ${i.summary
        ? `<p class="news-summary">${esc(i.summary)}</p>`
        : `<p class="news-summary hint" title="The summary is written on the next refresh">${esc(i.lead ?? '')}</p>`}
      ${extra.length ? `<div class="news-links">${extra.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">${esc(l.text || new URL(l.url).host)} ↗</a>`).join('')}</div>` : ''}
    </li>`;
  }

  function source(s) {
    const what = s.error ? `⚠ ${s.error}` : s.at ? `${s.count} entries, read ${ago(s.at)}` : 'not read yet';
    const name = s.page ? `<a href="${esc(s.page)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label);
    return `<span class="news-source${s.error ? ' failed' : ''}" title="${esc(`${s.lab}: ${what}`)}">${name}${s.error ? ' ⚠' : ''}</span>`;
  }

  function draw() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const labs = [...new Set(data.items.map((i) => i.lab))].sort((x, y) => data.items.filter((i) => i.lab === y).length - data.items.filter((i) => i.lab === x).length || x.localeCompare(y));
    if (lab !== 'all' && lab !== 'new' && !labs.includes(lab)) lab = 'all';
    const q = query.trim().toLowerCase();
    const rows = data.items.filter((i) => (lab === 'all' || (lab === 'new' ? i.isNew : i.lab === lab)) && (!q || `${i.title} ${i.summary ?? i.lead ?? ''} ${i.lab} ${i.label} ${(i.tags ?? []).join(' ')}`.toLowerCase().includes(q)));
    const days = [];
    for (const i of rows) {
      if (days.at(-1)?.date !== i.date) days.push({ date: i.date, items: [] });
      days.at(-1).items.push(i);
    }
    const chip = (k, label, n) => `<button class="chip ${k === lab ? 'active' : ''}" role="tab" aria-selected="${k === lab}" data-news-lab="${esc(k)}">${esc(label)} <span class="count">${n}</span></button>`;
    const s = data.settings ?? {};
    body.innerHTML = `
      <div class="issues-head">
        <h2>AI News</h2>
        <div class="chips" role="tablist">${chip('all', 'All', data.items.length)}${data.newCount ? chip('new', 'New', data.newCount) : ''}${labs.map((l) => chip(l, l, data.items.filter((i) => i.lab === l).length)).join('')}</div>
        <span class="spacer"></span>
        <input type="search" class="small news-find" data-news-find placeholder="Find…" value="${esc(query)}" aria-label="Find in the news">
        <button class="small" data-news="refresh" ${data.refreshing || !data.enabled ? 'disabled' : ''} title="Read the release notes again now${s.summaries ? ' and summarize what is new' : ''}">${data.refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
        ${s.search ? `<button class="small" data-news="search" ${data.refreshing || !data.enabled ? 'disabled' : ''} title="Also search the web now for the top 10 AI labs' latest releases (otherwise once every ${s.searchHours} hours). One Claude Code call that may only search and read the web">🔎 Search top labs</button>` : ''}
        ${expandButton(dialog)}
        <button class="small" data-news="close" title="Close (Esc)">Close</button>
      </div>
      <p class="hint">The frontier labs' latest releases from the last ${esc(String(s.days ?? 30))} days, newest first${s.summaries ? ', each summarized by a model in a sentence or two' : ''}. Read from ${data.sources.map(source).join(', ')}${data.refreshedAt ? `; updated ${esc(ago(data.refreshedAt))}, again every ${esc(String(s.refreshHours))} hours` : ''}. Sources and timing: <code>"news"</code> in config.json.</p>
      ${!data.enabled
        ? '<p class="hint issues-empty">AI News is off. Turn it on with <code>"news": { "enabled": true }</code> in config.json.</p>'
        : days.length
          ? `<div class="issues-scroll news-list">${days.map((d) => `<h3 class="news-day">${esc(dayLabel(d.date))}</h3><ul class="news-items">${d.items.map(item).join('')}</ul>`).join('')}</div>`
          : `<p class="hint issues-empty">${data.refreshing ? 'Reading the release notes…' : data.items.length ? 'Nothing matches.' : 'No news yet. Refresh reads the release notes now.'}</p>`}`;
  }

  // Typing in Find keeps its focus and caret while the list redraws under it.
  function render() {
    const find = body.querySelector('[data-news-find]');
    const typing = find && document.activeElement === find;
    const at = typing ? find.selectionStart : null;
    draw();
    if (typing) {
      const f = body.querySelector('[data-news-find]');
      f?.focus();
      f?.setSelectionRange(at, at);
    }
  }

  async function refresh(search) {
    try {
      data = await api('POST', '/news/refresh', search ? { search: true } : {});
      toast?.(search ? 'Reading the release notes and searching the web: this can take a few minutes' : 'Reading the release notes', 3000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    render();
  }

  body.addEventListener('input', (e) => {
    if (e.target.dataset.newsFind === undefined) return;
    query = e.target.value;
    render();
  });

  body.addEventListener('click', (e) => {
    const l = e.target.closest('[data-news-lab]');
    if (l) {
      lab = l.dataset.newsLab;
      try {
        localStorage.setItem(SAVED, lab === 'new' ? 'all' : lab);
      } catch {}
      return render();
    }
    const b = e.target.closest('[data-news]')?.dataset.news;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return refresh(false);
    if (b === 'search') return refresh(true);
  });

  // Closing marks what you saw as seen: the "new" marks and the count clear. The first look starts them.
  dialog.addEventListener('close', () => {
    if (data && (data.newCount || !data.seenAt)) api('POST', '/news/seen', {}).then(() => load({ quiet: true }), () => {});
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
  }

  /** The daemon says the news changed: the count now, and the list while open. */
  function changed() {
    clearTimeout(again);
    again = setTimeout(() => load({ quiet: true }), dialog.open ? 300 : 1500);
  }

  expandable(dialog, render);
  load({ quiet: true });
  return { open, changed, isOpen: () => dialog.open };
}
