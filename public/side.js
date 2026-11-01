// The split view: the terminal (Claude, a shell or a browser tab) stays on the left, and the right
// pane shows the same agent's Code, its Docs (Diagrams by default) or its Changes explained one by
// one. On, the tab and the document are remembered in this browser.
import { parseDiff } from '/review.js';
import { cardHtml, explainButton, listenParts as walkParts, walkthroughOf } from '/walkthrough.js';

const DOCS = [
  ['diagrams', 'Diagrams'],
  ['design', 'Design'],
  ['flow', 'Flow'],
  ['analysis', 'Analysis'],
  ['proposal', 'Proposal'],
  ['explain', 'Explain'],
];
const pref = {
  get: (k, d) => {
    try {
      return localStorage.getItem(`agentmgr.side.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`agentmgr.side.${k}`, v);
    } catch {}
  },
};

export function initSide({ api, esc, toast, $, agents, codeUi, docHtml, renderDiagrams, listenHtml, mainKind, setMain, refit }) {
  const pane = $('#side-pane');
  const body = $('#side-body');
  const code = $('#code');
  const codeHome = $('#term-main');
  const st = { on: pref.get('on', '0') === '1', tab: pref.get('tab', 'docs'), doc: pref.get('doc', 'diagrams'), agentId: null, changes: null, sig: '', loading: false };

  const docOf = (a, kind) => (kind === 'explain' ? a?.explanation : a?.docs?.[kind]);

  function show() {
    const on = st.on && Boolean(st.agentId);
    pane.hidden = !on;
    $('#split-pane').hidden = !on;
    $('#term-split-btn').classList.toggle('on', on);
    for (const t of pane.querySelectorAll('[data-side]')) t.classList.toggle('active', t.dataset.side === st.tab);
    // Code lives in one place at a time: here when this tab shows it, else back in the main panel.
    const want = on && st.tab === 'code' ? body : codeHome;
    if (code.parentElement !== want) want === body ? body.replaceChildren(code) : codeHome.insertBefore(code, $('#browser'));
    pane.classList.toggle('with-code', on && st.tab === 'code');
    if (!on) return refit();
    if (st.tab === 'code') codeUi.open(st.agentId);
    else if (st.tab === 'docs') renderDocs(true);
    else renderChanges(true);
    refit();
  }

  // ------------------------------------------------------------ Docs
  function renderDocs(force) {
    const a = agents.get(st.agentId);
    const d = docOf(a, st.doc);
    const sig = `docs|${st.agentId}|${st.doc}|${d?.at}|${d?.pending}|${d?.error}`;
    if (!force && sig === st.sig) return;
    st.sig = sig;
    const label = DOCS.find(([k]) => k === st.doc)?.[1] ?? st.doc;
    const picker = `<select data-side-doc>${DOCS.map(([k, l]) => `<option value="${k}" ${k === st.doc ? 'selected' : ''}>${l}${docOf(a, k)?.markdown ? ' ✓' : ''}</option>`).join('')}</select>`;
    const stale = d?.markdown && a?.brief?.updatedAt && d.briefUpdatedAt !== a.brief.updatedAt;
    const action = d?.pending
      ? `<span class="hint">Writing…</span>`
      : `<button type="button" class="small ${d?.markdown ? 'ghost' : 'primary'}" data-side-write>${d?.markdown ? 'Again' : st.doc === 'diagrams' ? 'Draw' : 'Write'}</button>`;
    let content;
    if (d?.pending && !d?.markdown) content = `<p class="hint">Writing the ${esc(label.toLowerCase())} from the agent's work so far…</p>`;
    else if (d?.error && !d?.markdown) content = `<p class="error">Couldn't write it: ${esc(d.error)}</p>`;
    else if (d?.markdown) content = `<div class="md ${st.doc === 'diagrams' ? 'diagrams-view' : ''}">${docHtml(d.markdown)}</div>`;
    else content = `<p class="hint">No ${esc(label.toLowerCase())} for this agent yet.</p>`;
    const listen = d?.markdown && st.doc !== 'diagrams' ? listenHtml(`doc:${st.agentId}:${st.doc}`, { title: 'Read it aloud' }) : '';
    body.innerHTML = `<div class="side-tools">${picker}<span class="spacer"></span>${stale ? '<span class="hint">brief changed since</span>' : ''}${listen}${action}</div><div class="side-scroll">${content}</div>`;
    renderDiagrams(body);
  }

  // ------------------------------------------------------------ Changes
  async function loadChanges() {
    st.loading = true;
    try {
      const data = await api('GET', `/agents/${st.agentId}/changes`);
      st.changes = { id: st.agentId, diffHash: data.diffHash, files: parseDiff(data.diff) };
    } catch (err) {
      st.changes = { id: st.agentId, error: err.message };
    }
    st.loading = false;
    renderChanges(true);
  }

  function hunkHtml(file, head) {
    const h = st.changes?.files?.find((f) => f.path === file)?.hunks.find((x) => x.head === head);
    if (!h) return '<p class="hint">This hunk has changed since; Explain again for the latest.</p>';
    const lines = h.lines.slice(0, 40).map((l) => `<div class="sd-${l.t}">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}${esc(l.text)}</div>`);
    if (h.lines.length > 40) lines.push(`<div class="hint">… ${h.lines.length - 40} more lines (Review changes shows all)</div>`);
    return `<div class="sd-hunk"><div class="sd-head">${esc(head)}</div>${lines.join('')}</div>`;
  }

  function renderChanges(force) {
    if (!st.changes || st.changes.id !== st.agentId) {
      body.innerHTML = '<p class="hint side-pad">Loading the changes…</p>';
      if (!st.loading) loadChanges();
      return;
    }
    const a = agents.get(st.agentId);
    const w = walkthroughOf(a, st.changes.diffHash);
    const sig = `changes|${st.agentId}|${a?.docs?.walkthrough?.at}|${w.pending}|${w.error}|${st.changes.diffHash}`;
    if (!force && sig === st.sig) return;
    st.sig = sig;
    const tools = `<div class="side-tools">${explainButton(w, 'data-side-explain')}${w.doc ? listenHtml(`sidewalk:${st.agentId}`, { title: 'Hear the changes one by one' }) : ''}<span class="spacer"></span><button type="button" class="small ghost" data-side-reload title="Load the changes again">⟳</button></div>`;
    let content;
    if (st.changes.error) content = `<p class="error">${esc(st.changes.error)}</p>`;
    else if (!st.changes.files.length) content = '<p class="hint">No changes yet.</p>';
    else if (!w.doc) content = `${w.error && !w.pending ? `<p class="error">Couldn't explain them: ${esc(w.error)}</p>` : ''}<p class="hint">${st.changes.files.length} file${st.changes.files.length === 1 ? '' : 's'} changed. <b>Explain changes</b> goes through them one by one: what, why, the risk and what to check.</p>`;
    else {
      const list = w.doc.data.changes;
      content = `<p class="hint">${esc(w.doc.data.summary)}${w.stale ? ' <b>The changes moved since this was written.</b>' : ''}</p>${list
        .map((c, i) => `<section class="sd-step" id="sd-step-${i}"><div class="sd-file"><code>${esc(c.file)}</code></div>${cardHtml(c, i, list.length, esc)}${hunkHtml(c.file, c.head)}</section>`)
        .join('')}`;
    }
    body.innerHTML = `${tools}<div class="side-scroll">${content}</div>`;
  }

  // ------------------------------------------------------------ events
  pane.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-side]');
    if (tab) return setTab(tab.dataset.side);
    if (e.target.closest('#side-close')) return toggle(false);
    if (e.target.closest('[data-side-reload]')) return loadChanges();
    try {
      if (e.target.closest('[data-side-explain]')) {
        agents.set(st.agentId, await api('POST', `/agents/${st.agentId}/docs/walkthrough?background=1`));
        return renderChanges(true);
      }
      if (e.target.closest('[data-side-write]')) {
        const route = st.doc === 'explain' ? `/agents/${st.agentId}/explain?background=1` : `/agents/${st.agentId}/docs/${st.doc}?background=1`;
        agents.set(st.agentId, await api('POST', route));
        return renderDocs(true);
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  });
  pane.addEventListener('change', (e) => {
    if (!e.target.matches('[data-side-doc]')) return;
    st.doc = e.target.value;
    pref.set('doc', st.doc);
    renderDocs(true);
  });

  function setTab(tab) {
    st.tab = tab;
    pref.set('tab', tab);
    // Code can't be on both sides: the main panel goes back to the agent's session.
    if (tab === 'code' && mainKind() === 'code') setMain('claude');
    show();
  }

  function toggle(on = !st.on) {
    st.on = on;
    pref.set('on', on ? '1' : '0');
    if (on && st.tab === 'code' && mainKind() === 'code') st.tab = 'docs';
    show();
  }

  $('#term-split-btn').onclick = () => toggle();

  return {
    /** The terminal now shows this agent (or none): follow it. */
    follow(id) {
      if (id === st.agentId) return;
      st.agentId = id ?? null;
      st.changes = null;
      st.sig = '';
      show();
    },
    /** The main panel is about to show Code: move this pane off it. */
    mainShowsCode() {
      if (st.on && st.tab === 'code') {
        st.tab = 'docs';
        show();
      }
    },
    showing: (tab) => st.on && Boolean(st.agentId) && st.tab === tab,
    /** What Listen reads in Changes: each change, scrolled to and marked as it is read. */
    listenParts() {
      const w = walkthroughOf(agents.get(st.agentId), st.changes?.diffHash);
      if (!w.doc) return [];
      return walkParts(w.doc.data, (i) => () => {
        body.querySelectorAll('.sd-step.current').forEach((el) => el.classList.remove('current'));
        const el = body.querySelector(`#sd-step-${i}`);
        el?.classList.add('current');
        el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    },
    agentChanged(a) {
      if (!st.on || a.id !== st.agentId) return;
      if (st.tab === 'docs') renderDocs(false);
      else if (st.tab === 'changes') renderChanges(false);
    },
  };
}
