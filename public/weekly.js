// Weekly summary (Work record → Weekly summary): one page on a week's work and achievements, for
// management. Last week or this week so far; read it, copy it as Markdown, or save it as a file.
// It is a draft for you: nothing is sent from here.

export function initWeekly({ api, esc, toast, $, md }) {
  const dlg = $('#weekly-dialog');
  let current = false;
  let report = null;

  function render() {
    $('#weekly-tabs').innerHTML = [[false, 'Last week'], [true, 'This week so far']]
      .map(([v, label]) => `<button type="button" class="chip ${v === current ? 'active' : ''}" role="tab" aria-selected="${v === current}" data-weekly-current="${v ? 1 : 0}">${label}</button>`)
      .join('');
    $('#weekly-body').innerHTML = report ? `<div class="md weekly-md">${md(report.markdown)}</div>` : '<p class="hint">Loading…</p>';
    $('#weekly-note').textContent = report
      ? `${report.saved ? `Saved as ${report.file}. ` : ''}Put together from the work record, Value and Quality; estimates are marked as estimates. Work that is kept private is listed without a description. Nothing is sent from here.`
      : '';
  }

  async function load() {
    report = null;
    render();
    try {
      report = await api('GET', `/weekly${current ? '?current=1' : ''}`);
    } catch (err) {
      $('#weekly-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
      return;
    }
    render();
  }

  $('#weekly-open').onclick = () => {
    dlg.showModal();
    load();
  };
  dlg.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-weekly-current]');
    if (tab) {
      current = tab.dataset.weeklyCurrent === '1';
      return load();
    }
    const act = e.target.closest('[data-weekly]')?.dataset.weekly;
    if (act === 'close') return dlg.close();
    if (!report) return;
    try {
      if (act === 'copy') {
        await navigator.clipboard.writeText(report.markdown);
        toast(`Copied the summary for ${report.week.label}`);
      } else if (act === 'save') {
        report = await api('POST', '/weekly/save', { current });
        toast(`Saved as ${report.file}`, 6000);
        render();
      } else if (act === 'download') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([`${report.markdown}\n`], { type: 'text/markdown' }));
        a.download = `weekly-${report.week.start}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  });
  return { isOpen: () => dlg.open };
}
