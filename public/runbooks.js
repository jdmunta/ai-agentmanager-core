// Runbooks for the support team (the Runbooks tab of Plan): written from a release ticket, the
// tickets of an epic, or the code changes of a time frame. Read one, edit it, ask for a revision,
// copy or download it as Markdown, or print it.

const STATUS = { writing: 'Writing…', ready: 'Ready', failed: 'Failed' };

export function initRunbooks({ api, esc, ago, toast, projects, md, redraw }) {
  let list = null;
  let open = null; // the runbook being read: { ...meta, markdown }
  let editing = false;
  let source = 'ticket';
  let again = null;

  async function load() {
    try {
      list = await api('GET', '/runbooks');
      if (open) {
        const meta = list.items.find((r) => r.id === open.id);
        // Written again, or finished, since it was opened: read it again (not over your edits).
        if (!meta) open = null;
        else if (!editing && (meta.updatedAt !== open.updatedAt || meta.status !== open.status)) open = await api('GET', `/runbooks/${open.id}`);
      }
    } catch (e) {
      toast?.(e.message, 5000);
    }
    redraw();
    // One being written reports its steps, then arrives.
    clearTimeout(again);
    if (list?.items.some((r) => r.status === 'writing')) again = setTimeout(load, 2500);
  }

  const sourceWords = (r) => (r.source.kind === 'code' ? `${r.source.project}: code changes ${r.source.until ? `${r.source.since} to ${r.source.until}` : `since ${r.source.since}`}` : `${list.sources[r.source.kind]} ${r.source.key}`);
  const factWords = (f) => (f ? [f.tickets && `${f.tickets} ticket${f.tickets === 1 ? '' : 's'}`, f.commits && `${f.commits} commit${f.commits === 1 ? '' : 's'}`, f.files && `${f.files} file${f.files === 1 ? '' : 's'}`].filter(Boolean).join(', ') : '');

  function formHtml() {
    const ps = projects();
    const tab = (k, label) => `<button type="button" class="chip ${k === source ? 'active' : ''}" data-rb-source="${k}" aria-pressed="${k === source}">${label}</button>`;
    return `<form class="plan-form rb-form" data-rb-form="new">
      <div class="chips">${tab('ticket', 'A release ticket')}${tab('epic', 'An epic')}${tab('code', 'Code changes')}</div>
      ${source === 'code'
        ? `<select name="project" aria-label="Project" required><option value="">Project…</option>${ps.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select>
           <label class="plan-date">since <input type="date" name="since" required /></label>
           <label class="plan-date">until <input type="date" name="until" title="Empty: until now" /></label>`
        : `<input name="key" placeholder="${source === 'epic' ? "The epic's key or link (PROJ-100)" : "The release ticket's key or link (REL-42)"}" required />`}
      <input name="note" placeholder="Anything to cover in particular (optional)" />
      <button class="small primary">Write the runbook</button>
    </form>
    <p class="hint">${source === 'ticket' ? "Read from Jira: the ticket, what it links to, its sub-tasks, and every ticket in its fix versions." : source === 'epic' ? 'Read from Jira: every ticket of the epic.' : "Read from the project's repository: the commits of the time frame, the diffs of the most changed files, and the Jira tickets the commits name."} One model call writes it, on your own plan. It states only what those facts support and lists the rest under <i>To confirm with engineering</i>: have an engineer check it before support relies on it.</p>`;
  }

  function listHtml() {
    if (!list) return '<p class="hint">Loading…</p>';
    const rows = list.items
      .map((r) => `<tr>
        <td><button class="link rb-title" data-rb-open="${esc(r.id)}" ${r.status === 'failed' && !r.facts ? 'disabled' : ''}>${esc(r.title)}</button><div class="hint">${esc(sourceWords(r))}${r.facts ? ` · ${esc(factWords(r.facts))}` : ''}${r.edited ? ' · edited by you' : ''}</div>${r.error ? `<div class="issues-problem">${esc(r.error)}</div>` : ''}</td>
        <td class="nowrap"><span class="tag rb-status ${esc(r.status)}">${esc(r.status === 'writing' && r.step ? `${r.step}…` : STATUS[r.status])}</span></td>
        <td class="hint nowrap">${esc(ago(r.updatedAt))}</td>
        <td class="nowrap">${r.status === 'failed' ? `<button class="small" data-rb-again="${esc(r.id)}">Try again</button> ` : ''}<button class="link" data-rb-remove="${esc(r.id)}" title="Delete" ${r.status === 'writing' ? 'disabled' : ''}>✕</button></td>
      </tr>`)
      .join('');
    return `${formHtml()}${rows ? `<table class="issues rb-list"><tbody>${rows}</tbody></table>` : '<p class="hint issues-empty">No runbooks yet.</p>'}`;
  }

  function openHtml() {
    const r = open;
    const busy = r.status === 'writing';
    return `<div class="plan-bar rb-bar">
        <button class="small" data-rb="back">← Runbooks</button>
        <span class="hint">${esc(sourceWords(r))}${r.facts ? ` · written from ${esc(factWords(r.facts))}` : ''} · ${esc(ago(r.updatedAt))}${r.edited ? ' · edited by you' : ''}</span>
        <span class="spacer"></span>
        ${editing
          ? '<button class="small primary" data-rb="save">Save</button><button class="small" data-rb="cancel">Cancel</button>'
          : `<button class="small" data-rb="edit" ${busy ? 'disabled' : ''}>Edit</button><button class="small" data-rb="copy" title="Copy as Markdown, to paste into your knowledge base">Copy</button><a class="button small" href="/api/runbooks/${esc(r.id)}?format=markdown" download>Download .md</a><button class="small" data-rb="print">Print</button>`}
      </div>
      ${busy ? `<p class="hint">${esc(r.step ?? 'Writing')}…</p>` : ''}
      ${r.error ? `<p class="issues-problem">${esc(r.error)}</p>` : ''}
      ${editing
        ? `<textarea class="rb-edit" data-rb-text aria-label="The runbook, as Markdown">${esc(r.markdown)}</textarea>`
        : `<article class="doc-body rb-doc" id="rb-doc">${md(r.markdown)}</article>
           <form class="plan-form rb-form" data-rb-form="revise"><input name="note" placeholder="What to change or add (the on-call rotation, a missing workaround…)" ${busy ? 'disabled' : ''} /><button class="small" ${busy ? 'disabled' : ''} title="Written again from the tickets and code as they are now, keeping what still holds and your edits">Revise</button></form>`}`;
  }

  const run = async (fn, done) => {
    try {
      await fn();
      if (done) toast?.(done, 3000);
    } catch (e) {
      toast?.(e.message, 6000);
    }
    document.activeElement?.blur?.();
    await load();
  };

  /** A click in the tab; true when it was one of ours. */
  function click(e) {
    const s = e.target.closest('[data-rb-source]');
    if (s) return (source = s.dataset.rbSource), redraw(true), true;
    const o = e.target.closest('[data-rb-open]');
    if (o) {
      run(async () => {
        open = await api('GET', `/runbooks/${o.dataset.rbOpen}`);
        editing = false;
      });
      return true;
    }
    const rm = e.target.closest('[data-rb-remove]');
    if (rm) return run(() => api('DELETE', `/runbooks/${rm.dataset.rbRemove}`), 'Deleted'), true;
    const ag = e.target.closest('[data-rb-again]');
    if (ag) return run(() => api('POST', `/runbooks/${ag.dataset.rbAgain}/regenerate`, {}), 'Writing it again'), true;
    const b = e.target.closest('[data-rb]')?.dataset.rb;
    if (!b) return false;
    if (b === 'back') (open = null), (editing = false), redraw(true);
    else if (b === 'edit') (editing = true), redraw(true);
    else if (b === 'cancel') (editing = false), redraw(true);
    else if (b === 'save') {
      const text = document.querySelector('[data-rb-text]').value;
      run(async () => {
        open = await api('PUT', `/runbooks/${open.id}`, { markdown: text });
        editing = false;
      }, 'Saved');
    } else if (b === 'copy') navigator.clipboard?.writeText(open.markdown).then(() => toast?.('The runbook is on the clipboard, as Markdown', 3000), () => toast?.("Couldn't copy it", 3000));
    else if (b === 'print') {
      const w = window.open('', '_blank');
      if (!w) return toast?.('The browser blocked the print window', 4000), true;
      w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(open.title)}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left;vertical-align:top}code{background:#f2f2f2;padding:0 3px}</style>${document.querySelector('#rb-doc').innerHTML}`);
      w.document.close();
      w.focus();
      w.print();
    }
    return true;
  }

  /** A form sent in the tab; true when it was one of ours. */
  function submit(e) {
    const kind = e.target.dataset.rbForm;
    if (!kind) return false;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (kind === 'new') run(() => api('POST', '/runbooks', { source, ...f }), 'Gathering the facts; it is written in the background');
    else run(() => api('POST', `/runbooks/${open.id}/regenerate`, { note: f.note }), 'Revising it');
    return true;
  }

  return { html: () => (open ? openHtml() : listHtml()), click, submit, load, changed: () => load(), editing: () => editing };
}
