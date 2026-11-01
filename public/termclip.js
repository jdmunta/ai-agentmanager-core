// Copy and paste for terminals on touch screens. xterm draws its text itself, so a phone can't
// long-press-select it, and its hidden input rarely gets the paste menu. Copy opens the terminal's
// recent output as plain text the phone can select (or Copy all); Paste reads the clipboard (the
// phone asks first) or, where it can't, offers a box to paste into, then sends it as one paste.

const MAX_LINES = 600;

/** The terminal's text: the last lines of its buffer, trailing blanks trimmed. */
export function terminalText(xterm, max = MAX_LINES) {
  const buf = xterm.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buf.length - max); i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    // A wrapped line continues the one before it.
    if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
    else lines.push(line.translateToString(true));
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join('\n');
}

function sheet(html) {
  const d = document.createElement('dialog');
  d.className = 'clip-sheet';
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or no permission: copy through a selected text area.
    const t = Object.assign(document.createElement('textarea'), { value: text });
    t.style.cssText = 'position:fixed;opacity:0';
    document.body.append(t);
    t.select();
    const ok = document.execCommand?.('copy');
    t.remove();
    return Boolean(ok);
  }
}

/** Copy: the terminal's text in a sheet, selectable with the phone's own handles, and Copy all. */
export function openCopy(xterm, { esc, toast }) {
  const text = terminalText(xterm);
  const d = sheet(`<div class="clip-head"><b>Copy from the terminal</b><span class="hint">Select with your finger, or copy it all</span><span class="spacer"></span><button type="button" class="small primary" data-clip="all">Copy all</button><button type="button" class="small ghost" data-clip="close">Close</button></div>
    <pre class="clip-text">${esc(text) || '<span class="hint">Nothing in this terminal yet.</span>'}</pre>`);
  // Open at the end, where the latest output is.
  const pre = d.querySelector('.clip-text');
  pre.scrollTop = pre.scrollHeight;
  d.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-clip]')?.dataset.clip;
    if (act === 'close') d.close();
    if (act === 'all') {
      toast((await writeClipboard(text)) ? 'Copied the terminal text' : 'Copy failed: select the text and use your phone\'s Copy', 3000);
      d.close();
    }
  });
}

/** Paste: the clipboard into the terminal (one paste, not submitted), or a box to paste into. */
export async function pasteInto(xterm, { toast }) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      xterm.paste(text);
      return;
    }
  } catch {
    // Not allowed here (or refused): fall back to a box the phone can paste into.
  }
  const d = sheet(`<div class="clip-head"><b>Paste into the terminal</b><span class="spacer"></span><button type="button" class="small ghost" data-clip="close">Cancel</button></div>
    <textarea class="clip-box" rows="6" placeholder="Long-press here and choose Paste"></textarea>
    <div class="clip-foot"><span class="hint">It goes in as typed text; press Enter (⏎) in the terminal when you want it run.</span><button type="button" class="small primary" data-clip="send">Insert</button></div>`);
  const box = d.querySelector('.clip-box');
  box.focus();
  d.addEventListener('click', (e) => {
    const act = e.target.closest('[data-clip]')?.dataset.clip;
    if (act === 'close') d.close();
    if (act === 'send') {
      if (box.value) xterm.paste(box.value);
      else toast('Nothing to paste');
      d.close();
    }
  });
}
