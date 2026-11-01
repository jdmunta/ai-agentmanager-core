// Attachments for a request that has no agent yet (New agents, Ask): pick, drop or paste files
// (a screenshot, a log). Each uploads to the daemon right away and shows as a chip; the form sends
// the uploaded paths, and the daemon copies them to each agent it creates.

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * `slot` is an element to fill with the button and chips; `form` takes drops; `paste` (a textarea)
 * takes pasted files. Returns { paths(), pending(), clear() }.
 */
export function attachBox({ slot, form, paste, esc, toast }) {
  const items = []; // { id, name, size, path?, error?, uploading }
  let seq = 0;
  slot.classList.add('attach-box');
  slot.innerHTML = `<button type="button" class="small ghost attach-pick" title="Attach files: a screenshot, a log, a document. You can also drop them here or paste into the text box">📎 Attach files</button>
    <input type="file" multiple hidden />
    <span class="attach-chips"></span>`;
  const input = slot.querySelector('input[type=file]');
  const chips = slot.querySelector('.attach-chips');

  function render() {
    chips.innerHTML = items
      .map(
        (it) => `<span class="attach-chip ${it.error ? 'fail' : ''}" title="${esc(it.error ?? it.path ?? 'Uploading…')}">${esc(it.name)} <span class="hint">${it.uploading ? 'uploading…' : it.error ? 'failed' : fmtSize(it.size)}</span><button type="button" class="link" data-drop="${it.id}" title="Remove">×</button></span>`,
      )
      .join('');
  }

  async function add(files) {
    for (const file of files) {
      const name = file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/\W/g, '')}`;
      const it = { id: ++seq, name, size: file.size, uploading: true };
      items.push(it);
      render();
      try {
        const res = await fetch(`/api/uploads?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-agentmgr': '1' },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        Object.assign(it, { path: data.path, size: data.size });
      } catch (err) {
        it.error = err.message;
        toast(`Could not attach ${name}: ${err.message}`, 5000);
      }
      it.uploading = false;
      render();
    }
  }

  slot.querySelector('.attach-pick').onclick = () => input.click();
  input.onchange = () => {
    add([...input.files]);
    input.value = '';
  };
  chips.addEventListener('click', (e) => {
    const id = Number(e.target.closest('[data-drop]')?.dataset.drop);
    if (!id) return;
    items.splice(
      items.findIndex((it) => it.id === id),
      1,
    );
    render();
  });
  form.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
      e.preventDefault();
      form.classList.add('dropping');
    }
  });
  form.addEventListener('dragleave', (e) => {
    if (!form.contains(e.relatedTarget)) form.classList.remove('dropping');
  });
  form.addEventListener('drop', (e) => {
    form.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });
  // A pasted screenshot (or copied files) attaches; pasted text stays text.
  paste?.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });

  return {
    paths: () => items.filter((it) => it.path).map((it) => it.path),
    pending: () => items.some((it) => it.uploading),
    clear() {
      items.length = 0;
      render();
    },
  };
}
