// Drawing a Mermaid diagram an agent wrote. Agents often put parentheses or braces in a node's
// label without quotes (MV[GetMaintenanceView(s)]), which Mermaid reads as a shape and refuses:
// when a diagram fails, it's drawn again once with those labels quoted. A failed render never
// leaves Mermaid's error picture in the page.

// A node's label in [ ], unquoted, with ( ) { } inside that aren't one of Mermaid's [( )] shapes.
const LABEL = /(\b[\w-]+)\[(?!["(/\\[])([^\[\]"\n]*[(){}][^\[\]"\n]*)\]/g;

/** The source with such labels quoted ("" inside a label becomes #quot;). Unchanged when none. */
export function quoteLabels(src) {
  return String(src ?? '').replace(LABEL, (_, id, label) => `${id}["${label.replace(/"/g, '#quot;')}"]`);
}

/** Mermaid's own leftovers from a failed render: its temporary containers and the error picture. */
function sweep(id) {
  for (const sel of [`#${id}`, `#d${id}`, `#i${id}`]) {
    try {
      document.querySelector(sel)?.remove();
    } catch {}
  }
}

/** Render `src` with the Mermaid library `lib`: { svg }, or throws the first error. */
export async function drawDiagram(lib, id, src) {
  try {
    return await lib.render(id, src);
  } catch (err) {
    sweep(id);
    const fixed = quoteLabels(src);
    if (fixed === src) throw err;
    try {
      return await lib.render(`${id}-q`, fixed);
    } catch {
      sweep(`${id}-q`);
      throw err;
    }
  }
}
