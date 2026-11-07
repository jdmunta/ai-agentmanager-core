// Listening instead of reading: Explain, the documents and the change walkthrough read aloud with
// the browser's own speech (on-device voices only unless you pick an online one; it works on
// phones). The clearest voice here is used, never the robotic or novelty ones. Text goes in short
// pieces, since some browsers stop a long utterance partway. One thing plays at a time.

const RATES = [0.85, 1, 1.25, 1.5, 1.75];
const RATE_KEY = 'agentmgr.speechRate';
const VOICE_KEY = 'agentmgr.voice';

// Voices that sound robotic or are made for fun: macOS's old and Eloquence voices, and its
// novelty ones. Not used unless chosen by name.
const ROBOTIC = /^(Albert|Bad News|Bahh|Bells|Boing|Bruce|Bubbles|Cellos|Deranged|Eddy|Flo|Fred|Good News|Grandma|Grandpa|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Princess|Ralph|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Vicki|Victoria|Whisper|Wobble|Zarvox)\b/i;
// Clear, natural voices: the downloadable high-quality ones, Siri's, Edge's neural and Google's.
const NATURAL = /\b(Premium|Enhanced|Siri|Natural|Neural|Online)\b|^Google /i;
const CLEAR = /^(Samantha|Alex|Ava|Allison|Susan|Tom|Karen|Daniel|Moira|Tessa|Serena|Zoe|Evan|Nathan|Joelle|Noelle|Aaron|Nicky|Rishi|Veena|Lee)\b/i;

/**
 * How good a voice sounds for reading aloud in `lang` ("en-US"); below 0 means don't use it.
 * Online voices (Chrome's Google ones) send the text to their maker, so they count only when
 * `online` (you pick one by name).
 */
export function voiceScore(v, lang = 'en-US', { online = false } = {}) {
  const want = String(lang).toLowerCase();
  const have = String(v?.lang ?? '').toLowerCase().replace('_', '-');
  if (!have.startsWith(want.slice(0, 2)) || ROBOTIC.test(v.name ?? '')) return -1;
  if (v.localService === false && !online) return -1;
  return (NATURAL.test(v.name) ? 6 : 0) + (CLEAR.test(v.name) ? 3 : 0) + (have === want ? 2 : 0) + (v.default ? 1 : 0);
}

