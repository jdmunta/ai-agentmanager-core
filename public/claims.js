// Claims check, in the document dialog: each statement of fact in an agent's brief and in what was
// written about its work, with the source that backs it (src/claims.js). What is contradicted or
// not backed comes first; the rest is folded away.

const LABEL = { contradicted: 'Contradicted', not_backed: 'Not backed', said: 'Only the agent says so', backed: 'Backed', opinion: 'Opinion or plan' };
const HINT = {
  contradicted: 'A source says otherwise',
  not_backed: 'No source says so, or what the checker quoted is not in the source',
  said: 'In the brief, spec, plan or conversation only: nothing measured shows it',
  backed: 'A source says so, and the quote was found in it',
  opinion: 'A judgment, estimate or plan: the sources cannot settle it',
};
const ORDER = ['contradicted', 'not_backed', 'said', 'backed', 'opinion'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 contradicted · 2 not backed · 5 backed" as chips. */
export function countsHtml(counts, gone, esc) {
  const chip = (v, n) => (n ? `<span class="cl-chip cl-${v}" title="${esc(HINT[v])}">${n} ${esc(LABEL[v].toLowerCase())}</span>` : '');
  return `${ORDER.slice(0, 4).map((v) => chip(v, counts[v])).join('')}${gone ? `<span class="cl-chip cl-not_backed" title="Files, links, pull requests or numbers in the text that are in none of the sources, in statements the checker passed over">${plural(gone, 'particular')} nowhere in the sources</span>` : ''}` || '<span class="cl-chip">no statements of fact</span>';
}

function textHtml(t, esc) {
  if (t.error) return `<section class="ha-card cl-text"><h3>${esc(t.label)}</h3><p class="error">Not checked: ${esc(t.error)}</p></section>`;
  const item = (c) => `<li class="cl-claim cl-${c.verdict}">
      <div class="cl-said">${esc(c.text)}</div>
      ${c.quote ? `<div class="hint cl-quote"><b>${esc(c.source.name)}:</b> “${esc(c.quote)}”</div>` : ''}
      ${c.note ? `<div class="hint">${esc(c.note)}</div>` : ''}
    </li>`;
  const group = (v) => {
    const list = t.claims.filter((c) => c.verdict === v);
    if (!list.length) return '';
    const open = v === 'contradicted' || v === 'not_backed' || v === 'said';
    return `<details class="cl-group" ${open ? 'open' : ''}><summary><span class="cl-chip cl-${v}">${list.length}</span> ${esc(LABEL[v])} <span class="hint">${esc(HINT[v])}</span></summary><ul class="cl-list">${list.map(item).join('')}</ul></details>`;
  };
  const gone = t.missing.length
    ? `<details class="cl-group" open><summary><span class="cl-chip cl-not_backed">${t.missing.length}</span> Nowhere in the sources <span class="hint">in statements the checker passed over</span></summary><ul class="cl-list">${t.missing.map((s) => `<li class="cl-claim cl-not_backed"><span class="hint">${esc(s.kind)}</span> <code>${esc(s.value)}</code></li>`).join('')}</ul></details>`
    : '';
  return `<section class="ha-card cl-text" data-claims-text="${esc(t.key)}"><h3>${esc(t.label)}</h3><p class="cl-counts">${countsHtml(t.counts, t.missing.length, esc)}</p>${ORDER.map(group).join('')}${gone}</section>`;
}

export function claimsHtml(d, esc) {
  const c = d.data;
  return `<div class="cl">
    <p class="cl-counts cl-total">${countsHtml(c.counts, c.missing, esc)}</p>
    <p class="hint">Each statement of fact, traced to a source by ${esc(d.writer ?? 'another model')}. The app checked that every statement is in the text, every quote in its source, and that the files, links, pull requests and numbers exist in the sources. Whether a quote really shows the statement is the model's reading: read the ones that matter.</p>
    ${c.texts.map((t) => textHtml(t, esc)).join('')}
    <p class="hint">Sources: ${c.sources.map((s) => `${esc(s.name)}${s.own ? " (the agent's own account)" : ''}`).join(' · ')}</p>
  </div>`;
}

/** The check of one text of an agent, if it was made of the text as it is now. */
export function checkOf(a, key, at) {
  const t = a?.docs?.claims?.data?.texts.find((x) => x.key === key && !x.error);
  return t && t.at === at ? t : null;
}

/** One line over a document about its last check, with the way to the whole of it. */
export function claimsNote(a, key, at, esc) {
  const d = a?.docs?.claims;
  if (d?.pending) return '<p class="hint cl-note">Checking its statements against the work…</p>';
  const t = checkOf(a, key, at);
  if (!t) return `<p class="hint cl-note">Its statements are not checked against the work yet. <button type="button" class="link" data-doc="claims" data-run>Check claims</button></p>`;
  const doubt = t.counts.contradicted + t.counts.not_backed + t.missing.length;
  return `<p class="cl-note ${doubt ? 'cl-doubt' : ''}">${doubt ? '<b>Read before sending:</b> ' : 'Checked against the work: '}${countsHtml(t.counts, t.missing.length, esc)} <button type="button" class="link" data-doc="claims">Claims</button></p>`;
}
