// The standup player: the day's standup read aloud, one agent at a time, each in its own voice.
// When an agent needs you it stops on it with its questions beside it, answered by tap (the
// inbox's own cards) or, when turned on, by voice: what you say is read back and sent on "send".

import { canSpeak, cycleRate, pause, play, rateLabel, resume, stop, now as speaking } from '/speak.js';
import { choiceFor } from '/voice.js';

const VOICE_KEY = 'agentmgr.standupVoice';
const PLAY_ID = 'standup';
const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

// macOS's joke and singing voices: not for a standup.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export function initStandup({ api, $, esc, agents, needsFor, needCard, onNeed, toast, openAgent }) {
  const dialog = $('#standup-dialog');
  const body = $('#standup-body');
  let latest = null;
  let settings = null;
  let idx = -1; // -1: the intro
  let state = 'stopped'; // playing | paused | waiting | stopped | done
  let heard = null; // { text, action: { label, run } } waiting for "send"
  let listening = null;
  let voiceOn = false;
  try {
    voiceOn = localStorage.getItem(VOICE_KEY) === '1';
  } catch {}

  // Each agent keeps one voice of the page's language; the intro uses the default.
  let voices = [];
  const loadVoices = () => {
    if (!canSpeak()) return;
    const lang = (navigator.language || 'en').slice(0, 2);
    voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith(lang) && !NOVELTY.test(v.name));
  };
  if (canSpeak()) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }
  const voiceFor = (id) => (voices.length > 1 ? voices[hash(id) % voices.length] : null);

  const items = () => latest?.items ?? [];
  const current = () => items()[idx] ?? null;
  const needsNow = (it) => {
    const a = it && agents.get(it.agentId);
    return a ? needsFor(a) : [];
  };

  function set(next) {
    latest = next;
    $('#standup-dot').hidden = !latest?.items?.length || seenAt() === latest.at;
    if (dialog.open) render();
  }
  const seenAt = () => {
    try {
      return localStorage.getItem('agentmgr.standupSeen');
    } catch {
      return null;
    }
  };
  const markSeen = () => {
    try {
      localStorage.setItem('agentmgr.standupSeen', latest?.at ?? '');
    } catch {}
    $('#standup-dot').hidden = true;
  };

  async function load() {
    const v = await api('GET', '/standup');
    settings = v.settings;
    set(v.latest);
  }

  async function open({ fresh = false } = {}) {
    if (!dialog.open) dialog.showModal();
    try {
      if (!latest || fresh) {
        body.innerHTML = '<p class="hint standup-making">Putting the standup together…</p>';
        const v = await api(fresh || !latest ? 'POST' : 'GET', '/standup');
        settings = v.settings;
        set(v.latest);
      } else if (!settings) await load();
    } catch (e) {
      body.innerHTML = `<p class="hint error">${esc(e.message)}</p>`;
      return;
    }
    markSeen();
    playFrom(-1);
  }

  function close() {
    stop(false);
    stopListening();
    state = 'stopped';
    if (dialog.open) dialog.close();
  }

  /** Read item `i` (-1: the intro), then go on, or stop on an agent that needs you. */
  function playFrom(i) {
    idx = Math.max(-1, Math.min(i, items().length));
    heard = null;
    stopListening();
    if (idx >= items().length) {
      state = 'done';
      render();
      return play(PLAY_ID, ["That's everything."], {});
    }
    const it = current();
    const text = it ? `${it.name}. ${it.text}` : latest?.intro ?? '';
    state = 'playing';
    render();
    const started = play(PLAY_ID, [{ text, voice: it ? voiceFor(it.agentId) : null }], {
      onEnd: () => {
        if (!dialog.open) return;
        if (it && needsNow(it).length) {
          state = 'waiting';
          render();
          if (voiceOn) listen();
        } else setTimeout(() => dialog.open && state === 'playing' && idx === i && playFrom(i + 1), 500);
      },
    });
    // No speech here: show it, and let the arrows move on.
    if (!started) {
      state = it && needsNow(it).length ? 'waiting' : 'paused';
      render();
    }
  }

  function toggle() {
    const s = speaking();
    if (s?.id === PLAY_ID && !s.paused) {
      pause();
      state = 'paused';
    } else if (s?.id === PLAY_ID && s.paused) {
      resume();
      state = 'playing';
    } else return playFrom(state === 'done' ? -1 : idx);
    render();
  }

  // ------------------------------------------------------------ answering by voice

  /** What saying `text` does for this agent's first need: { label, run } or null. */
  function actionFor(it, text) {
    const a = agents.get(it.agentId);
    const need = needsNow(it)[0];
    if (!a || !need) return null;
    const t = text.trim();
    if (need.kind === 'prompt') {
      const choices = a.runtime.prompt?.choices ?? [];
      const key = choiceFor(t, choices);
      const c = choices.find((x) => x.key === key);
      return c ? { label: `choose “${c.label}”`, run: () => api('POST', `/agents/${a.id}/prompt-key`, { key }) } : null;
    }
    if (need.kind === 'question') return { label: `answer “${t}”`, run: () => api('POST', `/agents/${a.id}/answer`, { question: need.q.id, text: t }) };
    if (need.kind === 'waiting') return { label: `reply “${t}”`, run: () => api('POST', `/agents/${a.id}/waiting/answer`, { text: t }) };
    if (need.kind === 'plan' && /\b(approve|looks good|go ahead|ship it)\b/i.test(t)) return { label: 'approve its plan', run: () => api('POST', `/agents/${a.id}/plan/approve`, {}) };
    return { label: `tell it “${t}”`, run: () => api('POST', `/agents/${a.id}/tell`, { text: t }) };
  }

  function stopListening() {
    try {
      listening?.abort();
    } catch {}
    listening = null;
  }

  /** Listen once: an answer, or, with one read back, "send" or "cancel". */
  function listen() {
    if (!Recognition || listening) return;
    stop(false);
    const it = current();
    const r = new Recognition();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.maxAlternatives = 1;
    let text = '';
    r.onresult = (e) => {
      text = [...e.results].map((x) => x[0].transcript).join(' ');
      const live = $('#standup-heard-live');
      if (live) live.textContent = text;
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone blocked: allow it for this page, or answer with the buttons', 6000);
    };
    r.onend = () => {
      listening = null;
      if (!dialog.open || current() !== it) return render();
      text = text.trim();
      if (heard && text) {
        if (/\b(send|yes|confirm|do it|go)\b/i.test(text)) return send();
        if (/\b(cancel|no|stop|wait)\b/i.test(text)) {
          heard = null;
          return render();
        }
      } else if (text) {
        const action = actionFor(it, text);
        if (!action) {
          play(PLAY_ID, ["Sorry, I didn't catch a choice. Say yes, no, or the option's number."], {});
          return render();
        }
        heard = { text, action };
        render();
        // Read it back, then listen for "send".
        return play(PLAY_ID, [`I'll ${action.label} for ${it.name}. Say send, or cancel.`], { onEnd: () => dialog.open && heard && listen() });
      }
      render();
    };
    listening = r;
    try {
      r.start();
    } catch {
      listening = null;
    }
    render();
  }

  async function send() {
    const it = current();
    const h = heard;
    heard = null;
    if (!h || !it) return render();
    try {
      await h.action.run();
      toast(`Sent to ${it.name}`);
      play(PLAY_ID, ['Sent.'], { onEnd: () => dialog.open && playFrom(idx + 1) });
    } catch (e) {
      toast(e.message, 6000);
    }
    render();
  }

  // ------------------------------------------------------------ drawing

  function render() {
    if (!dialog.open) return;
    if (!latest) return;
    const list = items();
    const it = current();
    const when = new Date(latest.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const chips = [`<button class="standup-chip ${idx === -1 ? 'on' : ''}" data-su="go" data-i="-1">Intro</button>`, ...list.map((x, i) => `<button class="standup-chip ${i === idx ? 'on' : ''} ${needsNow(x).length ? 'needs' : ''}" data-su="go" data-i="${i}" title="${esc(x.text)}">${esc(x.name)}</button>`)].join('');
    const needs = it ? needsNow(it) : [];
    const card = it
      ? `<div class="standup-card">
          <h3><button class="link" data-su="open" title="Open this agent">${esc(it.name)}</button>${it.project ? ` <span class="hint">${esc(it.project)}</span>` : ''}</h3>
          <p class="standup-text">${esc(it.text)}</p>
          ${needs.length ? `<div class="standup-needs">${needs.map((n) => needCard(n, { inDetail: true })).join('')}</div>` : '<p class="hint">Nothing needed from you.</p>'}
          ${needs.length && Recognition && voiceOn
            ? `<div class="standup-voice">
                <button class="${listening ? 'primary listening' : ''}" data-su="mic" title="Say your answer: yes, no, an option's number, or a reply">${listening ? '● Listening…' : '🎤 Answer by voice'}</button>
                <span id="standup-heard-live" class="hint"></span>
                ${heard ? `<div class="standup-heard">I'll ${esc(heard.action.label)} for <b>${esc(it.name)}</b>. <button class="small primary" data-su="send">Send</button> <button class="small" data-su="cancel">Cancel</button></div>` : ''}
              </div>`
            : ''}
        </div>`
      : idx >= list.length
        ? `<div class="standup-card"><p class="standup-text">That's everything.</p><p class="hint">${list.filter((x) => needsNow(x).length).length ? 'Some agents still need you: pick one above.' : 'Nothing is waiting on you.'}</p></div>`
        : `<div class="standup-card"><p class="standup-text">${esc(latest.intro)}</p><p class="hint">Since ${esc(new Date(latest.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}${latest.ai ? '' : ' · plain wording'}</p></div>`;
    const playingNow = speaking()?.id === PLAY_ID && !speaking()?.paused;
    body.innerHTML = `
      <div class="standup-top"><b>Standup</b> <span class="hint">${esc(when)} · ${list.length} agent${list.length === 1 ? '' : 's'}</span><span class="spacer"></span>
        <button class="small" data-su="fresh" title="A new standup with what's happened since this one">↻ New</button>
        <button class="small" data-su="close">Close</button></div>
      <div class="standup-chips">${chips}</div>
      ${card}
      <div class="standup-controls">
        <button data-su="prev" title="Previous" ${idx <= -1 ? 'disabled' : ''}>⏮</button>
        <button class="primary" data-su="play" title="${playingNow ? 'Pause' : 'Play'}" ${canSpeak() ? '' : 'disabled'}>${playingNow ? '⏸' : '▶'}</button>
        <button data-su="next" title="Next" ${idx >= list.length ? 'disabled' : ''}>⏭</button>
        <button class="small" data-su="rate" title="Speed">${esc(rateLabel())}</button>
        <span class="spacer"></span>
        ${Recognition ? `<label class="check" title="Answer agents by speaking. Your browser may send the audio to its maker to turn it into text."><input type="checkbox" data-su="voice" ${voiceOn ? 'checked' : ''}> Answer by voice</label>` : ''}
      </div>
      ${settings ? `<details class="standup-settings"><summary>Daily at ${esc(settings.at)}${settings.enabled ? '' : ' (off)'}</summary>
        <label class="check"><input type="checkbox" data-su-set="enabled" ${settings.enabled ? 'checked' : ''}> A standup every ${settings.weekends ? 'day' : 'weekday'} at <input type="time" data-su-set="at" value="${esc(settings.at)}"></label>
        <label class="check"><input type="checkbox" data-su-set="weekends" ${settings.weekends ? 'checked' : ''}> Weekends too</label>
        <label class="check"><input type="checkbox" data-su-set="ai" ${settings.ai ? 'checked' : ''}> Worded by AI (one short call; off: plain wording)</label>
        <label class="check"><input type="checkbox" data-su-set="notify" ${settings.notify ? 'checked' : ''}> Alert me when it's ready (Slack, with Alerts on)</label>
      </details>` : ''}`;
  }

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-need]')) return onNeed(e);
    const el = e.target.closest('[data-su]');
    if (!el) return;
    const what = el.dataset.su;
    if (what === 'voice') return;
    e.preventDefault();
    if (what === 'close') return close();
    if (what === 'fresh') return open({ fresh: true });
    if (what === 'play') return toggle();
    if (what === 'prev') return playFrom(idx - 1);
    if (what === 'next') return playFrom(idx + 1);
    if (what === 'go') return playFrom(Number(el.dataset.i));
    if (what === 'rate') {
      cycleRate();
      return render();
    }
    if (what === 'open') {
      const id = current()?.agentId;
      close();
      return id && openAgent(id);
    }
    if (what === 'mic') return listening ? stopListening() || render() : listen();
    if (what === 'send') return send();
    if (what === 'cancel') {
      heard = null;
      return render();
    }
  });
  body.addEventListener('change', async (e) => {
    if (e.target.dataset.su === 'voice') {
      voiceOn = e.target.checked;
      try {
        localStorage.setItem(VOICE_KEY, voiceOn ? '1' : '0');
      } catch {}
      if (voiceOn) toast('Voice answers on. Your browser may send what you say to its maker to turn it into text', 6000);
      return render();
    }
    const key = e.target.dataset.suSet;
    if (!key) return;
    try {
      settings = (await api('PUT', '/standup', { [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })).settings;
    } catch (err) {
      toast(err.message, 5000);
    }
    render();
  });
  dialog.addEventListener('close', () => {
    stop(false);
    stopListening();
    state = 'stopped';
  });

  // Answering on another device (or here) clears the need: an agent you were stopped on moves on.
  function agentChanged() {
    if (!dialog.open) return;
    const it = current();
    if (state === 'waiting' && it && !needsNow(it).length && !heard) return playFrom(idx + 1);
    // Typing a reply in one of its cards: don't redraw under it.
    if (body.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    render();
  }

  $('#standup-btn').onclick = () => open();
  load().catch(() => {});
  return { open, set, render: agentChanged, isOpen: () => dialog.open };
}
