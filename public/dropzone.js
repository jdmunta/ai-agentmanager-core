// Drop to start: tickets, requirements, designs and files dragged onto the page (or onto the New
// agents form) fill the form in. A ticket link becomes the request (the agent is named after the
// issue and tracks it), a repository link fills the repository, requirement and design links are
// listed as context, text becomes the request, and files are attached. Nothing starts until you
// press the button: what was understood is shown first.

const IMAGE = /\.(png|jpe?g|gif|webp|svg|fig|sketch|xd|psd)(\?|#|$)/i;
const DOCUMENT = /\.(pdf|md|markdown|docx?|txt|rtf|pptx?|xlsx?|csv)(\?|#|$)/i;

/** What a link is: { kind: 'ticket' | 'repo' | 'design' | 'doc' | 'link', url, label, repo? }. */
export function classifyUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const url = u.href;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const jira = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i)?.[1] ?? u.searchParams.get('selectedIssue');
  if (jira && /^[A-Z][A-Z0-9_]+-\d+$/i.test(jira)) return { kind: 'ticket', url, label: jira.toUpperCase() };
  if (['github.com', 'gitlab.com', 'bitbucket.org'].includes(host) && parts.length >= 2) {
    const repo = `https://${host}/${parts[0]}/${parts[1].replace(/\.git$/, '')}.git`;
    const issue = u.pathname.match(/\/(?:-\/)?issues\/(\d+)/);
    if (issue) return { kind: 'ticket', url, label: `${parts[1]}#${issue[1]}`, repo };
    if (parts.length === 2) return { kind: 'repo', url: repo, label: `${parts[0]}/${parts[1].replace(/\.git$/, '')}` };
  }
  if (/\.git$/.test(u.pathname)) return { kind: 'repo', url, label: parts.slice(-2).join('/').replace(/\.git$/, '') };
  if (host === 'linear.app' && /\/issue\//.test(u.pathname)) return { kind: 'ticket', url, label: u.pathname.match(/\/issue\/([^/]+)/)?.[1] ?? 'issue' };
  if (/(^|\.)(figma\.com|sketch\.com|zeplin\.io|miro\.com|whimsical\.com|excalidraw\.com|invisionapp\.com|framer\.com|canva\.com)$/.test(host) || IMAGE.test(u.pathname)) return { kind: 'design', url, label: host };
  if (/(^|\.)(docs\.google\.com|drive\.google\.com|notion\.so|notion\.site|paper\.dropbox\.com|coda\.io|sharepoint\.com|quip\.com)$/.test(host) || /(^|\.)atlassian\.net$/.test(host) || /\/(wiki|confluence)\//.test(u.pathname) || DOCUMENT.test(u.pathname)) return { kind: 'doc', url, label: host };
  return { kind: 'link', url, label: host };
}

/**
 * What was dropped or pasted, sorted: `uris` (the text/uri-list of a drag) and `text` (its
 * text/plain). Text that is only links counts as links; any other text is kept as the request.
 * Returns { tickets, repo, designs, docs, links, text }.
 */
export function readDrop({ uris = '', text = '' } = {}) {
  const out = { tickets: [], repo: null, designs: [], docs: [], links: [], text: '' };
  const seen = new Set();
  const take = (raw) => {
    const c = classifyUrl(raw);
    if (!c || seen.has(c.url)) return Boolean(c);
    seen.add(c.url);
    if (c.kind === 'ticket') out.tickets.push(c);
    else if (c.kind === 'repo') out.repo ??= c;
    else out[`${c.kind}s`].push(c);
    if (c.repo && !out.repo) out.repo = { kind: 'repo', url: c.repo, label: c.repo.replace(/^https:\/\/[^/]+\//, '').replace(/\.git$/, ''), implied: true };
    return true;
  };
  for (const line of String(uris).split(/\r?\n/)) if (line.trim() && !line.startsWith('#')) take(line);
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => classifyUrl(w))) words.forEach(take);
  else if (String(text).trim() && !seen.has(classifyUrl(String(text).trim())?.url)) out.text = String(text).trim();
  return out;
}

export const isEmptyDrop = (d) => !d.tickets.length && !d.repo && !d.designs.length && !d.docs.length && !d.links.length && !d.text;

const contextLines = (d) => [...d.docs.map((x) => `- Requirements: ${x.url}`), ...d.designs.map((x) => `- Design: ${x.url}`), ...d.links.map((x) => `- Link: ${x.url}`)];

/**
 * The request text after a drop. `current` is what the form holds and `split` its mode ("lines":
 * one agent per line; "one": the whole text is one request). Several tickets become one line each;
 * one ticket (or none) with context becomes one request with the context listed under it.
 * Returns { text, split }.
 */
export function composeIntents(current, d, split = 'lines') {
  const cur = String(current ?? '').replace(/\s+$/, '');
  const ctx = contextLines(d);
  const flat = [...d.docs, ...d.designs, ...d.links].map((x) => x.url).join(' ');
  // Lines that are each their own agent stay that way: context rides on the ticket's line.
  if (d.tickets.length > 1 || (cur && split === 'lines')) {
    const lines = d.tickets.map((t) => `${t.url}${flat ? ` (context: ${flat})` : ''}`);
    if (!lines.length && (flat || d.text)) lines.push([d.text.replace(/\s*\n\s*/g, ' '), flat ? `(context: ${flat})` : ''].filter(Boolean).join(' '));
    else if (d.text) lines.push(d.text.replace(/\s*\n\s*/g, ' '));
    return { text: [cur, ...lines].filter(Boolean).join('\n'), split: 'lines' };
  }
  const whole = Boolean(ctx.length || /\n/.test(d.text) || (d.tickets.length && d.text) || split === 'one');
  const body = [d.tickets[0]?.url, d.text, ctx.length ? `Context:\n${ctx.join('\n')}` : ''].filter(Boolean).join('\n\n');
  return { text: [cur, body].filter(Boolean).join('\n\n'), split: whole ? 'one' : split };
}

/** "2 tickets, 1 requirements link, 1 design, the repository, 2 files". */
export function dropSummary(d, files = 0) {
  const n = (k, one, many) => (k ? `${k} ${k === 1 ? one : many}` : '');
  return [n(d.tickets.length, 'ticket', 'tickets'), n(d.docs.length, 'requirements link', 'requirements links'), n(d.designs.length, 'design', 'designs'), n(d.links.length, 'link', 'links'), d.repo ? 'the repository' : '', d.text ? 'the text' : '', n(files, 'file', 'files')].filter(Boolean).join(', ');
}

const has = (e, type) => [...(e.dataTransfer?.types ?? [])].includes(type);
const droppable = (e) => has(e, 'Files') || has(e, 'text/uri-list') || has(e, 'text/plain');

/**
 * `form`: the New agents form (fields intents, split, repo, dir). `zone`: the box inside it.
 * `overlay`: the page-wide "drop to start" frame. `attach.add(files)` attaches files. `open()`
 * opens the form; `isOpen()` says whether it is. `sync()` after the text or the mode changed.
 */
export function initDropZone({ form, zone, overlay, attach, open, isOpen, sync, toast }) {
  const added = zone.querySelector('.drop-added');
  let internal = false; // a drag that started on this page (reordering agents, moving text) is not ours

  function apply(d, files = []) {
    if (isEmptyDrop(d) && !files.length) return false;
    if (!isEmptyDrop(d)) {
      const next = composeIntents(form.intents.value, d, form.split.value);
      form.intents.value = next.text;
      if (next.split !== form.split.value) form.split.value = next.split;
      if (d.repo && !form.repo.value.trim() && !form.dir.value.trim() && !form.project?.value.trim()) form.repo.value = d.repo.url;
    }
    if (files.length) attach.add(files);
    sync();
    const what = dropSummary(d, files.length);
    added.textContent = what ? `Added: ${what}. Check the request below, then start.` : '';
    zone.classList.toggle('filled', Boolean(what));
    return true;
  }

  const take = (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    // A picture dragged from a web page comes as a file and as its link: the file is enough.
    const d = files.length ? readDrop({}) : readDrop({ uris: e.dataTransfer?.getData('text/uri-list') ?? '', text: e.dataTransfer?.getData('text/plain') ?? '' });
    return { d, files };
  };

  document.addEventListener('dragstart', () => (internal = true));
  document.addEventListener('dragend', () => (internal = false));
  // A drag whose element was redrawn under it ends without "dragend": the next press starts clean.
  document.addEventListener('pointerdown', () => (internal = false), true);

  // On the form: links and text (files are taken by the attachments box, which listens there too).
  form.addEventListener('dragover', (e) => {
    if (internal || !droppable(e)) return;
    e.preventDefault();
    zone.classList.add('over');
  });
  form.addEventListener('dragleave', (e) => {
    if (!form.contains(e.relatedTarget)) zone.classList.remove('over');
  });
  form.addEventListener('drop', (e) => {
    zone.classList.remove('over');
    if (internal) return;
    const { d, files } = take(e);
    if (files.length) {
      // The attachments box adds them; here only the summary.
      added.textContent = `Added: ${dropSummary(d, files.length)}. Check the request below, then start.`;
      zone.classList.add('filled');
      return;
    }
    if (isEmptyDrop(d)) return;
    e.preventDefault();
    apply(d);
  });

  // Anywhere on the page, when nothing else takes the drop and no dialog is open: start a new agent.
  const busy = () => internal || Boolean(document.querySelector('dialog[open]'));
  const hide = () => (overlay.hidden = true);
  document.addEventListener('dragover', (e) => {
    if (busy() || e.defaultPrevented || !droppable(e)) return hide();
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    overlay.hidden = false;
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) hide();
  });
  document.addEventListener('drop', (e) => {
    const shown = !overlay.hidden;
    hide();
    if (!shown || busy() || e.defaultPrevented) return;
    const { d, files } = take(e);
    if (isEmptyDrop(d) && !files.length) return;
    e.preventDefault();
    if (!isOpen()) open();
    apply(d, files);
  });

  // Without a mouse (a phone): paste what was copied, or pick files.
  zone.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-drop-act]')?.dataset.dropAct;
    if (act === 'pick') return attach.pick();
    if (act !== 'paste') return;
    try {
      const text = await navigator.clipboard.readText();
      if (!apply(readDrop({ text }))) toast('Nothing to paste: copy a ticket or document link first', 4000);
    } catch {
      toast('The browser did not allow reading the clipboard: paste into the text box instead', 5000);
    }
  });
  if (!navigator.clipboard?.readText) zone.querySelector('[data-drop-act="paste"]')?.remove();

  return {
    apply,
    /** A new form: nothing added yet. */
    reset() {
      added.textContent = '';
      zone.classList.remove('filled', 'over');
    },
  };
}
