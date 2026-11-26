// What looks like a key or token: the kinds the quality bar (standards.js) and a proposed skill (skills.js) are checked for.

export const SECRETS = [
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ['an OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe live key', /\b[sr]k_live_[0-9a-zA-Z]{20,}/],
];

/** The kinds of secret a text looks like it has ('a GitHub token', …); the text itself is never kept. */
export const secretsIn = (text = '') => SECRETS.filter(([, re]) => re.test(String(text))).map(([kind]) => kind);
