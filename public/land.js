// Land tab: every agent's open pull request, grouped by what it needs to get merged, with
// Review, Update, Ask to fix and Merge. Ones whose Eval is 100% on their latest commit come first.
// Settings for sending failures back to agents, and for merging on the Eval, at the bottom.
// What it changes shows a pull request at the level of features and the links between components
// (its head against where it branched), and posts that on it when you press Post.

import { listenHtml } from './speak.js';
import { evalChip } from './eval.js';
import { sureToMerge } from './sure.js';
import { featureChangeWords } from './logical.js';
const SHORT = { ready: 'ready', fix: 'to fix', behind: 'behind', waiting: 'waiting', draft: 'draft' };
const GROUPS = [
  ['ready', 'Ready to merge'],
  ['fix', 'Needs fixes'],
  ['behind', 'Behind its base'],
  ['waiting', 'Waiting for checks or review'],
  ['draft', 'Drafts'],
];

/** Checks, review and merge state of an open pull request, as small tags. */
export function prChips(pr, esc) {
  const c = pr.checks;
  const out = [];
  if (c?.state === 'failed') out.push(`<span class="tag fail" title="${esc(c.failed.join(', '))}">✗ ${c.failed.length} failing</span>`);
  else if (c?.state === 'running') out.push(`<span class="tag">◔ ${c.running} running</span>`);
  else if (c?.state === 'passed') out.push('<span class="tag open">✓ checks</span>');
  if (pr.review === 'APPROVED') out.push('<span class="tag open">Approved</span>');
  else if (pr.review === 'CHANGES_REQUESTED') out.push('<span class="tag fail">Changes requested</span>');
  else if (pr.review === 'REVIEW_REQUIRED') out.push('<span class="tag">Review required</span>');
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') out.push('<span class="tag fail">Conflicts</span>');
  else if (pr.mergeState === 'BEHIND') out.push('<span class="tag">Behind</span>');
  return out.join(' ');
}

