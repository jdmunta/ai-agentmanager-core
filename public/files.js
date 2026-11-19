// Files: this computer's folders from the device in your hand. Send it a file (a photo from the
// phone, a document), or tap one there to fetch it (a log, a build, a screenshot). What is sent
// goes to the folder shown, the Downloads folder to begin with (src/files.js).

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const MAX_SEND = 250 * 1048576; // what the daemon takes in one file

export function initFiles({ api, esc, toast, ago, $ }) {
  const dialog = $('#files-dialog');
  const list = $('#files-list');
  const note = $('#files-note');
  const input = $('#files-input');
  let here = null; // the folder shown, as the daemon gave it
  let sending = 0;

  function render() {
    $('#files-path').value = here.dir;
    $('#files-up').disabled = !here.parent;
    const rows = here.entries.map((e) => {
      const full = `${here.dir.replace(/\/$/, '')}/${e.name}`;
      return e.dir
        ? `<li><button type="button" class="files-row" data-dir="${esc(full)}"><span class="files-icon" aria-hidden="true">📁</span><span class="files-name">${esc(e.name)}</span><span class="hint">${ago(e.at)}</span></button></li>`
        : `<li><a class="files-row" href="/api/machine/file?path=${encodeURIComponent(full)}" download="${esc(e.name)}" title="Fetch this file to this device"><span class="files-icon" aria-hidden="true">⬇</span><span class="files-name">${esc(e.name)}</span><span class="hint">${fmtSize(e.size)} · ${ago(e.at)}</span></a></li>`;
    });
    list.innerHTML = rows.join('') || '<li class="hint files-empty">Nothing here.</li>';
    if (here.more) list.insertAdjacentHTML('beforeend', `<li class="hint files-empty">…and ${here.more} more: type the path above.</li>`);
    if (!sending) note.textContent = `What you send goes into ${here.dir === here.home ? 'your home folder' : here.dir.split('/').pop()}.`;
  }

  async function go(dir) {
    try {
      here = await api('GET', `/machine/files?dir=${encodeURIComponent(dir ?? '')}${$('#files-hidden').checked ? '&hidden=1' : ''}`);
      list.scrollTop = 0;
      render();
      return true;
    } catch (err) {
      toast(`Error: ${err.message}`, 6000);
      return false;
    }
  }

  async function send(picked) {
    const into = here?.dir;
    if (!into) return;
    for (const file of picked) {
      if (file.size > MAX_SEND) {
        toast(`${file.name} is ${fmtSize(file.size)}: more than the ${fmtSize(MAX_SEND)} that can be sent at once`, 7000);
        continue;
      }
      sending++;
      note.textContent = `Sending ${file.name} (${fmtSize(file.size)})…`;
      try {
        const res = await fetch(`/api/machine/files?name=${encodeURIComponent(file.name || 'file')}&dir=${encodeURIComponent(into)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-agentmgr': '1' },
          body: file,
        });
        const saved = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(saved.error || `HTTP ${res.status}`);
        toast(`Sent: ${saved.path}`, 5000);
      } catch (err) {
        toast(`${file.name} was not sent: ${err.message}`, 7000);
      }
      sending--;
    }
    if (here?.dir === into) await go(into);
  }

  $('#files-pick').onclick = () => input.click();
  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    send(picked);
  });
  dialog.addEventListener('dragover', (e) => e.preventDefault());
  dialog.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files.length) send([...e.dataTransfer.files]);
  });
  list.addEventListener('click', (e) => {
    const dir = e.target.closest('[data-dir]');
    if (dir) go(dir.dataset.dir);
  });
  $('#files-up').onclick = () => here?.parent && go(here.parent);
  $('#files-home').onclick = () => go('~');
  $('#files-inbox').onclick = () => go(here?.inbox ?? '~/Downloads');
  $('#files-hidden').onchange = () => go(here?.dir);
  $('#files-path').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    go(e.target.value);
  });
  $('#files-close').onclick = () => dialog.close();

  async function open() {
    if (!dialog.open) dialog.showModal();
    // Where sent files go, and where what you want is most often: Downloads. Home where there is none.
    if (!here && !(await go('~/Downloads'))) await go('~');
    else if (here) await go(here.dir);
  }
  for (const b of document.querySelectorAll('[data-open-files]')) b.addEventListener('click', open);

  return { open };
}
