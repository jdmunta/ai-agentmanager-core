// Reporting to AI Agent Manager: the agent says who it is, sends each run (status, cost, result)
// and its open approvals, and picks up the decisions people made there. It checks in every 30
// seconds (every 2 while an approval waits), and right away after a run or a new approval.
import https from 'node:https';
import os from 'node:os';

const EXCERPT = 2000;

/**
 * POST JSON over https to a server with a self-signed certificate (AI Agent Manager's remote
 * access), trusting only the certificate whose SHA-256 fingerprint is `pin`. The body is sent only
 * after the fingerprint matches.
 */
export function pinnedPost(url, { headers, body, pin, timeoutMs = 15_000 }) {
  const want = String(pin).replace(/:/g, '').toLowerCase();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, rejectUnauthorized: false, agent: false, timeout: timeoutMs }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) }));
    });
    req.on('socket', (sock) =>
      sock.once('secureConnect', () => {
        const got = sock.getPeerX509Certificate?.()?.fingerprint256.replace(/:/g, '').toLowerCase();
        if (got !== want) return req.destroy(new Error('the certificate does not match AGENTKIT_REPORT_CERT'));
        req.end(body);
      }),
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

export function startReporting(agent, { url, token, cert = null, chat = () => null, version = null, log = () => {}, fetchImpl = fetch, everyMs = 30_000, fastMs = 2_000 }) {
  const endpoint = `${url.replace(/\/+$/, '')}/api/agentkit/report`;
  const post = cert && endpoint.startsWith('https:') ? (u, o) => pinnedPost(u, { headers: o.headers, body: o.body, pin: cert }) : fetchImpl;
  const startedAt = new Date().toISOString();
  let unsent = []; // runs not yet acknowledged
  let timer = null;
  let busy = false;
  let again = false;
  let ok = null;
  let stopped = false;

  const onRun = (r) => {
    unsent = [...unsent, { id: r.id, status: r.status, source: r.source, costUsd: r.costUsd, ms: r.ms, result: String(r.result ?? '').slice(0, EXCERPT), at: new Date().toISOString() }].slice(-50);
    push();
  };
  const onApprovals = () => push();
  agent.on('run', onRun);
  agent.on('approvals', onApprovals);

  async function push() {
    if (stopped) return;
    if (busy) return void (again = true);
    busy = true;
    clearTimeout(timer);
    const s = agent.spec;
    const sending = unsent;
    const body = {
      agent: { name: s.name, title: s.title, description: s.description, engine: s.engine, triggers: s.triggers.map((t) => t.label), host: os.hostname(), pid: process.pid, chat: chat(), version, startedAt },
      current: agent.current,
      runs: sending,
      pending: agent.approvals.pending(),
    };
    try {
      const res = await post(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(res.status === 401 ? 'the report token was not accepted' : `HTTP ${res.status}`);
      const reply = await res.json();
      unsent = unsent.filter((r) => !sending.includes(r));
      for (const d of reply.decisions ?? []) agent.approvals.decide(d.id, d.allow, { by: d.by ?? 'AI Agent Manager', note: d.note ?? '' });
      agent.approvals.channels.add('manager');
      if (ok !== true) log(`reporting to AI Agent Manager at ${url}`);
      ok = true;
    } catch (e) {
      agent.approvals.channels.delete('manager');
      if (ok !== false) log(`could not report to AI Agent Manager (${e.message}); trying again`);
      ok = false;
    } finally {
      busy = false;
      if (!stopped) {
        if (again) (again = false), setImmediate(push);
        else timer = setTimeout(push, agent.approvals.pending().length ? fastMs : everyMs);
      }
    }
  }

  push();
  // `push()` checks in now (say, once the chat page is up); `stop()` ends reporting.
  return {
    push,
    /** Wait (a few seconds at most) until every run is sent: before a one-off run exits. */
    flush: async (ms = 5000) => {
      for (const end = Date.now() + ms; (unsent.length || busy) && Date.now() < end; ) {
        if (!busy) push();
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      agent.off('run', onRun);
      agent.off('approvals', onApprovals);
    },
  };
}
