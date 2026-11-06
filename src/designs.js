// Designs: every agent's design doc in one list: its name and summary from DESIGN.md, where it's
// published (the agent's Artifact, the Google Doc), the specs it builds on, and where the work
// stands for you, so design docs waiting for review are easy to find and read.

import { issueOf, stageOf, GROUPS } from './issues.js';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The name ("# Design: <name>") and the Summary section's text from DESIGN.md. */
export function designOutline(markdown) {
  const md = String(markdown ?? '');
  const title = md.match(/^#\s+(?:Design:\s*)?(.+)$/m)?.[1]?.trim() ?? null;
  const summary = md.match(/^##\s+Summary\s*\n+([\s\S]*?)(?=\n#{1,3}\s|(?![\s\S]))/m)?.[1] ?? '';
  // Plain text: no Markdown emphasis, links or code fences.
  const plain = summary
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '');
  return { title: title ? clip(title, 120) : null, summary: clip(plain, 400) || null };
}

/**
 * The list's rows: one per agent with a design doc (written, published or asked for).
 * `read(agentId)` gives the agent's DESIGN.md text, or null.
 */
export function designRows(views, read) {
  const rank = Object.fromEntries(Object.keys(GROUPS).map((k, i) => [k, i]));
  const rows = [];
  for (const v of views) {
    if (v.kind === 'assistant' || v.kind === 'general') continue;
    const refs = v.brief?.references ?? [];
    const pageRef = refs.find((r) => /design page/i.test(r.label));
    const google = v.drive?.files?.designdoc?.url ?? null;
    const written = v.specDocs?.designdoc ?? null;
    if (!written && !pageRef && !google) continue;
    const outline = written ? designOutline(read(v.id)) : { title: null, summary: null };
    const issue = issueOf(v);
    const { stage, note } = stageOf(v);
    rows.push({
      agent: { id: v.id, name: v.name, project: v.projectInfo?.name ?? null, running: Boolean(v.runtime?.running), busy: Boolean(v.runtime?.busy) },
      title: outline.title ?? v.synopsis?.text ?? v.name,
      summary: outline.summary,
      written: Boolean(written),
      updatedAt: written ?? v.drive?.files?.designdoc?.at ?? v.activeAt ?? null,
      page: pageRef?.url ? { url: pageRef.url } : pageRef?.highlight ? { note: clip(pageRef.highlight, 160) } : null,
      google,
      // The specs it builds on: PRDs, tech specs and other key documents in the brief.
      specs: refs.filter((r) => r.key && r.url && r !== pageRef).slice(0, 4).map((r) => ({ label: r.label, title: r.title, url: r.url })),
      issue: issue ? { key: issue.key, url: issue.url } : null,
      stage,
      group: GROUPS[stage],
      note: clip(note, 200),
    });
  }
  return rows.sort((a, b) => rank[a.stage] - rank[b.stage] || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

/** The rows as a Markdown list, to paste. */
export function designsMarkdown(rows) {
  if (!rows.length) return 'No design docs.';
  const link = (label, url) => (url ? `[${label}](${url})` : null);
  return rows
    .map((r) => {
      const head = `- **${r.title}**${r.issue ? ` (${link(r.issue.key, r.issue.url) ?? r.issue.key})` : ''}: ${r.note}`;
      const links = [link('Design page', r.page?.url), link('Google Doc', r.google), ...r.specs.map((s) => link(s.label, s.url))].filter(Boolean);
      return [head, r.summary ? `  ${r.summary}` : null, links.length ? `  ${links.join(' · ')}` : null].filter(Boolean).join('\n');
    })
    .join('\n');
}
