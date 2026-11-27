// Timeline on the page: an agent's work from its start to now, as dated milestones (asks closed,
// pull requests) in a thread; open one for what it changed. Copy gives it as Markdown.

const when = (s) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The agent's words as written: `code` as code, the rest as text.
const words = (esc, s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const PR = { opened: 'Pull request opened', merged: 'Pull request merged', closed: 'Pull request closed' };

export function initTimeline({ dialog, api, esc, toast, agentOf }) {
  let id = null;
  let view = null;
  let stamp = '';
  let again = null;
  const body = dialog.querySelector('#timeline-body');
  // What the timeline is drawn from; another load when it changes.
  const stampOf = (a) => [a.activeAt, a.brief?.updatedAt, Object.values(a.prs ?? {}).map((p) => `${p.url}:${p.state}`).join(), a.runtime?.busy].join('|');

  function node(n) {
    const head = (label, cls = '') => `<div class="tl-head"><time>${esc(n.open ? 'Now' : when(n.at))}</time><b class="${cls}">${esc(label)}</b></div>`;
    if (n.kind === 'start')
      return `<li class="tl-node tl-start">${head('Started')}<div class="tl-title">${esc(n.title)}</div>${n.branch ? `<div class="hint">Branch <code>${esc(n.branch)}</code>${n.base ? ` from ${esc(n.base)}` : ''}</div>` : ''}</li>`;
    if (n.kind === 'ask') {
      const sub = [
        n.reply ? `<li><span class="hint">It said:</span> ${words(esc, n.reply)}</li>` : '',
        n.files.length ? `<li><span class="hint">Changed ${plural(n.files.length, 'file')}:</span> ${n.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</li>` : '',
        ...n.commits.map((c) => `<li><code>${esc(c.sha)}</code> ${esc(c.subject)}</li>`),
      ].join('');
      const facts = [n.files.length ? plural(n.files.length, 'file') : '', n.commits.length ? plural(n.commits.length, 'commit') : ''].filter(Boolean).join(' · ');
      return `<li class="tl-node tl-ask ${n.open ? 'open' : ''}">${head(n.open ? 'Working on' : n.first ? 'The request done' : 'Ask done')}
        <details ${n.open ? 'open' : ''}><summary>${n.title ? `<span class="tl-title">${esc(n.title)}</span> ` : ''}<span class="hint">${facts || 'Details'}</span></summary>${sub ? `<ul class="tl-sub">${sub}</ul>` : ''}</details></li>`;
    }
    if (n.kind === 'talk')
      return `<li class="tl-node tl-talk">${head(`${plural(n.asks.length, 'ask')} with no changes`, 'muted')}<details><summary class="hint">${esc(n.asks[0].title)}${n.asks.length > 1 ? ` and ${n.asks.length - 1} more` : ''}</summary><ul class="tl-sub">${n.asks
        .map((a) => (n.asks.length > 1 ? `<li><span class="hint">${esc(when(a.at))}</span> ${esc(a.title)}${a.reply ? `<br><span class="hint">It said:</span> ${words(esc, a.reply)}` : ''}</li>` : a.reply ? `<li><span class="hint">It said:</span> ${words(esc, a.reply)}</li>` : ''))
        .join('')}</ul></details></li>`;
    if (n.kind === 'commits')
      return `<li class="tl-node tl-commits">${head(plural(n.commits.length, 'commit'))}<ul class="tl-sub">${n.commits.map((c) => `<li><code>${esc(c.sha)}</code> ${esc(c.subject)}</li>`).join('')}</ul></li>`;
    if (n.kind === 'pr') return `<li class="tl-node tl-pr ${n.event}">${head(PR[n.event])}<div class="tl-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div></li>`;
    if (n.kind === 'done') return `<li class="tl-node tl-done">${head('Finished')}${n.title ? `<div class="tl-title">${esc(n.title)}</div>` : ''}</li>`;
    return '';
  }

  function render() {
    if (!view) return;
    const c = view.counts;
    // Opened details stay open over a redraw.
    const opened = new Set([...body.querySelectorAll('.tl-node details[open]')].map((d) => d.closest('.tl-node').dataset.k));
    body.innerHTML = `
      <p class="hint">${plural(c.asks, 'ask')}, ${c.changes} with changes · ${plural(c.commits, 'commit')} · ${plural(c.prs, 'pull request')}${c.prs ? ` (${c.merged} merged)` : ''}. Each milestone is dated when it closed; open one for what it changed.${view.transcripts ? '' : ' Its engine keeps no transcript here, so only commits and pull requests show.'}</p>
      <ol class="tl">${view.nodes.map(node).join('')}</ol>`;
    body.querySelectorAll('.tl-node').forEach((li, i) => {
      li.dataset.k = String(i);
      const d = li.querySelector('details');
      if (d && opened.has(String(i))) d.open = true;
    });
  }

  async function load() {
    const a = agentOf(id);
    stamp = a ? stampOf(a) : '';
    try {
      view = await api('GET', `/agents/${id}/timeline`);
    } catch (e) {
      body.innerHTML = `<p class="hint">Error: ${esc(e.message)}</p>`;
      return;
    }
    if (dialog.open) render();
  }

  dialog.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-timeline]')?.dataset.timeline;
    if (act === 'close') return dialog.close();
    if (act === 'copy' && id) {
      try {
        const { markdown } = await api('GET', `/agents/${id}/timeline?format=md`);
        await navigator.clipboard.writeText(markdown);
        toast('Timeline copied as Markdown');
      } catch (err) {
        toast(`Error: ${err.message}`, 5000);
      }
    }
  });
  dialog.addEventListener('close', () => {
    clearTimeout(again);
    id = null;
    view = null;
  });

  return {
    open(agentId) {
      id = agentId;
      view = null;
      dialog.querySelector('#timeline-title').textContent = `Timeline: ${agentOf(agentId)?.name ?? ''}`;
      body.innerHTML = '<p class="hint">Loading…</p>';
      if (!dialog.open) dialog.showModal();
      return load();
    },
    /** The agent moved on while it is open: drawn again shortly. */
    agentChanged(a) {
      if (id !== a.id || !view || stampOf(a) === stamp) return;
      clearTimeout(again);
      again = setTimeout(() => id === a.id && load(), 1500);
    },
  };
}
