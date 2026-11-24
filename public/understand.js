// Understanding check: before you approve a large change, two or three questions about what it
// does (what happens on a failure, an empty input, what else depends on it). Answer in your head,
// then show the answer and say whether you knew it. The ones you did not know come with where to
// read. It is a check for you: nothing here grades you, and nothing is sent anywhere.

export function understandSummary(u) {
  const qs = u?.data?.questions ?? [];
  const said = Object.values(u?.knew ?? {}).filter((v) => typeof v === 'boolean');
  if (!qs.length) return '';
  if (said.length < qs.length) return `${said.length} of ${qs.length} answered`;
  const knew = said.filter(Boolean).length;
  return knew === qs.length ? `Knew all ${qs.length}` : `Knew ${knew} of ${qs.length}`;
}

export function initUnderstand({ $, esc, api, toast, openChanges, agentOf }) {
  const dlg = $('#understand-dialog');
  let id = null;
  const shown = new Set(); // question indexes whose answer is showing

  function render() {
    const a = id && agentOf(id);
    const u = a?.docs?.understanding;
    $('#understand-title').textContent = `Do you understand it? ${a ? a.name : ''}`;
    const body = $('#understand-body');
    if (!a) return;
    if (u?.pending) return void (body.innerHTML = '<p class="hint">Writing the questions from its changes…</p>');
    if (u?.error) return void (body.innerHTML = `<p class="error">${esc(u.error)}</p><p><button class="small" data-us="make">Try again</button></p>`);
    const qs = u?.data?.questions ?? [];
    if (!qs.length) return void (body.innerHTML = '<p class="hint">Writing the questions from its changes…</p>');
    const stale = u.at && a.brief?.updatedAt && Date.parse(a.brief.updatedAt) > Date.parse(u.at);
    body.innerHTML = `
      <p class="hint">Answer each in your head first. Then show the answer and say whether you knew it. Nothing here grades you; the ones you did not know point to where to read.</p>
      <ol class="us-list">${qs
        .map((x, i) => {
          const k = u.knew?.[i];
          return `<li class="us-item ${k === false ? 'us-miss' : k === true ? 'us-knew' : ''}">
            <div class="us-q">${esc(x.q)}</div>
            ${shown.has(i) || typeof k === 'boolean'
              ? `<div class="us-a"><b>Answer</b> ${esc(x.answer)}${x.why ? ` <span class="hint">${esc(x.why)}</span>` : ''}${x.file ? `<div class="hint">Read: <code>${esc(x.file)}</code>${x.head ? ` <code>${esc(x.head)}</code>` : ''}</div>` : ''}</div>
                 <div class="us-say">${typeof k === 'boolean' ? `<span class="tag ${k ? 'proof-ok' : 'proof-bad'}">${k ? 'You knew it' : 'You did not'}</span> <button class="link" data-us-knew="${i}" data-v="null">Undo</button>` : `<button class="small" data-us-knew="${i}" data-v="true">I knew it</button><button class="small" data-us-knew="${i}" data-v="false">I did not</button>`}</div>`
              : `<button class="small" data-us-show="${i}">Show the answer</button>`}
          </li>`;
        })
        .join('')}</ol>
      <p class="hint">${esc(understandSummary(u))}${stale ? ' · The agent has changed its work since these were written: make them again.' : ''}</p>`;
  }

  async function make() {
    try {
      await api('POST', `/agents/${id}/docs/understanding`);
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
    render();
  }

  dlg.addEventListener('click', async (e) => {
    if (e.target.closest('[data-us="close"]')) return dlg.close();
    if (e.target.closest('[data-us="make"]')) return make();
    if (e.target.closest('[data-us="changes"]')) return (dlg.close(), openChanges(id));
    const show = e.target.closest('[data-us-show]');
    if (show) {
      shown.add(Number(show.dataset.usShow));
      return render();
    }
    const knew = e.target.closest('[data-us-knew]');
    if (knew) {
      try {
        await api('POST', `/agents/${id}/understanding/knew`, { question: Number(knew.dataset.usKnew), knew: knew.dataset.v === 'null' ? null : knew.dataset.v === 'true' });
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
      }
      render();
    }
  });

  return {
    async open(agentId) {
      id = agentId;
      shown.clear();
      if (!dlg.open) dlg.showModal();
      const u = agentOf(id)?.docs?.understanding;
      render();
      if (!u?.data?.questions?.length) await make();
    },
    agentChanged(a) {
      if (dlg.open && a.id === id) render();
    },
  };
}