export function initLand({ api, esc, toast, agents, $, scoreBadge = () => '', select, openReview, isOpen }) {
  const view = $('#land-view');
  let settings = null;
  // What a pull request changes, by its URL: { open, loading, data, error, posting, posted }.
  const impacts = new Map();

  const rows = () => {
    const out = [];
    for (const a of agents.values()) {
      for (const pr of a.prs ?? []) {
        if (pr.state !== 'OPEN' || pr.source === 'mentioned') continue;
        out.push({ a, pr, land: pr.land ?? 'waiting', sure: sureToMerge(a, pr, { needApproval: settings?.sureNeedsApproval ?? true }) });
      }
    }
    return out.sort((x, y) => Number(y.sure.sure) - Number(x.sure.sure) || (x.a.priority ?? 2) - (y.a.priority ?? 2));
  };

  // Review comments sent to the agent so far, and when last.
  function commentsHint(c) {
    if (!c?.count) return '';
    return ` <span class="hint" title="Last sent ${esc(new Date(c.lastAt).toLocaleString())}">${c.count} review comment${c.count === 1 ? '' : 's'} sent</span>`;
  }

  // Failed checks being run again before the agent hears of them, and checks that passed on a re-run.
  function rerunHint(a, pr) {
    const recs = Object.entries(a.landing?.reruns ?? {}).filter(([k]) => k.startsWith(`${pr.url}@`)).map(([, v]) => v);
    const now = a.landing?.reruns?.[`${pr.url}@${pr.head}`];
    const flaky = [...new Set(recs.filter((r) => r.result === 'passed').flatMap((r) => r.flaky ?? []))];
    let out = '';
    if (now && !now.result && !now.error) out += ` <span class="hint" title="The failed GitHub Actions jobs run once more before the agent is told">Re-running ${esc((now.checks ?? []).join(', ') || 'failed checks')}</span>`;
    if (flaky.length) out += ` <span class="hint" title="Failed, then passed when run again on the same commit">Flaky: ${esc(flaky.join(', '))}</span>`;
    return out;
  }

  // Why a ready pull request isn't sure, or why merging it on its own didn't work.
  function sureHint(a, pr, land, sure) {
    const tried = a.landing?.sure?.[`${pr.url}@${pr.head}`];
    if (tried?.error) return ` <span class="hint fail" title="${esc(tried.error)}">Couldn't merge on its own</span>`;
    if (land === 'ready' && !sure.sure && a.eval?.items) return ` <span class="hint" title="Why it isn't merged on its Eval">${esc(sure.why)}</span>`;
    return '';
  }

  /** A pull request's features and links changed, under its row. */
  function impactHtml(pr) {
    const x = impacts.get(pr.url);
    if (!x?.open) return '';
    if (x.loading) return '<div class="land-impact"><p class="hint">Reading its code at its head and where it branched…</p></div>';
    if (x.error) return `<div class="land-impact"><p class="hint fail">${esc(x.error)}</p></div>`;
    const { impact: I, base, files } = x.data;
    const tag = (how) => `<span class="design-tag ${how}">${how}</span> `;
    const name = (id) => I.names?.[id] ?? id;
    const at = (s) => `<code>${esc(s.file)}${s.line ? `:${s.line}` : ''}</code>`;
    const feature = (f) => {
      const inner = [
        ...f.routes.added.map((r) => `<li>${tag('new')}route <code>${esc(r)}</code></li>`),
        ...f.routes.gone.map((r) => `<li>${tag('gone')}route <code>${esc(r)}</code></li>`),
        ...f.callers.map((c) => `<li>${tag(c.how)}called from <b>${esc(c.name)}</b> ${at(c)}</li>`),
        ...f.steps.map((st) => `<li>${tag(st.how)}<b>${esc(st.name)}</b> ${at(st)}</li>`),
        f.more ? `<li class="hint">and ${f.more} more</li>` : '',
      ].join('');
      return `<li>${f.how === 'changed' ? '' : tag(f.how)}<details data-land-feature="${esc(f.key)}" ${x.expanded?.has(f.key) ? 'open' : ''}><summary><b>${esc(f.name)}</b> <span class="hint">${esc(featureChangeWords(f) || 'its flow changed')}</span></summary><ul class="logical-routes">${inner}</ul></details></li>`;
    };
    const L = I.links;
    const routes = (r) => [r.added.length && `now also ${r.added.join(', ')}`, r.gone.length && `no longer ${r.gone.join(', ')}`].filter(Boolean).join('; ');
    const links = [
      ...L.added.map((e) => `<li>${tag('new')}${esc(name(e.from))} → ${esc(name(e.to))} <span class="hint">${esc(e.found)}</span></li>`),
      ...L.gone.map((e) => `<li>${tag('gone')}${esc(name(e.from))} → ${esc(name(e.to))}</li>`),
      ...L.changed.map((e) => `<li>${tag('changed')}${esc(name(e.from))} → ${esc(name(e.to))} <span class="hint">${esc(routes(e.routes))}</span></li>`),
    ];
    return `<div class="land-impact">
      <p class="hint">${files} file${files === 1 ? '' : 's'} changed, against where it branched from <code>${esc(base.ref)}</code> (${esc(base.sha.slice(0, 7))})${x.data.components === 'folders' ? '. Components are the top folders until Architecture → Logical → Find components with AI names them' : ''}.</p>
      ${I.features.length ? `<div><b>Features</b> <span class="hint">${I.featureCount}</span><ul class="logical-links">${I.features.map(feature).join('')}</ul>${I.featureCount > I.features.length ? `<span class="hint">and ${I.featureCount - I.features.length} more</span>` : ''}</div>` : '<p class="hint">No feature\'s flow changed.</p>'}
      ${links.length ? `<div><b>Links between components</b><ul class="logical-links">${links.join('')}</ul></div>` : '<p class="hint">No link between components came, went or changed its routes.</p>'}
      <div class="bl-actions">${x.posted ? '<span class="hint">Posted on the pull request</span>' : `<button class="small" data-land="impact-post" ${x.posting ? 'disabled' : ''} title="Add this as a comment on the pull request on GitHub, as you">${x.posting ? 'Posting…' : 'Post on the pull request'}</button>`}</div>
    </div>`;
  }

  async function loadImpact(id, url) {
    const x = impacts.get(url);
    try {
      x.data = await api('GET', `/agents/${id}/pr-impact?url=${encodeURIComponent(url)}`);
      x.error = null;
    } catch (err) {
      x.error = err.message;
    }
    x.loading = false;
    render();
  }

  function rowHtml({ a, pr, land, sure }) {
    const canFix = land === 'fix' || land === 'behind';
    return `<li class="agent land-row" data-agent="${a.id}" data-url="${esc(pr.url)}">
      <div class="line1"><span class="prio p${a.priority ?? 2}">P${a.priority ?? 2}</span>
        <a class="name" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.title ?? pr.url)}">#${esc(pr.number ?? '')} ${esc(pr.title ?? pr.url)}</a></div>
      <div class="line2"><button class="link" data-land="goto">${esc(a.name)}</button>${a.runtime?.busy ? ' <span class="hint">working</span>' : ''}${commentsHint(a.landing?.comments?.[pr.url])}${sureHint(a, pr, land, sure)}${rerunHint(a, pr)}</div>
      <div class="land-chips">${scoreBadge(a.docs?.scorecard, esc)} ${evalChip(a.eval, esc)} ${sure.sure ? `<span class="tag open" title="${esc(sure.why)}">Sure to merge</span>` : ''} ${prChips(pr, esc)}</div>
      <div class="bl-actions">
        <button class="small" data-land="review" title="Its diff, line comments for the agent, commit and push">Review</button>
        <button class="small ${impacts.get(pr.url)?.open ? 'active' : ''}" data-land="impact" title="The features and links between components it changes: its head against where it branched">What it changes</button>
        ${listenHtml(`prvoice:${a.id}`, { title: 'Explain the review aloud: the PR, its checks, the AI review, the riskiest changes and what is left', label: 'Explain' })}
        ${land === 'behind' || pr.mergeable === 'CONFLICTING' ? '<button class="small" data-land="update" title="Merge the base branch in here (when the agent is idle and its work is committed) and push; otherwise, or on conflicts, ask the agent">Update</button>' : ''}
        ${canFix ? '<button class="small" data-land="fix" title="Send the failures, requested changes or conflicts to the agent">Ask to fix</button>' : ''}
        ${land === 'ready' ? '<button class="small primary" data-land="merge">Merge</button>' : ''}
        ${land === 'waiting' || land === 'behind' ? '<button class="small" data-land="auto" title="GitHub merges it once checks and reviews allow">Auto-merge</button>' : ''}
      </div>
      ${impactHtml(pr)}
    </li>`;
  }

  function render() {
    const list = rows();
    const need = list.filter((r) => r.land === 'ready' || r.land === 'fix').length;
    $('#land-count').textContent = list.length ? String(list.length) : '';
    $('#land-count').className = `badge ${list.some((r) => r.land === 'ready') ? 'ready' : ''}`;
    $('#land-count').title = need ? `${need} ready or needing fixes` : '';
    if (!isOpen()) return;
    const s = settings;
    view.innerHTML = `
      <div class="counts">${GROUPS.map(([k, label]) => {
        const n = list.filter((r) => r.land === k).length;
        return n ? `<span class="${k === 'fix' ? 'fail' : ''}">${n} ${SHORT[k]}</span>` : '';
      }).join('')}<span class="spacer"></span><button class="link" data-land="refresh" title="Ask GitHub again for every open pull request">↻ Refresh</button></div>
      ${list.length
        ? `<ul class="agent-list">${GROUPS.map(([k, label]) => {
            const g = list.filter((r) => r.land === k);
            return g.length ? `<li class="project open"><div class="project-head bl-head"><span class="pname">${label}</span><span class="pcount">${g.length}</span></div><ul>${g.map(rowHtml).join('')}</ul></li>` : '';
          }).join('')}</ul>`
        : '<p class="hint land-empty">No open pull requests from agents. Open one from <b>Review changes</b> on an agent, or let the agent open it.</p>'}
      ${s ? `<details class="land-settings"><summary>When checks fail or reviewers comment</summary>
        <label class="check"><input type="checkbox" data-set="fixChecks" ${s.fixChecks ? 'checked' : ''}> Send failing checks to the agent</label>
        <label class="check"><input type="checkbox" data-set="rerunFailed" ${s.rerunFailed ? 'checked' : ''}> First run failed GitHub Actions jobs once more on the same commit: one that passes then is marked flaky and not sent</label>
        <label class="check"><input type="checkbox" data-set="fixReviews" ${s.fixReviews ? 'checked' : ''}> Send requested changes to the agent</label>
        <label class="check"><input type="checkbox" data-set="fixComments" ${s.fixComments ? 'checked' : ''}> Send new review comments to the agent while the pull request is open (from the repo's members and review bots)</label>
        <label>At most <input type="number" min="0" max="20" data-set="maxFixes" value="${s.maxFixes}"> times per pull request</label>
        <label>Merge with <select data-set="mergeMethod">${['squash', 'merge', 'rebase'].map((m) => `<option ${m === s.mergeMethod ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" data-set="deleteBranch" ${s.deleteBranch ? 'checked' : ''}> Delete the branch on GitHub after merging</label>
      </details>
      <details class="land-settings"><summary>Merge on the Eval</summary>
        <label class="check"><input type="checkbox" data-set="mergeWhenSure" ${s.mergeWhenSure ? 'checked' : ''}> Merge a pull request on its own when its Eval is 100%, the app's own test run passed on the commit the pull request is at, and GitHub has it ready</label>
        <label class="check"><input type="checkbox" data-set="sureNeedsApproval" ${s.sureNeedsApproval ? 'checked' : ''}> Only once a reviewer has approved it</label>
        <p class="hint">Each commit is tried once, and your policies and branch protection still apply. When this is off, these pull requests are only listed first, marked <b>Sure to merge</b>.</p>
      </details>` : ''}`;
  }

  async function load() {
    try {
      settings = (await api('GET', '/landing')).settings;
    } catch {}
    render();
  }

  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-land]');
    if (!b) return;
    const row = b.closest('[data-agent]');
    const id = row?.dataset.agent;
    const url = row?.dataset.url;
    const run = async (fn, ok) => {
      b.disabled = true;
      try {
        const r = await fn();
        const msg = typeof ok === 'function' ? ok(r) : ok;
        if (msg) toast(msg, 4000);
      } catch (err) {
        toast(`Error: ${err.message}`, 6000);
      } finally {
        b.disabled = false;
      }
    };
    switch (b.dataset.land) {
      case 'goto':
        return select(id);
      case 'review':
        return openReview(id);
      case 'impact': {
        const x = impacts.get(url);
        const head = rows().find((r) => r.pr.url === url)?.pr.head;
        if (x?.open) return (x.open = false), render();
        // Read again when its head moved.
        if (x && x.data?.pr.head === head && !x.error) return (x.open = true), render();
        impacts.set(url, { open: true, loading: true });
        render();
        return loadImpact(id, url);
      }
      case 'impact-post': {
        const x = impacts.get(url);
        if (!x?.data || !confirm('Post what it changes as a comment on the pull request, as you?')) return;
        x.posting = true;
        render();
        try {
          await api('POST', `/agents/${id}/pr-impact/post`, { url });
          x.posted = true;
          toast('Posted on the pull request', 4000);
        } catch (err) {
          toast(`Error: ${err.message}`, 6000);
        }
        x.posting = false;
        return render();
      }
      case 'refresh':
        return run(async () => {
          const ids = [...new Set(rows().map((r) => r.a.id))];
          await Promise.all(ids.map((x) => api('POST', `/agents/${x}/refresh`).catch(() => null)));
        }, 'Asked GitHub again');
      case 'update':
        return run(() => api('POST', `/agents/${id}/land/update`, {}), (r) =>
          r.upToDate ? `Already up to date with ${r.target}` : r.merged ? `Merged ${r.merged} commit${r.merged === 1 ? '' : 's'} from ${r.target}${r.pushed ? ' and pushed' : ''}` : `Asked the agent to update (${r.why})`);
      case 'fix':
        return run(() => api('POST', `/agents/${id}/land/fix`, { url }), 'Sent to the agent');
      case 'merge':
        if (!confirm(`Merge this pull request with ${settings?.mergeMethod ?? 'squash'}?`)) return;
        return run(() => api('POST', `/agents/${id}/land/merge`, { url }), 'Merged');
      case 'auto':
        return run(() => api('POST', `/agents/${id}/land/merge`, { url, auto: true }), 'Auto-merge is on: GitHub merges it once it may');
    }
  });

  // A feature opened stays open when the list is drawn again.
  view.addEventListener(
    'toggle',
    (e) => {
      const d = e.target.closest?.('[data-land-feature]');
      const x = d && impacts.get(d.closest('[data-url]')?.dataset.url);
      if (!x) return;
      x.expanded ??= new Set();
      if (d.open) x.expanded.add(d.dataset.landFeature);
      else x.expanded.delete(d.dataset.landFeature);
    },
    true,
  );

  view.addEventListener('change', async (e) => {
    const k = e.target.dataset.set;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    try {
      settings = (await api('PUT', '/landing', { [k]: v })).settings;
      toast('Saved');
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  });

  return { render, load };
}
