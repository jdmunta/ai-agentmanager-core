// The menu at the right of the top bar: who this runs as (Claude account, git identity, computer)
// and the settings and preferences: Settings…, Clean up, Alerts, Remote access, About.

export function initMenu({ api, esc, toast, $ }) {
  const btn = $('#menu-btn');
  const menu = $('#menu');
  const remote = () => document.body.classList.contains('remote');

  const open = (on) => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    open(menu.hidden);
  };
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) open(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) open(false);
  });
  // Any item closes the menu; its own handler does the rest.
  menu.addEventListener('click', (e) => {
    // The theme buttons keep it open, to compare.
    if (e.target.closest('button') && !e.target.closest('[data-theme-set]')) open(false);
  });
  $('#menu-about').onclick = () => $('#about-btn').click();

  async function loadMe() {
    try {
      const me = await api('GET', '/me');
      const initials = me.display
        .split(/[\s@._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join('');
      $('#me-avatar').textContent = initials || '·';
      $('#me-name').textContent = me.display;
      $('#me-display').textContent = me.display;
      $('#me-email').textContent = me.email ?? '';
      $('#me-email').hidden = !me.email;
      const where = [me.claude ? `Claude account${me.claude.organization && !me.claude.organization.includes(me.claude.email) ? ` · ${me.claude.organization}` : ''}` : null, me.user && me.host ? `${me.user} on ${me.host}` : null, me.remote ? 'signed in from this device' : null].filter(Boolean);
      $('#me-where').innerHTML = where.map(esc).join('<br>');
      btn.title = `${me.display}${me.email ? ` (${me.email})` : ''}: settings and preferences`;
    } catch {
      // An older daemon has no /me: the menu still works.
      $('#me-display').textContent = 'Settings';
    }
  }

  // ------------------------------------------------------------ Settings dialog
  const dialog = $('#settings-dialog');
  const form = $('#settings-form');
  let service = null; // the login service as the dialog opened
  let jira = null; // the Jira settings as the dialog opened
  let containers = null; // Docker and the agent image as the dialog opened
  function showContainers() {
    const c = containers;
    $('#settings-containers').hidden = !c;
    if (!c) return;
    $('#settings-containers-state').textContent = !c.available
      ? `Docker isn't running here${c.error ? ` (${c.error})` : ''}.`
      : `Docker ${c.version} · image ${c.image}: ${c.building ? 'building…' : c.imageBuilt ? 'built' : 'not built yet'}${c.buildError ? ` (last build failed: ${c.buildError})` : ''} · Claude token ${c.hasClaudeToken ? 'set' : 'not set'}.`;
    $('#containers-build').disabled = !c.available || c.building;
    $('#containers-build').textContent = c.building ? 'Building…' : c.imageBuilt ? 'Rebuild image' : 'Build image';
    form.containerDefault.disabled = !c.available;
  }
  $('#containers-build').onclick = async () => {
    try {
      containers = await api('POST', '/isolation/build');
      showContainers();
      toast('Building the agent image; it takes a few minutes the first time', 6000);
      // Watch it finish.
      const t = setInterval(async () => {
        containers = await api('GET', '/isolation').catch(() => containers);
        if (dialog.open) showContainers();
        if (!containers?.building) {
          clearInterval(t);
          toast(containers?.imageBuilt && !containers.buildError ? 'Agent image built: agents can run in containers' : `Image build failed: ${containers?.buildError ?? 'see the daemon log'}`, 8000);
        }
      }, 5000);
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
    }
  };
  $('#settings-btn').onclick = async () => {
    $('#settings-error').hidden = true;
    try {
      const c = await api('GET', '/cleanup');
      form.maxRunning.value = c.maxRunning ?? '';
      $('#settings-running').textContent = `Open now: ${c.running}.`;
      service = null;
      const u = await api('GET', '/update').catch(() => null);
      form.updateCheck.checked = u?.check !== false;
      if (!remote()) {
        jira = await api('GET', '/jira').catch(() => null);
        form.jiraSite.value = jira?.site ?? '';
        form.jiraEmail.value = jira?.email ?? '';
        form.jiraToken.value = '';
        form.jiraToken.placeholder = jira?.hasToken ? 'saved (type to replace)' : '';
        containers = await api('GET', '/isolation').catch(() => null);
        showContainers();
        form.claudeToken.value = '';
        form.claudeToken.placeholder = containers?.hasClaudeToken ? 'saved (type to replace)' : 'from claude setup-token';
        form.containerDefault.checked = containers?.default === 'container';
        service = await api('GET', '/service').catch(() => null);
        $('#settings-service').hidden = !service?.supported;
        form.startAtLogin.checked = Boolean(service?.installed);
        $('#settings-service-state').textContent = service?.installed ? (service.loaded ? 'On: the login service is loaded.' : 'On; loads at the next login.') : 'Off now.';
      }
      dialog.showModal();
    } catch (err) {
      toast(`Error: ${err.message}`, 5000);
    }
  };
  $('#settings-cancel').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => {
    const go = e.target.closest('[data-open]');
    if (!go) return;
    dialog.close();
    $(`#${go.dataset.open}`).click();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api('PUT', '/cleanup', { maxRunning: form.maxRunning.value.trim() || null });
      await api('PUT', '/update', { check: form.updateCheck.checked }).catch(() => {});
      if (!remote() && jira && (form.jiraSite.value.trim() !== (jira.site ?? '') || form.jiraEmail.value.trim() !== (jira.email ?? '') || form.jiraToken.value.trim())) {
        await api('PUT', '/jira', { site: form.jiraSite.value.trim(), email: form.jiraEmail.value.trim(), token: form.jiraToken.value.trim() || undefined });
        toast('Jira saved; summaries for agents from Jira links are being fetched', 4000);
      }
      if (!remote() && containers?.available) {
        if (form.claudeToken.value.trim()) await api('PUT', '/isolation/token', { token: form.claudeToken.value.trim() });
        if (form.containerDefault.checked !== (containers.default === 'container')) await api('PUT', '/isolation/default', { container: form.containerDefault.checked });
      }
      // Only when it changed: installing touches launchd / systemd.
      if (!remote() && service?.supported && form.startAtLogin.checked !== Boolean(service.installed)) {
        const s = await api('PUT', '/service', { enabled: form.startAtLogin.checked });
        toast(s.installed ? `Starts at login from now on${s.note ? `. ${s.note}` : ''}` : 'No longer starts at login', 6000);
      }
      dialog.close();
      toast(c.maxRunning ? `At most ${c.maxRunning} agents open; the ones idle longest close above that` : 'No limit on open agents');
    } catch (err) {
      $('#settings-error').textContent = err.message;
      $('#settings-error').hidden = false;
    }
  });

  // ------------------------------------------------------------ Theme
  const THEME_KEY = 'agentmgr.theme';
  const theme = () => {
    try {
      return localStorage.getItem(THEME_KEY) || 'auto';
    } catch {
      return 'auto';
    }
  };
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    for (const b of menu.querySelectorAll('[data-theme-set]')) b.classList.toggle('on', b.dataset.themeSet === t);
    window.dispatchEvent(new CustomEvent('agentmgr-theme'));
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (!b) return;
    try {
      localStorage.setItem(THEME_KEY, b.dataset.themeSet);
    } catch {}
    applyTheme(b.dataset.themeSet);
  });
  applyTheme(theme());

  loadMe();
  return { loadMe };
}