/** The voices worth using for `lang`, best first. */
export function rankVoices(voices = [], lang = 'en-US', opts = {}) {
  return voices
    .map((v) => ({ v, s: voiceScore(v, lang, opts) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || String(a.v.name).localeCompare(String(b.v.name)))
    .map((x) => x.v);
}

const lang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

/** This browser's good voices for the page's language, best first (`online`: those too). */
export function goodVoices(opts = {}) {
  return canSpeak() ? rankVoices(speechSynthesis.getVoices(), lang(), opts) : [];
}

/** The voice you picked (by name), or null for "the best one here". */
export function chosenVoice() {
  try {
    return localStorage.getItem(VOICE_KEY) || null;
  } catch {
    return null;
  }
}

export function setVoice(name) {
  try {
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
  } catch {}
  notify();
}

/** The voice to read with when none is given: yours, else the best one here. */
export function preferredVoice() {
  if (!canSpeak()) return null;
  const name = chosenVoice();
  const all = speechSynthesis.getVoices();
  return (name && all.find((v) => v.name === name)) || goodVoices()[0] || null;
}

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

/** Markdown as something to say: no code, diagrams, links' addresses or markup. */
export function speakable(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#{1,6}\s+(.*)$/gm, '$1.')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Text in pieces of a few sentences (under ~220 characters), on paragraph and sentence breaks. */
export function pieces(text, max = 220) {
  const out = [];
  for (const para of String(text).split(/\n\s*\n|\n/)) {
    const sentences = para.match(/[^.!?]+[.!?]*\s*/g) ?? [];
    let cur = '';
    for (const s of sentences) {
      if ((cur + s).length > max && cur) {
        out.push(cur.trim());
        cur = '';
      }
      cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.filter((p) => /\w/.test(p));
}

let session = null; // { id, parts: [{ text, onStart }], i, paused, onEnd, onState }

function rate() {
  try {
    const r = Number(localStorage.getItem(RATE_KEY));
    return RATES.includes(r) ? r : 1;
  } catch {
    return 1;
  }
}

function playNext() {
  const s = session;
  if (!s) return;
  if (s.i >= s.parts.length) return stop(true);
  const part = s.parts[s.i];
  const u = new SpeechSynthesisUtterance(part.text);
  u.rate = rate();
  const voice = part.voice ?? preferredVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.onstart = () => part.onStart?.();
  u.onend = () => {
    if (session !== s || s.paused) return;
    s.i++;
    playNext();
  };
  u.onerror = (e) => {
    if (session !== s || e.error === 'interrupted' || e.error === 'canceled') return;
    stop(false);
  };
  speechSynthesis.speak(u);
}

/**
 * Play `parts` (strings, or { text, onStart, voice } to follow along, e.g. highlight a change, and
 * to speak in a given voice) under `id`.
 * `onState(state)` hears 'playing' | 'paused' | 'stopped'.
 */
export function play(id, parts, { onState, onEnd } = {}) {
  stop(false);
  if (!canSpeak()) return false;
  const list = parts.flatMap((p) => {
    const text = typeof p === 'string' ? p : p.text;
    const chunks = pieces(text);
    return chunks.map((c, k) => ({ text: c, onStart: k === 0 && typeof p !== 'string' ? p.onStart : null, voice: typeof p === 'string' ? null : p.voice ?? null }));
  });
  if (!list.length) return false;
  session = { id, parts: list, i: 0, paused: false, onState, onEnd };
  onState?.('playing');
  notify();
  playNext();
  return true;
}

export function pause() {
  if (!session || session.paused) return;
  session.paused = true;
  // Cancel rather than speechSynthesis.pause(): pausing is unreliable on Chrome and iOS. Resume
  // restarts the piece that was playing.
  speechSynthesis.cancel();
  session.onState?.('paused');
  notify();
}

export function resume() {
  if (!session?.paused) return;
  session.paused = false;
  session.onState?.('playing');
  notify();
  playNext();
}

export function stop(finished = false) {
  const s = session;
  session = null;
  if (canSpeak()) speechSynthesis.cancel();
  if (s) {
    s.onState?.('stopped');
    if (finished) s.onEnd?.();
    notify();
  }
}

/** What is playing: { id, paused } or null. */
export const now = () => (session ? { id: session.id, paused: session.paused } : null);

export function cycleRate() {
  const next = RATES[(RATES.indexOf(rate()) + 1) % RATES.length];
  try {
    localStorage.setItem(RATE_KEY, String(next));
  } catch {}
  notify();
  return next;
}
export const rateLabel = () => `${rate()}×`;

// Buttons anywhere on the page redraw themselves from this.
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn(now()));

/**
 * A Listen control for `id`: 🔊 Listen, or ⏸ / ▶ with ■ and the speed while that id plays.
 * Clicks are handled by `bindListen`; `data-say` names what to read.
 */
const labels = new Map();

export function listenHtml(id, { title = 'Read it aloud', label = null } = {}) {
  if (!canSpeak()) return '';
  // Remembered, so a control redrawn as playback changes keeps its words.
  if (label) labels.set(id, { title, label });
  const saved = labels.get(id);
  const cur = now();
  if (cur?.id !== id) return `<span class="say" data-say="${id}"><button type="button" class="small ghost" data-say-act="play" title="${saved?.title ?? title}">🔊 ${saved?.label ?? 'Listen'}</button></span>`;
  return `<span class="say on" data-say="${id}"><button type="button" class="small" data-say-act="${cur.paused ? 'resume' : 'pause'}" title="${cur.paused ? 'Resume' : 'Pause'}">${cur.paused ? '▶' : '⏸'}</button><button type="button" class="small ghost" data-say-act="stop" title="Stop">■</button><button type="button" class="small ghost" data-say-act="rate" title="Speed">${rateLabel()}</button></span>`;
}

/** Handle Listen controls: `start(id)` begins playing that id (it knows what to read). */
export function bindListen(start) {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-say-act]');
    if (!b) return;
    const id = b.closest('[data-say]').dataset.say;
    const act = b.dataset.sayAct;
    if (act === 'play') start(id);
    else if (act === 'pause') pause();
    else if (act === 'resume') resume();
    else if (act === 'stop') stop(false);
    else if (act === 'rate') cycleRate();
  });
  // Keep every visible control in step with what is playing.
  onChange(() => {
    for (const el of document.querySelectorAll('[data-say]')) el.outerHTML = listenHtml(el.dataset.say);
  });
}
