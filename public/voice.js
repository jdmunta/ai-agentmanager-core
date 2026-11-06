// What a spoken answer means: shared by the standup player (and testable without a browser).

const WORDS = { one: '1', first: '1', two: '2', second: '2', three: '3', third: '3', four: '4', fourth: '4' };

/** What a spoken answer means for a prompt's menu: the choice's key, or null. */
export function choiceFor(text, choices = []) {
  const t = String(text).toLowerCase().trim();
  const n = t.match(/\b(?:option|number|choice)?\s*(\d|one|two|three|four|first|second|third|fourth)\b/)?.[1];
  const key = n ? WORDS[n] ?? n : null;
  if (key && choices.some((c) => c.key === key)) return key;
  const yes = /\b(yes|yeah|yep|allow|approve|go ahead|sure|ok(ay)?)\b/.test(t);
  const no = /\b(no|nope|deny|don't|do not|stop)\b/.test(t);
  if (yes && !no) return choices.find((c) => /^yes\b/i.test(c.label))?.key ?? null;
  if (no && !yes) return choices.find((c) => /^no\b/i.test(c.label))?.key ?? null;
  return null;
}
