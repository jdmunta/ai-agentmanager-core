// The agent over HTTP: a chat page for people, a small API for apps, webhooks for triggers, and
// A2A (the agent-to-agent protocol: an agent card, and tasks over JSON-RPC) for other agents.
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The A2A agent card: who the agent is and how to reach it. */
export function agentCard(agent, base) {
  const s = agent.spec;
  return {
    protocolVersion: '0.3.0',
    name: s.title,
    description: s.description || s.goal,
    url: `${base}/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: s.name, name: s.title, description: s.goal, tags: [s.engine] }],
  };
}

const taskOf = (t) => ({
  kind: 'task',
  id: t.id,
  contextId: t.contextId,
  status: { state: t.state, timestamp: t.at, ...(t.result != null ? { message: { kind: 'message', role: 'agent', messageId: `${t.id}-r`, parts: [{ kind: 'text', text: t.result }] } } : {}) },
  ...(t.result != null && t.state === 'completed' ? { artifacts: [{ artifactId: `${t.id}-a`, parts: [{ kind: 'text', text: t.result }] }] } : {}),
});

const PAGE = (agent) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(agent.spec.title)}</title><style>
:root{--bg:#f6f7f9;--panel:#fff;--text:#1c2330;--muted:#667085;--border:#dde1e7;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f14;--panel:#151821;--text:#e5e8ef;--muted:#8b93a7;--border:#2a2f3c;--accent:#6d8bff}}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100vh}
header{padding:12px 16px;border-bottom:1px solid var(--border);background:var(--panel)}header b{font-size:16px}header p{margin:2px 0 0;color:var(--muted);font-size:13px}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.m{max-width:760px;padding:10px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}.you{align-self:flex-end;background:var(--accent);color:#fff}.agent{background:var(--panel);border:1px solid var(--border)}
#ap{display:flex;flex-direction:column;gap:8px;padding:0 16px}#ap:not(:empty){padding:12px 16px;border-bottom:1px solid var(--border)}.ap{padding:10px 12px;border-radius:10px;border:1px solid #e8a33d;background:var(--panel)}.ap pre{margin:6px 0;font-size:12px;white-space:pre-wrap;max-height:160px;overflow:auto}.ap .no{background:transparent;color:var(--text);border:1px solid var(--border)}
.step{font-size:12px;color:var(--muted)}form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);background:var(--panel)}
textarea{flex:1;resize:none;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:inherit}button{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:var(--accent);color:#fff}
</style></head><body><header><b>${esc(agent.spec.title)}</b><p>${esc(agent.spec.description || agent.spec.goal)}</p></header>
<div id="ap"></div><div id="log"></div><form id="f"><textarea id="t" rows="2" placeholder="Ask or tell the agent…"></textarea><button>Send</button></form>
<script>
const log=document.getElementById('log');const conv=localStorage.getItem('conv')||crypto.randomUUID();localStorage.setItem('conv',conv);
const add=(cls,text)=>{const d=document.createElement('div');d.className='m '+cls;d.textContent=text;log.append(d);log.scrollTop=log.scrollHeight;return d};
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const t=document.getElementById('t');const text=t.value.trim();if(!text)return;t.value='';add('you',text);
const wait=add('agent step','Working on it…');const r=await fetch('api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:text,conversation:conv})}).then(r=>r.json()).catch(e=>({error:e.message}));
wait.remove();add('agent',r.result??('Error: '+r.error))};
const ap=document.getElementById('ap');const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
async function approvals(){const l=await fetch('api/approvals').then(r=>r.json()).catch(()=>[]);ap.innerHTML=l.map(a=>'<div class="ap"><b>Approve '+esc(a.tool)+'?</b> <span class="step">asked '+new Date(a.at).toLocaleTimeString()+'</span><pre>'+esc(JSON.stringify(a.input,null,2))+'</pre><button data-id="'+esc(a.id)+'" data-allow="1">Approve</button> <button class="no" data-id="'+esc(a.id)+'">Deny</button></div>').join('')}
ap.onclick=async(e)=>{const b=e.target.closest('button[data-id]');if(!b)return;b.disabled=true;await fetch('api/approvals/'+b.dataset.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allow:!!b.dataset.allow})});approvals()};
approvals();setInterval(approvals,2000);
document.getElementById('t').onkeydown=(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('f').requestSubmit()}};
</script></body></html>`;

/** Start the HTTP side; resolves with { server, url, close }. */
export function startHttp(agent, { port, host = '127.0.0.1', log = () => {} } = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const tasks = new Map(); // A2A task id -> { id, contextId, state, result, at }
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).then((v) => v !== undefined && res.json(v)).catch((err) => res.status(err.status ?? 500).json({ error: err.message }));

  app.get('/', (req, res) => res.type('html').send(PAGE(agent)));
  app.get('/api/health', (req, res) => res.json({ ok: true, agent: agent.spec.name, engine: agent.spec.engine, running: agent.current, triggers: agent.spec.triggers.map((t) => t.label) }));
  app.post('/api/chat', wrap(async (req) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) throw Object.assign(new Error('message is required'), { status: 400 });
    return agent.run(message, { source: 'chat', conversation: String(req.body?.conversation ?? '').slice(0, 80) || crypto.randomUUID() });
  }));
  // Tools waiting for a person's approval, and their answers (JSON only: a page elsewhere can't post here).
  app.get('/api/approvals', wrap(() => agent.approvals.pending()));
  app.post('/api/approvals/:id', wrap((req) => {
    if (!req.is('application/json') || typeof req.body?.allow !== 'boolean') throw Object.assign(new Error('Send {"allow": true|false}'), { status: 400 });
    if (!agent.approvals.decide(req.params.id, req.body.allow, { by: 'the chat page', note: String(req.body.note ?? '') })) throw Object.assign(new Error('Already decided'), { status: 409 });
    return { ok: true };
  }));
  agent.approvals.channels.add('chat');
  app.post('/api/runs', wrap((req) => agent.run(String(req.body?.input ?? ''), { source: 'api' })));
  app.get('/api/runs', wrap(() => agent.runs()));
  app.get('/api/runs/:id', wrap((req) => agent.runLog(req.params.id) ?? Promise.reject(Object.assign(new Error('No such run'), { status: 404 }))));

  // Webhook triggers: the body (JSON or text) is the run's input.
  for (const t of agent.spec.triggers.filter((x) => x.kind === 'webhook')) {
    app.post(t.path, express.text({ type: () => true, limit: '2mb' }), wrap(async (req) => {
      const run = agent.run(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), { source: t.label });
      run.catch(() => {});
      return { accepted: true };
    }));
    log(`trigger: ${t.label}`);
  }

  // A2A.
  if (agent.spec.interfaces.a2a) {
    app.get('/.well-known/agent.json', (req, res) => res.json(agentCard(agent, `http://${req.headers.host}`)));
    app.get('/.well-known/agent-card.json', (req, res) => res.json(agentCard(agent, `http://${req.headers.host}`)));
    app.post('/a2a', async (req, res) => {
      const { id, method, params = {} } = req.body ?? {};
      const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
      const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
      if (method === 'message/send') {
        const msg = params.message ?? {};
        const text = (msg.parts ?? []).filter((p) => p.kind === 'text' || p.type === 'text').map((p) => p.text).join('\n').trim();
        if (!text) return fail(-32602, 'message.parts needs a text part');
        const t = { id: crypto.randomUUID(), contextId: msg.contextId ?? crypto.randomUUID(), state: 'working', result: null, at: new Date().toISOString() };
        tasks.set(t.id, t);
        const r = await agent.run(text, { source: 'a2a', conversation: `a2a:${t.contextId}` });
        Object.assign(t, { state: r.status === 'failed' ? 'failed' : 'completed', result: r.result, at: new Date().toISOString() });
        return reply(taskOf(t));
      }
      if (method === 'tasks/get') {
        const t = tasks.get(params.id);
        return t ? reply(taskOf(t)) : fail(-32001, 'Task not found');
      }
      return fail(-32601, `Method not found: ${method}`);
    });
  }

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}`;
      log(`chat and API: ${url}${agent.spec.interfaces.a2a ? `  ·  A2A card: ${url}/.well-known/agent.json` : ''}`);
      resolve({ server, url, close: () => (agent.approvals.channels.delete('chat'), new Promise((r) => server.close(r))) });
    });
  });
}
