// How the page talks to the daemon. Locally: WebSockets. Over remote HTTPS:
// Server-Sent Events plus POSTs, because iOS Safari applies an accepted
// self-signed certificate to pages and fetches but not to WebSockets.

export const REMOTE = location.protocol === 'https:';

export const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1' },
    body: JSON.stringify(body ?? {}),
  });

/**
 * Open the event stream (`{ events: true }`) or a terminal (`{ agentId, kind }`).
 * Handlers: onOpen(), onMessage(msg), onClose({ code, reason }) when it ends for good, and
 * onInputLost(text) when typing could not be delivered (remote only).
 * Returns { send(msg), close() } where msg is { t: 'i', d } (input) or { t: 'r', cols, rows } (resize).
 */
export function openStream({ events = false, agentId, kind = 'claude' }, h) {
  if (!REMOTE) {
    const path = events ? '/ws/events' : `/ws/term/${agentId}${kind === 'claude' ? '' : `?kind=${encodeURIComponent(kind)}`}`;
    const ws = new WebSocket(`ws://${location.host}${path}`);
    ws.onopen = () => h.onOpen?.();
    ws.onmessage = (ev) => h.onMessage(JSON.parse(ev.data));
    ws.onclose = (ev) => h.onClose?.({ code: ev.code, reason: ev.reason });
    return {
      send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
    };
  }

  const url = events ? '/api/events/stream' : `/api/agents/${agentId}/term/stream?kind=${encodeURIComponent(kind)}`;
  const es = new EventSource(url);
  let closed = false;
  es.onopen = () => h.onOpen?.();
  es.onmessage = (ev) => h.onMessage(JSON.parse(ev.data));
  es.onerror = () => {
    // CONNECTING means the browser is retrying by itself (network blip); CLOSED is final (e.g. 401).
    if (es.readyState === EventSource.CLOSED && !closed) {
      closed = true;
      h.onClose?.({ code: 0, reason: 'stream closed' });
    }
  };

  // Keystrokes: coalesced and sent strictly in order, one request at a time. A request that fails
  // (a network blip, a phone waking up) is retried, not dropped: losing a line of a paste would run
  // the rest without it.
  let queue = '';
  let inflight = false;
  const deliver = async (d) => {
    for (let attempt = 0; attempt < 6 && !closed; attempt++) {
      try {
        const res = await post(`/api/agents/${agentId}/term/input`, { d, kind });
        // A refusal (signed out, terminal gone) won't change on a retry.
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) return res.ok;
      } catch {
        // Offline for a moment; try again.
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    return false;
  };
  const pump = async () => {
    if (inflight || !queue) return;
    inflight = true;
    const d = queue;
    queue = '';
    try {
      if (!(await deliver(d)) && !closed) h.onInputLost?.(d);
    } finally {
      inflight = false;
      if (queue) pump();
    }
  };
  let resizeTimer;
  return {
    send(msg) {
      if (closed) return;
      if (msg.t === 'i') {
        queue += msg.d;
        setTimeout(pump, 8);
      } else if (msg.t === 'r') {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => post(`/api/agents/${agentId}/term/resize`, { cols: msg.cols, rows: msg.rows, kind }), 150);
      }
    },
    close() {
      closed = true;
      es.close();
    },
  };
}
