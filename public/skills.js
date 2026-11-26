// Skills: the Agent Skills Claude Code has here (yours, and each project's), what each one is and
// which agents used it, and adding more from a git repository: a look at what it offers first,
// then a copy. A skill added here remembers where it came from, so it can be checked and updated.
// Each one says what it names that is gone from its project, and whether a newer version is there.

export function initSkills({ api, $, esc, ago, md, toast, openAgent }) {
  const dialog = $('#skills-dialog');
  const body = $('#skills-body');
  let data = null;
  let problem = null;
  let shown = null; // a skill opened to read
  let offer = null; // what a repository offers: { repo, commit, skills }
  let busy = null; // what is being fetched, in words
  let history = null; // the skills history, when shown
  const checks = new Map(); // skill id -> what a check for a newer version said
  const drafts = { repo: '', place: 'personal', picked: new Set() };

  const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const short = (repo) => String(repo ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

  async function load({ quiet = false } = {}) {
    try {
      data = await api('GET', '/skills');
      problem = null;
    } catch (e) {
      problem = e.message;
      if (!quiet) toast?.(e.message, 5000);
    }
    if (dialog.open) draw();
  }

  function skillHtml(s, place = {}) {
    const c = checks.get(s.id);
    const may = place.allowed !== false;
    const used = s.usedBy.length ? `<span class="hint" title="${esc(s.usedBy.map((u) => `${u.name} (${u.times}×)`).join(', '))}">used by ${s.usedBy.slice(0, 3).map((u) => `<button class="link" data-skill-agent="${esc(u.id)}">${esc(u.name)}</button>`).join(', ')}${s.usedBy.length > 3 ? ` and ${s.usedBy.length - 3} more` : ''}</span>` : '';
    const from = s.source
      ? `<span class="hint">from ${esc(short(s.source.repo))}${s.source.commit ? ` at ${esc(s.source.commit)}` : ''}, added ${esc(ago(s.source.installedAt))}</span>`
      : s.proposedBy
        ? `<span class="hint">proposed by <button class="link" data-skill-agent="${esc(s.proposedBy.agentId)}">${esc(s.proposedBy.agentName ?? 'an agent')}</button>, added ${esc(ago(s.proposedBy.at))}</span>`
        : '<span class="hint">added by hand</span>';
    const drift = s.drift?.length
      ? `<div class="skills-drift"><b>Out of date with the code:</b> ${s.drift.slice(0, 5).map((d) => `<code>${esc(d.ref)}</code> <span class="hint">${esc(d.why)}</span>`).join(' · ')}${s.drift.length > 5 ? ` <span class="hint">and ${s.drift.length - 5} more</span>` : ''}${may && !s.pending && s.drift.some((d) => d.to) ? ` <button class="small" data-skill-fix="${esc(s.id)}" title="Put the renamed paths right in the skill">Fix renamed paths</button>` : ''}</div>`
      : '';
    // The daily look at its repository, when nothing was checked by hand since.
    const newer = !c && s.newer ? `<span class="hint skills-warn">${s.newer.gone ? 'no longer in its repository' : `a newer version is there${s.newer.latest ? ` (${esc(s.newer.latest)})` : ''}`}, as of ${esc(ago(s.newer.at))}</span>` : '';
    const pending = s.pending ? `<span class="hint">pull request open${s.pending.pr ? `: <a href="${esc(s.pending.pr)}" target="_blank" rel="noopener">${esc(s.pending.pr.replace(/^https:\/\/github\.com\//, ''))}</a>` : ` (${esc(s.pending.branch)})`}</span>` : '';
    const unused = s.unused ? '<span class="hint" title="No agent has used it in a month: its description may not say when to use it">not used lately</span>' : '';
    const checked = !c
      ? ''
      : c.error
        ? `<span class="hint skills-warn">${esc(c.error)}</span>`
        : c.gone
          ? '<span class="hint skills-warn">no longer in its repository</span>'
          : c.changed
            ? `<span class="hint skills-warn">a newer version is there (${esc(c.latest ?? '')})</span>`
            : '<span class="hint skills-ok">up to date</span>';
    return `<div class="skills-row" data-skill="${esc(s.id)}">
      <div class="skills-row-head"><b>${esc(s.name)}</b>${s.scripts.length ? `<span class="tag skills-warn" title="It comes with files that can be run: ${esc(s.scripts.join(', '))}">${s.scripts.length} script${s.scripts.length === 1 ? '' : 's'}</span>` : ''}${s.edited ? '<span class="tag" title="Changed here since it was added: an update replaces your changes">edited here</span>' : ''}
        <span class="spacer"></span>
        <button class="small" data-skill-show="${esc(s.id)}">Read</button>
        ${s.source ? `<button class="small" data-skill-check="${esc(s.id)}" title="Look at its repository for a newer version">Check</button>` : ''}
        ${may && (c?.changed || (!c && s.newer && !s.newer.gone)) ? `<button class="small primary" data-skill-update="${esc(s.id)}" title="Replace it with its repository's current version${s.edited ? '. Your changes to it go' : ''}">Update</button>` : ''}
        ${may ? `<button class="small ghost" data-skill-remove="${esc(s.id)}" title="${place.via === 'pr' ? 'Open a pull request that deletes this skill' : "Delete this skill's folder"}">Remove</button>` : ''}</div>
      <p class="skills-desc">${esc(s.description ?? 'No description: Claude Code cannot tell when to use it.')}</p>
      ${drift}
      <div class="skills-meta">${from}<span class="hint">${s.files} file${s.files === 1 ? '' : 's'}, ${size(s.size)}</span>${used}${checked}${newer}${pending}${unused}</div>
    </div>`;
  }

  function offerHtml() {
    if (!offer) return '';
    const places = data?.places ?? [];
    if (!offer.skills.length) return `<div class="skills-offer"><p class="hint">No skill (a folder with a SKILL.md) was found in ${esc(short(offer.repo))}.</p></div>`;
    return `<div class="skills-offer">
      <p><b>${esc(short(offer.repo))}</b>${offer.commit ? ` at ${esc(offer.commit)}` : ''} has ${offer.skills.length} skill${offer.skills.length === 1 ? '' : 's'}. Pick the ones to add:</p>
      <div class="skills-pick">${offer.skills
        .map((s) => `<label class="skills-pick-row"><input type="checkbox" data-skill-pick="${esc(s.folder)}" ${drafts.picked.has(s.folder) ? 'checked' : ''} /><span><b>${esc(s.name)}</b>${s.scripts.length ? ` <span class="tag skills-warn" title="${esc(s.scripts.join(', '))}">${s.scripts.length} script${s.scripts.length === 1 ? '' : 's'}</span>` : ''}${s.installedIn.length ? ' <span class="tag">already here</span>' : ''} <span class="hint">${s.files} file${s.files === 1 ? '' : 's'}, ${size(s.size)}</span><br /><span class="hint">${esc(s.description ?? 'No description')}</span></span></label>`)
        .join('')}</div>
      <p class="hint skills-warn">A skill is instructions an agent follows, and its scripts are run on this computer with your access. Add skills only from people you trust, and read one before you add it: its repository is at <a href="${esc(offer.repo.replace(/\.git$/, ''))}" target="_blank" rel="noopener">${esc(short(offer.repo))}</a>.</p>
      <div class="skills-add-actions">
        <label>Add to <select data-skill-place>${places.filter((p) => p.allowed !== false).map((p) => `<option value="${esc(p.id)}" ${drafts.place === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
        <span class="spacer"></span>
        <button class="small" data-skill-cancel>Cancel</button>
        <button class="small primary" data-skill-install ${drafts.picked.size && !busy ? '' : 'disabled'}>Add ${drafts.picked.size || ''} skill${drafts.picked.size === 1 ? '' : 's'}</button>
      </div>
    </div>`;
  }

  function draw() {
    const head = `<div class="issues-head"><h2>Skills</h2><span class="hint">What Claude Code's agents know how to do here</span><span class="spacer"></span><button class="small" data-skills="check-all" title="Look at every repository skills came from for newer versions" ${busy ? 'disabled' : ''}>Check all</button><button class="small" data-skills="history" title="Who changed which skill, and when">History</button><button class="small" data-skills="refresh" title="Read again">↻</button><button class="small" data-skills="close" title="Close (Esc)">Close</button></div>`;
    if (shown) {
      body.innerHTML = `<div class="issues-head"><button class="small" data-skills="back">← Skills</button><h2>${esc(shown.name)}</h2><span class="spacer"></span><button class="small" data-skills="close">Close</button></div>
        <div class="issues-scroll skills-scroll">
          <p class="hint">${esc(shown.dir)}</p>
          <details class="skills-files"><summary>${shown.list.length} file${shown.list.length === 1 ? '' : 's'}${shown.scripts.length ? `, ${shown.scripts.length} of them script${shown.scripts.length === 1 ? '' : 's'}` : ''}</summary><ul>${shown.list.map((f) => `<li>${esc(f.path)} <span class="hint">${size(f.size)}${f.script ? ' · script' : ''}</span></li>`).join('')}</ul></details>
          <div class="md">${md(shown.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))}</div>
        </div>`;
      return;
    }
    if (!data) return (body.innerHTML = `${head}<p class="hint">${problem ? esc(problem) : 'Loading…'}</p>`);
    if (history) {
      const what = { added: 'Added', replaced: 'Replaced', installed: 'Installed', updated: 'Updated', removed: 'Removed', fixed: 'Fixed paths', 'drift.dismissed': 'Dismissed an alert', 'proposal.dismissed': 'Dismissed a proposal' };
      body.innerHTML = `<div class="issues-head"><button class="small" data-skills="history-close">← Skills</button><h2>Skills history</h2><span class="spacer"></span><button class="small" data-skills="close">Close</button></div>
        <div class="issues-scroll skills-scroll">${
          history.length
            ? `<table class="skills-history"><thead><tr><th>When</th><th>What</th><th>Skill</th><th>By</th></tr></thead><tbody>${history
                .map((e) => `<tr><td>${esc(ago(e.at))}</td><td>${esc(what[e.action] ?? e.action)}${e.via === 'pr' ? ` <span class="tag">pull request</span>` : ''}</td><td><code>${esc(e.id ?? e.ids?.join(', ') ?? e.folder ?? '')}</code>${e.from?.agentName ? `<br /><span class="hint">proposed by ${esc(e.from.agentName)}</span>` : ''}${e.pr ? `<br /><a href="${esc(e.pr)}" target="_blank" rel="noopener">${esc(e.pr.replace(/^https:\/\/github\.com\//, ''))}</a>` : ''}</td><td>${esc(e.by?.person || 'You')}<br /><span class="hint">${esc(e.by?.from ?? '')}</span></td></tr>`)
                .join('')}</tbody></table>`
            : '<p class="hint">No changes to skills yet.</p>'
        }</div>`;
      return;
    }
    body.innerHTML = `${head}
      <div class="issues-scroll skills-scroll">
        ${data.policy?.sources === false || !data.places.some((p) => p.allowed !== false) ? '<p class="hint">The skill policy does not allow installing skills here.</p>' : `<form class="skills-add" data-skills-form>
          <input name="repo" value="${esc(drafts.repo)}" placeholder="Add skills from a repository: anthropics/skills, or https://github.com/owner/name" aria-label="A repository of skills" ${busy ? 'disabled' : ''} />
          <button class="small primary" ${busy ? 'disabled' : ''}>${busy ? esc(busy) : 'Look'}</button>
        </form>`}
        ${offerHtml()}
        ${data.places
          .map((p) => `<div class="plan-project skills-place" data-skills-place="${esc(p.id)}"><div class="plan-project-head"><h3>${esc(p.label)}</h3><span class="tag">${p.skills.length}</span>${p.allowed === false ? '<span class="tag" title="The skill policy allows no changes here">read-only</span>' : p.via === 'pr' ? '<span class="tag" title="The skill policy makes changes here as pull requests">changes by pull request</span>' : ''}<span class="spacer"></span><span class="hint">${esc(p.dir)}</span></div>
            ${p.skills.map((s) => skillHtml(s, p)).join('') || '<p class="hint">No skills here.</p>'}</div>`)
          .join('')}
        <p class="hint">A skill is a folder with a SKILL.md: when to use it, and what to do. Claude Code offers yours to every agent and a project's to the agents in that project; an agent picks one up when the task fits its description. A project's skills are files in its repository: commit them for agents working in their own worktrees to get them. Sessions already open see a new skill after a restart.</p>
      </div>`;
  }

  const act = async (words, fn) => {
    busy = words;
    draw();
    try {
      await fn();
    } catch (e) {
      toast?.(e.message, 7000);
    }
    busy = null;
    draw();
  };

  body.addEventListener('submit', (e) => {
    if (!e.target.matches('[data-skills-form]')) return;
    e.preventDefault();
    drafts.repo = e.target.repo.value.trim();
    if (!drafts.repo) return toast?.('Give a repository: owner/name on GitHub, or an https git address', 4000);
    act('Looking…', async () => {
      offer = await api('POST', '/skills/preview', { repo: drafts.repo });
      drafts.picked = new Set(offer.skills.length === 1 ? [offer.skills[0].folder] : []);
    });
  });
  body.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-skill-pick]');
    if (pick) {
      pick.checked ? drafts.picked.add(pick.dataset.skillPick) : drafts.picked.delete(pick.dataset.skillPick);
      return draw();
    }
    if (e.target.matches('[data-skill-place]')) drafts.place = e.target.value;
  });
  body.addEventListener('input', (e) => {
    if (e.target.name === 'repo') drafts.repo = e.target.value;
  });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-skills]')?.dataset.skills;
    if (b === 'close') return dialog.close();
    if (b === 'refresh') return load();
    if (b === 'history')
      return act('Loading…', async () => {
        history = await api('GET', '/skills/history?limit=200');
      });
    if (b === 'history-close') {
      history = null;
      return draw();
    }
    if (b === 'check-all')
      return act('Checking…', async () => {
        checks.clear();
        await api('POST', '/skills/check-all', {});
        data = await api('GET', '/skills');
      });
    if (b === 'back') {
      shown = null;
      return draw();
    }
    const agent = e.target.closest('[data-skill-agent]');
    if (agent) {
      dialog.close();
      return openAgent?.(agent.dataset.skillAgent);
    }
    if (e.target.closest('[data-skill-cancel]')) {
      offer = null;
      return draw();
    }
    if (e.target.closest('[data-skill-install]')) {
      const names = [...drafts.picked];
      const again = offer.skills.filter((s) => drafts.picked.has(s.folder) && s.installedIn.includes(drafts.place)).map((s) => s.name);
      if (again.length && !confirm(`${again.join(', ')} ${again.length === 1 ? 'is' : 'are'} already there. Replace ${again.length === 1 ? 'it' : 'them'}?`)) return;
      return act('Adding…', async () => {
        const r = await api('POST', '/skills', { repo: offer.repo, names, place: drafts.place, replace: true });
        data = r;
        offer = null;
        drafts.repo = '';
        toast?.(`Added ${r.added.join(', ')}. Agents see ${r.added.length === 1 ? 'it' : 'them'} in sessions started from now on`, 5000);
      });
    }
    const show = e.target.closest('[data-skill-show]');
    if (show) {
      try {
        shown = await api('GET', `/skills/one?id=${encodeURIComponent(show.dataset.skillShow)}`);
      } catch (err) {
        toast?.(err.message, 5000);
      }
      return draw();
    }
    const fix = e.target.closest('[data-skill-fix]');
    if (fix)
      return act('Fixing…', async () => {
        const r = await api('POST', '/skills/fix', { id: fix.dataset.skillFix });
        data = await api('GET', '/skills');
        toast?.(`Put right: ${r.fixed.map((f) => `${f.ref} → ${f.to}`).join(', ')}`, 5000);
      });
    const check = e.target.closest('[data-skill-check]');
    if (check) {
      const id = check.dataset.skillCheck;
      return act('Checking…', async () => {
        checks.set(id, await api('POST', '/skills/check', { id }).catch((err) => ({ error: err.message })));
      });
    }
    const update = e.target.closest('[data-skill-update]');
    if (update) {
      const id = update.dataset.skillUpdate;
      const s = data.places.flatMap((p) => p.skills).find((x) => x.id === id);
      if (s?.edited && !confirm(`${s.name} was changed here since it was added. Updating replaces your changes. Update?`)) return;
      return act('Updating…', async () => {
        data = await api('POST', '/skills/update', { id });
        checks.delete(id);
        toast?.(data.via === 'pr' ? `Pull request opened${data.pr ? `: ${data.pr}` : ''}` : 'Updated', 5000);
      });
    }
    const remove = e.target.closest('[data-skill-remove]');
    if (remove) {
      const id = remove.dataset.skillRemove;
      const s = data.places.flatMap((p) => p.skills).find((x) => x.id === id);
      const viaPr = data.places.find((p) => p.id === s?.place)?.via === 'pr';
      if (!confirm(viaPr ? `Open a pull request that removes ${s?.name ?? 'this skill'}?` : `Remove ${s?.name ?? 'this skill'}? Its folder (${s?.dir ?? ''}) is deleted.`)) return;
      try {
        data = await api('DELETE', `/skills?id=${encodeURIComponent(id)}`);
        checks.delete(id);
        if (data.via === 'pr') toast?.(`Pull request opened${data.pr ? `: ${data.pr}` : ''}`, 5000);
      } catch (err) {
        toast?.(err.message, 6000);
      }
      return draw();
    }
  });

  function open() {
    if (dialog.open) return dialog.close();
    shown = null;
    history = null;
    dialog.showModal();
    draw();
    load();
  }
  return { open, isOpen: () => dialog.open };
}
