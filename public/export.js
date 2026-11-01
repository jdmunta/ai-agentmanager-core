// Taking diagrams out of the page, for a pull request or Slack: each drawn diagram gets Copy image,
// PNG and SVG; a whole document of diagrams downloads as one self-contained HTML file. Diagrams are
// drawn with SVG text labels (not HTML in foreignObject), so they turn into PNGs without the
// browser refusing a "tainted" canvas.

const TOOLS = `<span class="dg-tools"><button type="button" class="small ghost" data-dg="copy" title="Copy as an image: paste into Slack, a GitHub comment or a doc">Copy image</button><button type="button" class="small ghost" data-dg="png" title="Download as a PNG">PNG</button><button type="button" class="small ghost" data-dg="svg" title="Download as an SVG (sharp at any size)">SVG</button></span>`;

/** Add the export buttons to a drawn diagram slot. */
export function addTools(slot) {
  if (slot.querySelector('.dg-tools') || !slot.querySelector('svg')) return;
  slot.insertAdjacentHTML('afterbegin', TOOLS);
}

const pageBg = () => getComputedStyle(document.body).backgroundColor || '#ffffff';

/** A standalone copy of a diagram's SVG: sized, namespaced, on the page's background. */
export function svgText(svg, { background = pageBg() } = {}) {
  const copy = svg.cloneNode(true);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const vb = svg.viewBox?.baseVal;
  const box = svg.getBoundingClientRect();
  const w = Math.ceil(vb?.width || box.width || 800);
  const h = Math.ceil(vb?.height || box.height || 600);
  copy.setAttribute('width', w);
  copy.setAttribute('height', h);
  copy.removeAttribute('style'); // mermaid's max-width would shrink it outside the page
  if (background) {
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    Object.entries({ x: vb?.x ?? 0, y: vb?.y ?? 0, width: '100%', height: '100%', fill: background }).forEach(([k, v]) => bg.setAttribute(k, v));
    if (vb) {
      bg.setAttribute('width', vb.width);
      bg.setAttribute('height', vb.height);
    }
    copy.insertBefore(bg, copy.firstChild);
  }
  return { text: new XMLSerializer().serializeToString(copy), w, h };
}

/** The diagram as a PNG blob, at twice its size so it stays sharp on retina screens and in PRs. */
export function pngBlob(svg, scale = 2) {
  const { text, w, h } = svgText(svg);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: w * scale, height: h * scale });
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not draw the diagram as an image'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  });
}

export function download(blob, name) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

const slugOf = (s) => String(s || 'diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'diagram';

/** The diagram's name for files: its heading in the document, or "diagram". */
function nameOf(slot, base) {
  let el = slot.previousElementSibling;
  while (el && !/^H[1-4]$/.test(el.tagName)) el = el.previousElementSibling;
  return `${base ? `${slugOf(base)}-` : ''}${slugOf(el?.textContent)}`;
}

/** One page with every diagram (and heading) of a rendered document, to keep or attach. */
export function htmlFile(article, title) {
  const copy = article.cloneNode(true);
  copy.querySelectorAll('.dg-tools').forEach((t) => t.remove());
  copy.querySelectorAll('svg').forEach((svg, i) => {
    const live = article.querySelectorAll('svg')[i];
    if (live) svg.outerHTML = svgText(live, { background: null }).text;
  });
  const css = `body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1000px;margin:32px auto;padding:0 16px;color:#1c2330;background:#fff}
h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-top:1px solid #dde1e7;padding-top:14px}
.diagram{display:flex;justify-content:center;margin:12px 0;overflow-x:auto}svg{max-width:100%;height:auto}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/</g, '&lt;')}</title><style>${css}</style></head><body>${copy.innerHTML}</body></html>`;
  return new Blob([html], { type: 'text/html' });
}

/** Clicks on any diagram's buttons, wherever it is drawn. `base` names the files (the agent). */
export function initExport({ toast, base = () => '' }) {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dg]');
    if (!b) return;
    const slot = b.closest('.diagram');
    const svg = slot?.querySelector('svg');
    if (!svg) return;
    const name = nameOf(slot, base(slot));
    try {
      if (b.dataset.dg === 'svg') download(new Blob([svgText(svg).text], { type: 'image/svg+xml' }), `${name}.svg`);
      else if (b.dataset.dg === 'png') download(await pngBlob(svg), `${name}.png`);
      else {
        // Safari wants the promise handed over within the click.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(svg) })]);
        toast('Diagram copied as an image: paste it into Slack, a PR comment or a doc');
      }
    } catch (err) {
      toast(b.dataset.dg === 'copy' ? `Couldn't copy (${err.message}); use PNG instead` : `Couldn't export: ${err.message}`, 5000);
    }
  });
}
