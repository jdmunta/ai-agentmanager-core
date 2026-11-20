// The stand-in models' reply to a claims check (src/claims.js), shared by the fake engines.
// Every line of the text that says something is a statement. One with "#wrong" is contradicted,
// "#invented" gets a quote that is in no source, "#opinion" is an opinion; the rest are backed by
// the first line, in the first source that has it, with the statement's first longer word. The
// checker also invents a statement of its own. "#nocheck" in the text fails the call (null).
export function claimsReply(input) {
  const text = input.match(/<text name="[^"]*">\n([\s\S]*?)\n<\/text>/)?.[1] ?? '';
  if (text.includes('#nocheck')) return null;
  const sources = [...input.matchAll(/<source id="(S\d+)" name="([^"]*)">\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ id: m[1], name: m[2], text: m[3] }));
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[\s>*#-]+/, '').replace(/\*+(?=:)/, '').trim())
    .filter((l) => /[a-z]{4}/i.test(l) && !/^(slack|email|status):?/i.test(l))
    .slice(0, 12);
  const claims = lines.map((l) => {
    if (l.includes('#opinion')) return { text: l, verdict: 'opinion' };
    if (l.includes('#invented')) return { text: l, verdict: 'backed', source: 'S1', quote: 'a quote that is in no source at all' };
    const word = l.match(/[A-Za-z]{4,}/)[0];
    const src = sources.find((x) => x.text.includes(word));
    const quote = src?.text.split('\n').find((x) => x.includes(word))?.trim().slice(0, 150);
    if (!quote) return { text: l, verdict: 'not_backed' };
    return { text: l, verdict: l.includes('#wrong') ? 'contradicted' : 'backed', source: src.id, quote };
  });
  return { claims: [...claims, { text: 'A statement the checker made up', verdict: 'backed', source: 'S1', quote: sources[0]?.text.slice(0, 20) }] };
}
