// Value: what the delivered work is worth, by day, week, month and quarter: the engineering time it
// saved, other savings, potential revenue and strategic weight, against the AI cost and your own
// time. Each item's figures are AI estimates you can correct; reports go out on a schedule.

const PERIODS = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['quarter', 'Quarter'],
];
const CATEGORIES = ['cost savings', 'revenue', 'risk reduction', 'quality', 'customer experience', 'strategic', 'maintenance'];
const SAVED = 'agentmgr.valuePeriod';

export function initValue({ api, $, esc, toast, openAgent }) {
  const dialog = $('#value-dialog');
  const body = $('#value-body');
  let data = null;
  let period = 'week';
  let selected = null; // a period key; null is the current one
  let editing = null; // an agent id
  let again = null;
  try {
    period = localStorage.getItem(SAVED) || 'week';
  } catch {}

  const money = (n) => (n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: data?.settings.currency ?? 'USD', maximumFractionDigits: 0 }).format(n));
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);

  async function load() {
    try {
      data = await api('GET', `/value?period=${period}`);
    } catch (e) {
      toast?.(e.message, 5000);
    }
    render();
  }

  function card(label, value, sub, prevValue, cur) {
    const d = prevValue != null && cur != null ? pct(cur, prevValue) : null;
    return `<div class="value-card"><div class="hint">${esc(label)}</div><div class="value-big">${value}</div>${sub ? `<div class="hint">${sub}</div>` : ''}${d != null && Number.isFinite(d) ? `<div class="value-delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}% vs before</div>` : ''}</div>`;
  }

  function bars(periods) {
    const max = Math.max(1, ...periods.map((p) => p.totals.valueUsd + p.totals.revenueUsd));
    return `<div class="value-bars" role="list">${[...periods]
      .reverse()
      .map((p) => {
        const v = (p.totals.valueUsd / max) * 100;
        const r = (p.totals.revenueUsd / max) * 100;
        const on = (selected ?? periods[0].key) === p.key;
        return `<button class="value-bar ${on ? 'on' : ''}" role="listitem" data-value-pick="${esc(p.key)}" title="${esc(`${p.label}: ${money(p.totals.valueUsd)} value, ${money(p.totals.revenueUsd)} potential revenue, ${p.totals.items} items`)}">
            <span class="stack"><span class="rev" style="height:${r}%"></span><span class="val" style="height:${v}%"></span></span>
            <span class="lbl">${esc(shortLabel(p))}</span>
          </button>`;
      })
      .join('')}</div>`;
  }

  const shortLabel = (p) => {
    const d = new Date(p.start);
    if (period === 'day') return d.toLocaleDateString(undefined, { weekday: 'narrow', day: 'numeric' });
    if (period === 'week') return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    if (period === 'month') return d.toLocaleDateString(undefined, { month: 'short' });
    return p.label.split(' ')[0];
  };

  function itemRow(it) {
    const v = it.value;
    const mine = (k) => (v.yours.includes(k) ? ' class="mine" title="Set by you"' : it.est ? ` title="${esc(it.est.why?.[{ humanHours: 'hours', savingsUsd: 'savings', revenueUsd: 'revenue', strategic: 'strategic' }[k]] ?? '')}"` : '');
    const status = it.excluded ? 'not counted' : it.est ? (v.yours.length ? 'AI + you' : `AI${it.est.confidence != null ? ` · ${Math.round(it.est.confidence * 100)}%` : ''}`) : it.estError ? 'no estimate' : data.estimating === it.agentId ? 'estimating…' : 'waiting for estimate';
    const title = it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title);
    const row = `<tr class="${it.excluded ? 'excluded' : ''}">
        <td class="hint nowrap">${esc(new Date(it.deliveredAt).toLocaleDateString())}</td>
        <td>${title}${v.summary ? `<div class="hint">${esc(v.summary)}</div>` : ''}${it.project ? `<div class="hint">${esc(it.project)}</div>` : ''}</td>
        <td>${esc(v.category ?? '—')}</td>
        <td${mine('humanHours')}>${v.humanHours ?? '—'}</td>
        <td${mine('humanHours')}>${money(v.valueUsd)}${v.savingsUsd ? `<div class="hint"${mine('savingsUsd')}>incl. ${money(v.savingsUsd)} savings</div>` : ''}</td>
        <td${mine('revenueUsd')}>${money(v.revenueUsd)}</td>
        <td${mine('strategic')}>${v.strategic != null ? `${v.strategic}/5` : '—'}</td>
        <td class="nowrap">${v.yourHours}h<div class="hint">AI ${money(v.aiCostUsd)}</div></td>
        <td class="nowrap"><span class="hint">${esc(status)}</span><div><button class="link" data-value-edit="${esc(it.agentId)}">Edit</button></div></td>
      </tr>`;
    if (editing !== it.agentId) return row;
    const e = it.edits ?? {};
    const est = it.est ?? {};
    const field = (k, label, step, max) => `<label>${label}<input type="number" min="0" ${max ? `max="${max}"` : ''} step="${step}" name="${k}" value="${esc(e[k] ?? '')}" placeholder="${esc(est[k] ?? (k === 'yourHours' ? v.yourHours : ''))}" /></label>`;
    return `${row}<tr class="value-edit"><td colspan="9"><form data-value-form="${esc(it.agentId)}">
        <div class="row value-fields">
          ${field('humanHours', 'Engineering hours saved', '0.5')}
          ${field('savingsUsd', 'Other savings', '100')}
          ${field('revenueUsd', 'Potential revenue', '100')}
          ${field('strategic', 'Strategic (0–5)', '1', 5)}
          ${field('yourHours', 'Your hours', '0.25')}
          <label>Category<select name="category"><option value="">${esc(est.category ? `AI: ${est.category}` : '—')}</option>${CATEGORIES.map((c) => `<option ${e.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        </div>
        <label>For management <input name="summary" value="${esc(e.summary ?? '')}" placeholder="${esc(est.summary ?? 'One sentence: what it gives the business')}" /></label>
        ${it.est ? `<p class="hint">AI's reasons: ${['hours', 'savings', 'revenue', 'strategic'].map((k) => (it.est.why?.[k] ? `<b>${k}</b> ${esc(it.est.why[k])}` : '')).filter(Boolean).join(' · ')}</p>` : it.estError ? `<p class="hint">No estimate: ${esc(it.estError)}</p>` : ''}
        <p class="hint">Empty fields use the AI's figure (shown faint). Yours are marked and win.</p>
        <div class="actions">
          <button type="button" class="small" data-value-act="estimate" ${it.gone ? 'disabled title="The agent is gone"' : ''}>${it.est ? 'Estimate again' : 'Estimate now'}</button>
          <button type="button" class="small" data-value-act="${it.excluded ? 'include' : 'exclude'}">${it.excluded ? 'Count it' : "Don't count it"}</button>
          <button type="button" class="small" data-value-act="open">Open agent</button>
          <span class="spacer"></span>
          <button type="button" class="small" data-value-act="cancel">Cancel</button>
          <button class="small primary">Save</button>
        </div>
      </form></td></tr>`;
  }

  function settingsHtml() {
    const s = data.settings;
    const r = s.report;
    return `<details class="value-settings"><summary>Settings and reports</summary><form data-value-settings>
        <div class="row three">
          <label>Engineering hour <span class="hint">loaded cost, ${esc(s.currency)}</span><input type="number" min="0" step="5" name="hourlyRate" value="${s.hourlyRate}" /></label>
          <label>Your time per item <span class="hint">minutes, unless set on it</span><input type="number" min="0" step="5" name="yourMinutes" value="${s.yourMinutes}" /></label>
          <label>Currency<input name="currency" maxlength="3" value="${esc(s.currency)}" /></label>
        </div>
        <label class="check"><input type="checkbox" name="ai" ${s.ai ? 'checked' : ''} /> Estimate each delivered item with AI (one short model call each, at most <input type="number" class="inline" min="0" name="maxPerDay" value="${s.maxPerDay}" /> a day)</label>
        <label>Notes for the estimates <span class="hint">e.g. "B2B SaaS, ~2,000 customers; checkout work affects revenue; support costs $40/ticket"</span><textarea name="notes" rows="2">${esc(s.notes)}</textarea></label>
        <fieldset><legend>Reports</legend>
          <div class="value-report-kinds">
            <label class="check"><input type="checkbox" name="daily" ${r.daily ? 'checked' : ''} /> Daily</label>
            <label class="check"><input type="checkbox" name="weekly" ${r.weekly ? 'checked' : ''} /> Weekly (Mondays)</label>
            <label class="check"><input type="checkbox" name="monthly" ${r.monthly ? 'checked' : ''} /> Monthly (the 1st)</label>
            <label class="check"><input type="checkbox" name="quarterly" ${r.quarterly ? 'checked' : ''} /> Quarterly</label>
            <label>at <input type="time" name="at" value="${esc(r.at)}" /></label>
          </div>
          <label class="check"><input type="checkbox" name="slack" ${r.slack ? 'checked' : ''} /> Send to Slack (Slack alerts must be on, with "value reports")</label>
          <label class="check"><input type="checkbox" name="drive" ${r.drive ? 'checked' : ''} /> Save as a Google Doc in "Value reports (AI Agent Manager)" (uses the Google Drive connector of your Claude account)</label>
          <p class="hint">Each report covers the period just ended and is also saved in ${esc(data.dir)}, with value.csv.</p>
        </fieldset>
        <div class="actions"><span class="spacer"></span><button class="small primary">Save settings</button></div>
      </form></details>`;
  }

  function render() {
    if (!dialog.open) return;
    if (!data) {
      body.innerHTML = '<p class="hint">Loading…</p>';
      return;
    }
    const ps = data.periods;
    const i = Math.max(0, ps.findIndex((p) => p.key === selected));
    const p = ps[i];
    const prev = ps[i + 1] ?? null;
    const t = p.totals;
    const items = data.items.filter((it) => {
      const at = Date.parse(it.deliveredAt);
      return at >= Date.parse(p.start) && at < Date.parse(p.end);
    });
    const typing = body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
    if (typing) return;
    body.innerHTML = `
      <div class="issues-head">
        <h2>Value</h2>
        <div class="chips" role="tablist">${PERIODS.map(([k, label]) => `<button class="chip ${k === period ? 'active' : ''}" role="tab" aria-selected="${k === period}" data-value-period="${k}">${label}</button>`).join('')}</div>
        <span class="spacer"></span>
        <button class="small" data-value="copy" title="Copy this period's report as Markdown, for an email, doc or review">Copy report</button>
        <button class="small" data-value="send" title="Send this period's report now, to Slack and Google Drive as set below">Send</button>
        <button class="small" data-value="csv" title="Every item with its figures, for a spreadsheet">CSV</button>
        <button class="small" data-value="close" title="Close (Esc)">Close</button>
      </div>
      <p class="value-period"><b>${esc(p.label)}</b>${p.current ? ' <span class="hint">so far</span>' : ''} · ${t.items} item${t.items === 1 ? '' : 's'} delivered${data.pending ? ` · <span class="hint">${data.pending} waiting for an estimate</span>` : ''}</p>
      <div class="value-cards">
        ${card('Value delivered', money(t.valueUsd), `${t.humanHours} engineering hours${t.savingsUsd ? ` + ${money(t.savingsUsd)} savings` : ''}`, prev?.totals.valueUsd, t.valueUsd)}
        ${card('Potential revenue', money(t.revenueUsd), 'first year', prev?.totals.revenueUsd, t.revenueUsd)}
        ${card('Strategic', String(t.strategicHigh), 'high-impact items (4–5 of 5)', null, null)}
        ${card('Leverage', t.leverage ? `${t.leverage}×` : '—', `engineering hours per hour of yours (${t.yourHours}h)`, prev?.totals.leverage, t.leverage)}
        ${card('AI cost', money(t.aiCostUsd), t.roi ? `${t.roi}× value per AI dollar` : '', null, null)}
      </div>
      ${bars(ps)}
      <div class="value-legend hint"><span class="sw val"></span> value delivered <span class="sw rev"></span> potential revenue · pick a bar to see that ${esc(period)}</div>
      ${items.length
        ? `<div class="issues-scroll"><table class="issues value-items">
            <thead><tr><th>Delivered</th><th>Work</th><th>Category</th><th>Hours saved</th><th>Value</th><th>Revenue</th><th>Strategic</th><th>You · AI</th><th></th></tr></thead>
            <tbody>${items.map(itemRow).join('')}</tbody></table></div>`
        : `<p class="hint issues-empty">${data.items.length ? `Nothing delivered in ${esc(p.label)}.` : 'Nothing delivered yet. Work counts once an agent\'s pull request merges, or it finishes without one.'}</p>`}
      ${settingsHtml()}`;
  }

  body.addEventListener('click', async (e) => {
    const per = e.target.closest('[data-value-period]');
    if (per) {
      period = per.dataset.valuePeriod;
      selected = null;
      try {
        localStorage.setItem(SAVED, period);
      } catch {}
      return load();
    }
    const pick = e.target.closest('[data-value-pick]');
    if (pick) {
      selected = pick.dataset.valuePick;
      return render();
    }
    const ed = e.target.closest('[data-value-edit]');
    if (ed) {
      editing = editing === ed.dataset.valueEdit ? null : ed.dataset.valueEdit;
      return render();
    }
    const act = e.target.closest('[data-value-act]')?.dataset.valueAct;
    if (act) {
      const id = e.target.closest('[data-value-form]').dataset.valueForm;
      if (act === 'cancel') {
        editing = null;
        document.activeElement?.blur();
        return render();
      }
      if (act === 'open') {
        dialog.close();
        return openAgent(id);
      }
      try {
        if (act === 'estimate') {
          toast?.('Estimating…');
          await api('POST', `/value/items/${id}/estimate`);
        } else await api('POST', `/value/items/${id}/exclude`, { excluded: act === 'exclude' });
      } catch (err) {
        toast?.(err.message, 6000);
      }
      document.activeElement?.blur();
      return load();
    }
    const b = e.target.closest('[data-value]')?.dataset.value;
    if (b === 'close') return dialog.close();
    if (b === 'csv') {
      const res = await fetch('/api/value/value.csv', { headers: { 'x-agentmgr': '1' } });
      if (!res.ok) return toast?.((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`, 4000);
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'), { href: url, download: 'value.csv' }).click();
      return setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    const p = data?.periods.find((x) => x.key === selected) ?? data?.periods[0];
    const current = Boolean(p?.current);
    if (b === 'copy' || b === 'send') {
      // Reports cover a whole period: the current one so far, or the one just before it.
      if (p && !current && p !== data.periods[1]) return toast?.('Reports are for the current period or the one just ended: pick one of those bars', 5000);
      try {
        if (b === 'copy') {
          const r = await api('GET', `/value/report?kind=${period}${current ? '&current=1' : ''}`);
          await navigator.clipboard.writeText(r.markdown);
          toast?.(`Copied the report for ${r.period.label}`);
        } else {
          const r = await api('POST', '/value/report', { kind: period, current });
          const where = [r.sent.slack && 'Slack', r.sent.drive?.url && 'Google Drive'].filter(Boolean);
          toast?.(`Report for ${r.period.label} saved${where.length ? ` and sent to ${where.join(' and ')}` : ''}${r.sent.drive?.error ? `; Google Drive: ${r.sent.drive.error}` : ''}`, 7000);
        }
      } catch (err) {
        toast?.(err.message, 6000);
      }
    }
  });

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.dataset.valueSettings !== undefined) {
        await api('PUT', `/value?period=${period}`, {
          hourlyRate: Number(f.hourlyRate.value),
          yourMinutes: Number(f.yourMinutes.value),
          currency: f.currency.value.trim().toUpperCase(),
          ai: f.ai.checked,
          maxPerDay: Number(f.maxPerDay.value),
          notes: f.notes.value,
          report: { daily: f.daily.checked, weekly: f.weekly.checked, monthly: f.monthly.checked, quarterly: f.quarterly.checked, at: f.at.value, slack: f.slack.checked, drive: f.drive.checked },
        });
        toast?.('Saved');
      } else {
        const id = f.dataset.valueForm;
        const patch = {};
        for (const k of ['humanHours', 'savingsUsd', 'revenueUsd', 'strategic', 'yourHours', 'category', 'summary']) patch[k] = f[k].value.trim() === '' ? null : k === 'category' || k === 'summary' ? f[k].value.trim() : Number(f[k].value);
        await api('PATCH', `/value/items/${id}`, patch);
        editing = null;
      }
    } catch (err) {
      return toast?.(err.message, 6000);
    }
    document.activeElement?.blur();
    load();
  });

  function open() {
    if (dialog.open) return dialog.close();
    dialog.showModal();
    render();
    load();
  }

  /** The daemon says the figures changed: look again, while open. */
  function changed() {
    if (!dialog.open) return;
    clearTimeout(again);
    again = setTimeout(load, 800);
  }

  return { open, changed, isOpen: () => dialog.open };
}
