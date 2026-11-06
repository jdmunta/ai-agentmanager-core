// Publishing an agent's documents to Google Drive: one folder per agent, one Google Doc per document.
// It goes through the Google Drive connector of the person's Claude account (a headless Claude call
// that may use only the two Drive tools below), so AI Agent Manager holds no Google credentials.
// The connector can create files but not change their content: publishing again creates new
// versions and moves the earlier ones to the trash.
import { marked } from 'marked';

export const DRIVE_TOOLS = ['mcp__claude_ai_Google_Drive__create_file', 'mcp__claude_ai_Google_Drive__trash_file'];
export const DRIVE_PROMPT_START = 'Publish documents to Google Drive';

export const docUrl = (id) => `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
export const folderUrl = (id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

/** What gets published, in folder order: the agent's files, then any documents written for it. */
export const DRIVE_DOCS = [
  ['brief', 'Brief'],
  ['intent', 'Intent'],
  ['spec', 'Spec'],
  ['plan', 'Plan'],
  ['designdoc', 'Design doc'],
  ['benchmark', 'Benchmark'],
  ['analysis', 'Analysis'],
  ['design', 'Design'],
  ['flow', 'Flow'],
  ['proposal', 'Proposal'],
  ['diagrams', 'Diagrams'],
  ['walkthrough', 'Change walkthrough'],
  ['scorecard', 'Review scorecard'],
  ['humanai', 'Human vs AI'],
];

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A document as HTML that Google Drive converts to a Google Doc (Mermaid stays as code, with a pointer to where it's drawn). */
export function driveHtml(title, markdown, { designPage } = {}) {
  const body = marked.parse(String(markdown ?? ''), { async: false });
  const drawn = /```\s*mermaid/i.test(markdown)
    ? `<p><i>Diagrams are in Mermaid below; see them drawn in AI Agent Manager${designPage ? ` or on the <a href="${escHtml(designPage)}">design page</a>` : ''}.</i></p>`
    : '';
  return `<html><head><meta charset="utf-8"><title>${escHtml(title)}</title></head><body>${drawn}${body}</body></html>`;
}

/** The instructions for the headless call that does the publishing. */
export function drivePrompt({ folderTitle, folderId, docs, trash }) {
  return [
    `${DRIVE_PROMPT_START} with your Google Drive tools. Do exactly this, without asking:`,
    folderId
      ? `1. Folder: use the existing folder with id "${folderId}". Only if creating a file in it fails because it is gone, create a new folder as below and use that.`
      : '1. Folder: create one with create_file: no content, mime type application/vnd.google-apps.folder,',
    `   title "${folderTitle}".`,
    '2. For each <document> below, call create_file once: parentId = the folder id, title = its title attribute,',
    '   contentMimeType "text/html", textContent = the HTML inside the tag exactly as given. Do not edit, shorten or reformat it.',
    trash.length
      ? `3. Then, for each earlier version below whose document you created again in step 2, move it to the trash with trash_file:\n${trash.map((t) => `   - ${t.key}: ${t.id}`).join('\n')}`
      : '3. There are no earlier versions to trash.',
    '4. Reply with only this JSON, no prose and no code fence:',
    '   {"folderId": "<folder id>", "files": [{"key": "<key attribute>", "id": "<new file id>"}], "trashed": ["<id>"], "errors": ["<what failed and why>"]}',
    '',
    ...docs.map((d) => `<document key="${d.key}" title="${escHtml(d.title)}">\n${d.html}\n</document>`),
  ].join('\n');
}

const ID = /^[\w-]{6,200}$/;

/** The reply, checked: only ids that look like Drive ids, only for documents that were sent. */
export function parseDrive(reply, keys) {
  const m = String(reply ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`No result from the Google Drive publish: ${String(reply ?? '').trim().slice(0, 200)}`);
  const data = JSON.parse(m[0]);
  const folderId = ID.test(data.folderId ?? '') ? data.folderId : null;
  const files = {};
  for (const f of Array.isArray(data.files) ? data.files : []) if (keys.includes(f?.key) && ID.test(f?.id ?? '')) files[f.key] = f.id;
  const strings = (a) => (Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 50) : []);
  return { folderId, files, trashed: strings(data.trashed).filter((id) => ID.test(id)), errors: strings(data.errors).map((e) => e.slice(0, 300)) };
}
