// Work record (menu → Work record…): what the agents got done, kept in a spreadsheet for reviews.
// Totals for a period, the weeks, the events, a summary to copy, and the CSV files to download.

const LABEL = { pr_opened: 'PR opened', pr_merged: 'PR merged', pr_closed: 'PR closed', bug_fixed: 'Bug fixed', issue_filed: 'Issue filed', agent_finished: 'Agent finished' };

export function initWorklog({ api, esc, toast, $ }) {
  const dlg = $('#worklog-dialog');
  const days = () => $('#worklog-days').value;
  const pct = (r) => (r == null || r === '' ? '—' : `${Math.round(r * 100)}%`);
  const hours = (h) => (h == null || h === '' ? '—' : Number(h) < 48 ? `${Number(h).toFixed(1)} h` : `${(Number(h) / 24).toFixed(1)} days`);

  function fill(v) {
    const t = v.totals;
    const kpi = (label, value, hint = '') => `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    $('#worklog-body').innerHTML = `<div class="kpis">
        ${kpi('PRs merged', t.prs_merged, `${t.prs_opened} opened${t.prs_closed ? `, ${t.prs_closed} closed` : ''}`)}
        ${kpi('merge rate', pct(t.merge_rate), `median ${hours(t.median_hours_to_merge)} to merge`)}
        ${kpi('bugs fixed', t.bugs_fixed, `${t.issues_filed} issue${t.issues_filed === 1 ? '' : 's'} filed`)}
        ${kpi('agents finished', t.agents_finished)}
      </div>
      ${v.weeks.length ? `<details class="stats-table" open><summary>By week</summary><table class="spend-table">
        <tr><th>Week of</th><th>Merged</th><th>Opened</th><th>Bugs fixed</th><th>Filed</th><th>Finished</th><th>Cost</th></tr>
        ${v.weeks.map((w) => `<tr><td>${esc(w.week_start)}${w.current ? ' <span class="hint">so far</span>' : ''}</td><td>${w.prs_merged}</td><td>${w.prs_opened}</td><td>${w.bugs_fixed}</td><td>${w.issues_filed}</td><td>${w.agents_finished}</td><td>${w.cost_usd ? `$${Number(w.cost_usd).toFixed(2)}` : '—'}</td></tr>`).join('')}
      </table></details>` : ''}
      ${v.events.length ? `<details class="stats-table" open><summary>What happened (${v.events.length})</summary><table class="spend-table worklog-events">
        ${v.events.slice(0, 200).map((e) => `<tr><td class="hint">${esc(e.date.slice(0, 10))}</td><td><span class="tag">${LABEL[e.event] ?? esc(e.event)}</span></td><td>${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}<div class="hint">${esc(e.project || '')}${e.agent ? ` · <a href="#${esc(e.agent_id)}">${esc(e.agent)}</a>` : ''}</div></td></tr>`).join('')}
      </table></details>` : '<p class="hint">Nothing recorded in this period yet. Pull requests your agents open and merge, bugs they fix, issues they file and agents that finish show up here as they happen.</p>'}`;
    $('#worklog-files').textContent = `Appended as it happens to ${v.files.events} (one row per event) and ${v.files.weekly} (one row per week, once it's over).`;
  }

  async function refresh() {
    try {
      fill(await api('GET', `/worklog?days=${days()}`));
    } catch (err) {
      $('#worklog-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  async function download(name) {
    const res = await fetch(`/api/worklog/${name}`, { headers: { 'x-agentmgr': '1' } });
    if (!res.ok) return toast((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`, 4000);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  $('#worklog-btn').onclick = async () => {
    dlg.showModal();
    await refresh();
  };
  $('#worklog-days').onchange = () => refresh();
  $('#worklog-close').onclick = () => dlg.close();
  $('#worklog-csv').onclick = () => download('worklog.csv');
  $('#worklog-weekly').onclick = () => download('worklog-weekly.csv');
  $('#worklog-copy').onclick = async () => {
    try {
      const { markdown } = await api('GET', `/worklog/summary?days=${days()}`);
      await navigator.clipboard.writeText(markdown);
      toast('Summary copied (Markdown)');
    } catch (err) {
      toast(`Couldn't copy: ${err.message}`, 4000);
    }
  };
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('a[href^="#"]')) dlg.close();
  });
}
