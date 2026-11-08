// Report a problem or an idea: a title, what happened (or what would help) and a screenshot when
// one helps, by pasting, dropping, choosing a file or capturing the screen. It's kept on this
// computer, and GitHub opens with a new issue filled in; the screenshot is put on the clipboard
// to paste there. Nothing is posted until you submit it on GitHub.

const MAX_SIDE = 2400;
const HINT = {
  bug: 'What happened, and what you expected. Steps help: what you clicked or typed, in order.',
  idea: 'What would help, and what you would use it for.',
};

export function initSupport({ api, $, esc, toast }) {
  const dialog = $('#support-dialog');
  const form = $('#support-form');
  const shot = $('#support-shot');
  let image = null; // { blob, url }

  /** Any image as a PNG no larger than MAX_SIDE on a side: what the clipboard and GitHub take. */
  async function asPng(source) {
    const bmp = await createImageBitmap(source);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't read the image"))), 'image/png'));
  }

  async function setImage(source) {
    try {
      const blob = source ? await asPng(source) : null;
      if (image) URL.revokeObjectURL(image.url);
      image = blob ? { blob, url: URL.createObjectURL(blob) } : null;
    } catch (e) {
      toast(e.message || "Couldn't read the image", 5000);
    }
    drawShot();
  }

  function drawShot() {
    const capture = navigator.mediaDevices?.getDisplayMedia ? '<button type="button" class="small" data-support="capture" title="Pick a screen, window or tab to take a picture of">Capture the screen</button>' : '';
    shot.innerHTML = image
      ? `<img src="${image.url}" alt="Screenshot" class="support-img" /><div class="support-shot-acts"><button type="button" class="small" data-support="remove-shot">Remove</button></div>`
      : `<div class="support-drop">Paste a screenshot (⌘V), drop an image here, <label class="small-link">choose a file<input type="file" accept="image/*" data-support="file" hidden /></label>${capture ? `, or ${capture}` : ''}.</div>`;
  }

  /** One frame of a screen, window or tab you pick; this window steps aside while it's taken. */
  async function capture() {
    let stream = null;
    dialog.close();
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      // Let the picker's own overlay go first.
      await new Promise((r) => setTimeout(r, 400));
      await setImage(await createImageBitmap(video));
    } catch (e) {
      if (e?.name !== 'NotAllowedError') toast(`Couldn't capture: ${e.message}`, 5000);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      dialog.showModal();
    }
  }

  function kind() {
    return form.kind.value || 'bug';
  }

  async function drawEarlier() {
    const box = $('#support-earlier');
    try {
      const { tickets } = await api('GET', '/support');
      box.innerHTML = tickets.length
        ? `<details><summary>Your earlier reports (${tickets.length})</summary><ul>${tickets
            .map((t) => `<li><a href="${esc(t.issueUrl)}" target="_blank" rel="noopener">${esc(t.title)}</a> <span class="hint">${esc(new Date(t.at).toLocaleDateString())}${t.screenshot ? ` · <a href="/api/support/${esc(t.id)}/screenshot" target="_blank" rel="noopener">screenshot</a>` : ''}</span></li>`)
            .join('')}</ul><p class="hint">Kept on this computer in ${esc(tickets[0].folder.replace(/\/[^/]+$/, ''))}.</p></details>`
        : '';
    } catch {
      box.innerHTML = '';
    }
  }

  function open() {
    form.reset();
    $('#support-error').hidden = true;
    $('#support-done').hidden = true;
    form.hidden = false;
    setImage(null);
    form.details.placeholder = HINT.bug;
    dialog.showModal();
    form.title.focus();
    drawEarlier();
  }

  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind') form.details.placeholder = HINT[kind()];
  });
  dialog.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    setImage(f);
  });
  shot.addEventListener('dragover', (e) => {
    e.preventDefault();
    shot.classList.add('over');
  });
  shot.addEventListener('dragleave', () => shot.classList.remove('over'));
  shot.addEventListener('drop', (e) => {
    e.preventDefault();
    shot.classList.remove('over');
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) setImage(f);
  });
  dialog.addEventListener('change', (e) => {
    if (e.target.dataset.support === 'file' && e.target.files?.[0]) setImage(e.target.files[0]);
  });
  dialog.addEventListener('click', (e) => {
    const b = e.target.closest('[data-support]')?.dataset.support;
    if (b === 'capture') capture();
    else if (b === 'remove-shot') setImage(null);
    else if (b === 'close') dialog.close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#support-error');
    err.hidden = true;
    // While this click still counts as yours: the browser allows the new tab and the clipboard only then.
    const tab = window.open('about:blank', '_blank');
    let copied = false;
    if (image && navigator.clipboard?.write && window.ClipboardItem) {
      copied = await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]).then(
        () => true,
        () => false,
      );
    }
    try {
      let t = await api('POST', '/support', { kind: kind(), title: form.title.value, details: form.details.value });
      if (image) {
        const res = await fetch(`/api/support/${encodeURIComponent(t.id)}/screenshot`, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-agentmgr': '1' }, body: image.blob });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `The screenshot wasn't saved (${res.status})`);
        t = await res.json();
      }
      if (tab) {
        tab.opener = null;
        tab.location.href = t.issueUrl;
      }
      form.hidden = true;
      const done = $('#support-done');
      done.hidden = false;
      done.innerHTML = `<p><b>Saved.</b> ${tab ? 'GitHub opened in a new tab with your report filled in' : 'Open the filled-in report on GitHub'}: look it over, ${t.screenshot ? (copied ? 'paste the screenshot (⌘V) where it says, ' : 'drag the screenshot in where it says, ') : ''}then submit it there.</p>
        <p><a href="${esc(t.issueUrl)}" target="_blank" rel="noopener" class="small-link">Open the report on GitHub ↗</a>${t.screenshot ? ` · <a href="/api/support/${esc(t.id)}/screenshot" target="_blank" rel="noopener" class="small-link">The screenshot</a>` : ''}</p>
        <p class="hint">GitHub issues are public. You need a GitHub account to submit. A copy is kept on this computer in ${esc(t.folder)}.</p>
        <div class="dialog-actions"><button type="button" data-support="close" class="primary">Done</button></div>`;
    } catch (ex) {
      tab?.close();
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  return { open };
}
