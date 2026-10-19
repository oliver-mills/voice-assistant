// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const transcript = document.getElementById('transcript');
const recordBtn = document.getElementById('recordBtn');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const newChatBtn = document.getElementById('newChatBtn');
const handsFreeToggle = document.getElementById('handsFreeToggle');
const hearingSelect = document.getElementById('hearingSelect');
const voiceSelect = document.getElementById('voiceSelect');
const composer = document.getElementById('composer');
const textInput = document.getElementById('textInput');
const turnCountEl = document.getElementById('turnCount');
const telHearing = document.getElementById('telHearing');
const telVoice = document.getElementById('telVoice');
const telFirstWord = document.getElementById('telFirstWord');
const telFirstAudio = document.getElementById('telFirstAudio');
const memoryBtn = document.getElementById('memoryBtn');
const memoryPanel = document.getElementById('memoryPanel');
const memoryList = document.getElementById('memoryList');
const memoryCount = document.getElementById('memoryCount');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const scopeCanvas = document.getElementById('scope');

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MIN_RECORDING_MS = 400;   // anything shorter is an accidental tap
const MIN_CHUNK_CHARS = 20;     // don't send "Yes." to TTS on its own
const MAX_CHUNK_CHARS = 220;    // break up a rambling sentence so speech starts
const TTS_LOOKAHEAD = 1;        // clips rendered ahead of the one playing
// ElevenLabs bills per character. A normal four-sentence answer is well under
// this; anything past it still shows in the transcript, just isn't spoken.
const MAX_SPOKEN_CHARS = 700;

// Hands-free voice detection, sampled every VAD_FRAME_MS
const VAD_FRAME_MS = 50;
const VAD_CALIBRATION_FRAMES = 20;  // ~1s of room tone before we trust the floor
const VAD_START_FRAMES = 3;         // ~150ms of speech to open the mic
const VAD_END_FRAMES = 18;          // ~900ms of silence to close it
const VAD_MIN_VOICED_FRAMES = 7;    // ~350ms of actual voice, or it was just noise

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// idle | listening | transcribing | thinking | speaking
let mode = 'idle';
let turn = null;          // the in-flight turn, if any
const allAudioUrls = [];  // every clip ever made, so New chat can free them

let mediaRecorder;
let pushToTalkStream;     // only used when hands-free is off
let audioChunks = [];
let isRecording = false;
let wantsToRecord = false;
let startedAt = 0;
let timerId;

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

function scrollToBottom() {
  transcript.scrollTop = transcript.scrollHeight;
}

const WHO = { user: 'You', assistant: 'Assistant', error: 'Error', timer: 'Timer', note: 'Note' };

function clockTime(date = new Date()) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function updateTurnCount() {
  const count = transcript.querySelectorAll('.msg.user').length;
  turnCountEl.textContent = count ? `${count} turn${count === 1 ? '' : 's'}` : '';
}

// Returns a handle rather than the raw node, so callers can keep appending to
// an entry as tokens stream in without re-querying the DOM.
// time is null for restored history, which has no timestamps.
function addMessage(role, text, { pending = false, time = new Date() } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = WHO[role] || role;
  meta.appendChild(who);
  if (time) {
    const stamp = document.createElement('span');
    stamp.className = 'time';
    stamp.textContent = clockTime(time);
    meta.appendChild(stamp);
  }
  el.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'body';
  if (pending) {
    body.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  } else {
    body.textContent = text;
  }
  el.appendChild(body);

  transcript.appendChild(el);
  transcript.classList.add('has-messages');
  updateTurnCount();
  scrollToBottom();

  let content = pending ? '' : text;

  return {
    el,
    get text() { return content; },
    setText(value) {
      content = value;
      body.textContent = value;
      scrollToBottom();
    },
    // First token replaces the dots; every token after that just appends
    append(value) {
      if (!content) {
        el.classList.add('streaming');
        body.textContent = '';
      }
      content += value;
      body.textContent = content;
      scrollToBottom();
    },
    endStream() {
      el.classList.remove('streaming');
    },
    markInterrupted() {
      el.classList.remove('streaming');
      el.classList.add('interrupted');
    },
    fail(message) {
      el.className = 'msg error';
      who.textContent = WHO.error;
      body.textContent = message;
      scrollToBottom();
    },
    remove() {
      el.remove();
      updateTurnCount();
      if (!transcript.querySelector('.msg')) transcript.classList.remove('has-messages');
    },
    // The reply was spoken as several clips, so replay walks them in order
    attachAudio(clips) {
      if (!clips.length) return;
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      const button = document.createElement('button');
      button.className = 'replay';
      button.textContent = 'replay';
      button.addEventListener('click', () => replay(clips));
      meta.append(spacer, button);
    },
    attachMetrics(textLine) {
      if (!textLine) return;
      const line = document.createElement('div');
      line.className = 'metrics';
      line.textContent = textLine;
      el.appendChild(line);
      scrollToBottom();
    }
  };
}

function addError(message) {
  addMessage('error', message);
}

// ---------------------------------------------------------------------------
// Mode and status
// ---------------------------------------------------------------------------

const STATUS_TEXT = {
  idle: 'Ready',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking'
};

function setMode(next) {
  mode = next;

  // All the styling for a state hangs off this one attribute
  document.body.dataset.mode = next;

  if (next !== 'listening') statusEl.textContent = STATUS_TEXT[next] || '';

  updateHint();

  // Hands-free listens again only once the assistant has stopped talking, so
  // it never transcribes its own voice
  if (vad.enabled) {
    vad.paused = next !== 'idle';
    if (next === 'idle') resetVadCounters();
  }
  syncHandsFreeHearing();
}

function updateHint() {
  if (mode === 'speaking' || mode === 'thinking') {
    hintEl.innerHTML = 'Hold <kbd>Space</kbd> to interrupt';
  } else if (handsFreeToggle.checked) {
    hintEl.innerHTML = 'Hands-free is on. Just start talking,<br>or hold <kbd>Space</kbd>.';
  } else {
    hintEl.innerHTML = 'Hold <kbd>Space</kbd> or the button to talk';
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function postJSON(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function transcribe(blob, filename, signal) {
  const formData = new FormData();
  formData.append('file', blob, filename);

  const response = await fetch('/api/speech-to-text', { method: 'POST', body: formData, signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Transcription failed (${response.status})`);
  }
  return data.text;
}

// Reads the server's SSE stream, handing each token to onDelta as it lands
async function streamChat(text, signal, onDelta, onSearching) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal
  });

  // A failure before the first token still arrives as an ordinary JSON error
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Chat request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; anything after the last one is a
    // partial event that has to wait for the next chunk
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const nameMatch = raw.match(/^event: (.+)$/m);
      const dataMatch = raw.match(/^data: ([\s\S]+)$/m);
      if (!dataMatch) continue;

      const name = nameMatch ? nameMatch[1] : 'message';
      const payload = JSON.parse(dataMatch[1]);

      if (name === 'delta') {
        reply += payload.text;
        onDelta(payload.text);
      } else if (name === 'searching') {
        onSearching();
      } else if (name === 'timer') {
        scheduleTimer(payload);
      } else if (name === 'error') {
        throw new Error(payload.error);
      } else if (name === 'done') {
        return payload.reply || reply;
      }
    }
  }

  return reply;
}

async function fetchSpeech(text, signal) {
  const response = await fetch('/api/text-to-speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal
  });

  // Success is raw audio bytes; failure is JSON, so only parse on failure
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Text-to-speech failed (${response.status})`);
  }
  return URL.createObjectURL(await response.blob());
}

// ---------------------------------------------------------------------------
// A turn: streams the reply while speaking the sentences already finished
// ---------------------------------------------------------------------------

function startTurn() {
  const t = {
    controller: new AbortController(),
    cancelled: false,
    queue: [],        // chunks waiting to be played, the next one already fetching
    clips: [],        // everything spoken, as { url } or { text }, for replay
    audio: null,      // the clip currently playing
    streamEnded: false,
    spokenChars: 0,   // characters sent off for speech so far this turn
    overBudget: false,
    wake: null        // resolves the playback loop when new work arrives
  };
  turn = t;
  return t;
}

// Wakes the playback loop if it is parked waiting for the next chunk
function notify(t) {
  if (t.wake) {
    const wake = t.wake;
    t.wake = null;
    wake();
  }
}

function enqueueSpeech(t, text) {
  // The browser's own voice costs nothing, so it needs no fetching or budget
  if (useBrowserVoice()) {
    t.queue.push({ text, local: true });
    notify(t);
    return;
  }

  if (t.spokenChars + text.length > MAX_SPOKEN_CHARS) {
    if (!t.overBudget) {
      t.overBudget = true;
      addMessage('note', `Reply passed ${MAX_SPOKEN_CHARS} characters, so the rest is text only.`);
    }
    return;
  }
  t.spokenChars += text.length;
  t.queue.push({ text, urlPromise: null });
  prefetch(t);
  notify(t);
}

// A clip is billed when it is requested, not when it is heard. Fetching every
// sentence up front meant an interruption still paid for the whole reply, so
// only render a little ahead of what is playing.
function prefetch(t) {
  for (const item of t.queue.slice(0, TTS_LOOKAHEAD)) {
    if (item.local || item.urlPromise || t.cancelled) continue;
    item.urlPromise = fetchSpeech(item.text, t.controller.signal);
    // If the turn is cancelled the loop may never await this one, and an aborted
    // fetch with nobody watching it surfaces as an unhandled rejection
    item.urlPromise.catch(() => {});
  }
}

async function playbackLoop(t) {
  while (!t.cancelled) {
    if (!t.queue.length) {
      if (t.streamEnded) return;
      await new Promise((resolve) => { t.wake = resolve; });
      continue;
    }

    // The head of the queue is always already fetching; this starts the next
    const item = t.queue.shift();
    prefetch(t);

    if (item.local) {
      t.clips.push({ text: item.text });
      markTime(t, 'voice');
      await speakLocally(item.text);
      continue;
    }

    let url;
    try {
      url = await item.urlPromise;
    } catch (err) {
      if (!t.cancelled) {
        addError(err.message);
        console.error(err);
      }
      continue;
    }

    if (t.cancelled) {
      URL.revokeObjectURL(url);
      return;
    }

    t.clips.push({ url });
    allAudioUrls.push(url);
    markTime(t, 'voice');
    await playClip(t, url);
  }
}

function speakLocally(text) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    // The browser voice can't be measured, so the scope animates instead
    scope.synthetic = true;
    const done = () => {
      scope.synthetic = false;
      resolve();
    };
    // cancel() ends the utterance with an error rather than an end event
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
  });
}

function playAudio(url, onCreate) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    if (onCreate) onCreate(audio);
    routeToScope(audio);
    audio.onended = resolve;
    // A blocked autoplay shouldn't stall the queue; the replay button still works
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
}

function playClip(t, url) {
  return playAudio(url, (audio) => { t.audio = audio; });
}

function markTime(t, name) {
  if (t.marks && !(name in t.marks)) t.marks[name] = performance.now();
}

// "hearing 0.42s · first word 1.10s · voice 1.52s", each measured from the
// moment the turn started (when you stopped talking, or pressed enter)
function describeTimings(marks) {
  const since = (name) => `${((marks[name] - marks.start) / 1000).toFixed(2)}s`;
  const parts = [];
  if ('heard' in marks) parts.push(`hearing ${since('heard')}`);
  if ('firstWord' in marks) parts.push(`first word ${since('firstWord')}`);
  if ('voice' in marks) parts.push(`voice ${since('voice')}`);
  return parts.join(' · ');
}

function cancelTurn(t) {
  if (!t || t.cancelled) return;
  t.cancelled = true;
  t.controller.abort();
  if (t.audio) {
    t.audio.pause();
    t.audio = null;
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  notify(t);
}

// Replaying never spends credits: ElevenLabs clips are kept from the first
// play, and browser-voiced ones are just spoken again
async function replay(clips) {
  cancelTurn(turn);
  for (const clip of clips) {
    if (clip.text) {
      await speakLocally(clip.text);
      continue;
    }
    await playAudio(clip.url);
  }
}

// One exchange, from either a recording or typed text.
// heard is the browser's transcript, if it was listening: a promise of the
// text, '' for nothing said, or null when it failed and ElevenLabs must step in.
// typed skips hearing altogether, which also makes it free.
async function runTurn({ blob, filename, heard, typed }) {
  const t = startTurn();
  t.marks = { start: performance.now() };

  let text;
  if (typed) {
    text = typed;
    addMessage('user', text);
  } else {
    const userMsg = addMessage('user', '', { pending: true });
    setMode('transcribing');

    try {
      text = heard ? await heard : null;
      if (text === null) {
        text = await transcribe(blob, filename, t.controller.signal);
      } else if (!text) {
        throw new Error('No speech detected');
      }
      if (t.cancelled) throw new Error('Cancelled');
      userMsg.setText(text);
      markTime(t, 'heard');
    } catch (err) {
      userMsg.remove(); // nothing was said, so don't leave a blank entry
      if (!t.cancelled) {
        addError(err.message);
        console.error(err);
        setMode('idle');
      }
      return;
    }
  }

  const botMsg = addMessage('assistant', '', { pending: true });
  setMode('thinking');

  let buffer = '';
  let spokeAnything = false;
  let searches = 0;
  const playback = playbackLoop(t);

  try {
    await streamChat(text, t.controller.signal, (delta) => {
      markTime(t, 'firstWord');
      botMsg.append(delta);
      buffer += delta;

      // Hand each finished sentence to TTS without waiting for the rest
      for (;;) {
        const [chunk, rest] = SpeechUtils.takeChunk(buffer, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS);
        if (!chunk) break;
        buffer = rest;
        if (!spokeAnything) {
          spokeAnything = true;
          setMode('speaking');
        }
        enqueueSpeech(t, chunk);
      }
    }, () => {
      // Searching takes seconds. Without a cue the app just looks frozen.
      searches++;
      if (mode === 'thinking') {
        statusEl.textContent = searches > 1
          ? `Searching the web (${searches})…`
          : 'Searching the web…';
      }
    });

    // Whatever is left after the last sentence terminator still needs speaking
    if (buffer.trim()) {
      if (!spokeAnything) setMode('speaking');
      enqueueSpeech(t, buffer.trim());
    }
    botMsg.endStream();
  } catch (err) {
    if (t.cancelled) {
      botMsg.markInterrupted();
      return;
    }
    if (botMsg.text) {
      botMsg.endStream();
      addError(err.message);
    } else {
      botMsg.fail(err.message);
    }
    console.error(err);
    setMode('idle');
    return;
  } finally {
    t.streamEnded = true;
    notify(t);
  }

  await playback;

  if (t.cancelled) {
    botMsg.markInterrupted();
    return;
  }

  botMsg.attachAudio(t.clips);
  botMsg.attachMetrics(describeTimings(t.marks));
  const since = (name) => (name in t.marks
    ? `${((t.marks[name] - t.marks.start) / 1000).toFixed(2)}s`
    : '-');
  telFirstWord.textContent = since('firstWord');
  telFirstAudio.textContent = since('voice');
  turn = null;
  setMode('idle');
  // The reply may have saved or forgotten something
  refreshMemories();
}

// ---------------------------------------------------------------------------
// Timers the assistant set. They live in this page, so a reload loses them.
// ---------------------------------------------------------------------------

function scheduleTimer({ seconds, label }) {
  setTimeout(() => ringTimer(label), seconds * 1000);
}

function ringTimer(label) {
  addMessage('timer', `${label}: time's up`);
  // A chime rather than speech: it costs nothing, and works whatever the
  // assistant is doing at the time
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((offset) => {
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.frequency.value = 880;
      const at = context.currentTime + offset;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      tone.connect(gain).connect(context.destination);
      tone.start(at);
      tone.stop(at + 0.3);
    });
    setTimeout(() => context.close(), 1500);
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const BrowserRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Storage can be missing or throw (private windows, blocked site data); the
// pickers just fall back to their defaults
function loadSetting(select, key) {
  try {
    const saved = localStorage.getItem(key);
    if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;
  } catch {}
  select.addEventListener('change', () => {
    try { localStorage.setItem(key, select.value); } catch {}
  });
}

// Firefox has no speech recognition, so there it can only be ElevenLabs
if (!BrowserRecognition) {
  hearingSelect.value = 'elevenlabs';
  hearingSelect.querySelector('option[value="browser"]').disabled = true;
} else {
  loadSetting(hearingSelect, 'hearing');
}
if (!window.speechSynthesis) {
  voiceSelect.querySelector('option[value="browser"]').disabled = true;
} else {
  loadSetting(voiceSelect, 'voice');
}

function useBrowserHearing() {
  return Boolean(BrowserRecognition) && hearingSelect.value === 'browser';
}

function useBrowserVoice() {
  return Boolean(window.speechSynthesis) && voiceSelect.value === 'browser';
}

function updateTelemetry() {
  telHearing.textContent = useBrowserHearing() ? 'Browser (free)' : 'ElevenLabs';
  telVoice.textContent = useBrowserVoice() ? 'Browser (free)' : 'ElevenLabs';
}

hearingSelect.addEventListener('change', updateTelemetry);
voiceSelect.addEventListener('change', updateTelemetry);
updateTelemetry();

// ---------------------------------------------------------------------------
// Top bar menus: settings and memory
// ---------------------------------------------------------------------------

const menus = [[settingsBtn, settingsPanel], [memoryBtn, memoryPanel]];

function closeMenus() {
  for (const [button, panel] of menus) {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
}

function setupMenu(button, panel, onOpen) {
  button.addEventListener('click', () => {
    const opening = panel.hidden;
    closeMenus();
    if (!opening) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (onOpen) onOpen();
  });
}

setupMenu(settingsBtn, settingsPanel);
setupMenu(memoryBtn, memoryPanel, () => refreshMemories());

document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu')) closeMenus();
});

function renderMemories(memories) {
  memoryCount.textContent = memories.length || '';
  memoryList.replaceChildren();

  if (!memories.length) {
    const empty = document.createElement('li');
    empty.className = 'memory-empty';
    empty.textContent = 'Nothing saved yet. Say "remember that..." to add something.';
    memoryList.appendChild(empty);
    return;
  }

  for (const memory of memories) {
    const item = document.createElement('li');
    const id = document.createElement('span');
    id.className = 'memory-id';
    id.textContent = `#${memory.id}`;
    const fact = document.createElement('span');
    fact.className = 'memory-fact';
    fact.textContent = memory.fact;
    const remove = document.createElement('button');
    remove.className = 'memory-delete';
    remove.textContent = 'Delete';
    remove.title = 'Forget this';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        const response = await fetch(`/api/memories/${memory.id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`Could not delete (${response.status})`);
      } catch (err) {
        addError(err.message);
      }
      refreshMemories();
    });
    item.append(id, fact, remove);
    memoryList.appendChild(item);
  }
}

async function refreshMemories() {
  try {
    const response = await fetch('/api/memories');
    if (!response.ok) return;
    const { memories } = await response.json();
    renderMemories(memories);
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Scope: draws the real signal, the mic while you talk and the reply while it
// plays, so the display is a reading rather than decoration
// ---------------------------------------------------------------------------

const scope = {
  ctx: scopeCanvas.getContext('2d'),
  audio: null,       // shared AudioContext for measuring playback and the mic
  output: null,      // analyser on everything the assistant plays
  mic: null,         // analyser on the push-to-talk mic, while it is held
  micSource: null,
  buffer: new Uint8Array(2048),
  synthetic: false,  // the browser voice can't be measured, so animate instead
  colours: {}
};

// Browsers only start audio after a click or key press, so the shared context
// is created, or woken, inside one
function wakeAudio() {
  try {
    if (!scope.audio) {
      scope.audio = new (window.AudioContext || window.webkitAudioContext)();
      scope.output = scope.audio.createAnalyser();
      scope.output.fftSize = 1024;
      scope.output.connect(scope.audio.destination);
    }
    if (scope.audio.state === 'suspended') scope.audio.resume();
  } catch (err) {
    console.warn(err);
  }
}

// Routing into a context that isn't running would play silence, so only
// measure playback once it is; otherwise the clip just plays as normal
function routeToScope(audio) {
  if (!scope.audio || scope.audio.state !== 'running') return;
  try {
    scope.audio.createMediaElementSource(audio).connect(scope.output);
  } catch (err) {
    console.warn(err);
  }
}

function attachMicToScope(stream) {
  detachMicFromScope();
  if (!scope.audio || scope.audio.state !== 'running') return;
  scope.micSource = scope.audio.createMediaStreamSource(stream);
  scope.mic = scope.audio.createAnalyser();
  scope.mic.fftSize = 1024;
  scope.micSource.connect(scope.mic); // measured only, never played back
}

function detachMicFromScope() {
  if (scope.micSource) scope.micSource.disconnect();
  scope.micSource = null;
  scope.mic = null;
}

function readScopeColours() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  scope.colours = { rec: get('--rec'), speak: get('--speak'), busy: get('--warn'), idle: get('--faint') };
}
readScopeColours();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readScopeColours);

function scopeSignal() {
  const c = scope.colours;
  if (mode === 'listening') {
    return { analyser: scope.mic || vad.analyser, colour: c.rec, label: 'Microphone' };
  }
  if (mode === 'speaking') {
    return scope.synthetic || !scope.output
      ? { pattern: 'voice', colour: c.speak, label: 'Browser voice' }
      : { analyser: scope.output, colour: c.speak, label: 'Reply audio' };
  }
  if (mode === 'thinking' || mode === 'transcribing') {
    return { pattern: 'pulse', colour: c.busy, label: STATUS_TEXT[mode].replace('…', '') };
  }
  // Hands-free waiting: show the room, so it is obvious the mic is live
  if (vad.enabled && vad.analyser) return { analyser: vad.analyser, colour: c.idle, label: 'Room' };
  return { pattern: 'flat', colour: c.idle, label: 'No signal' };
}

// Loudness of the frame in dB below full scale, the way audio meters read
function levelDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const centred = (samples[i] - 128) / 128;
    sum += centred * centred;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function drawScope(now) {
  const dpr = window.devicePixelRatio || 1;
  const width = scopeCanvas.clientWidth;
  const height = scopeCanvas.clientHeight;
  if (scopeCanvas.width !== Math.round(width * dpr) || scopeCanvas.height !== Math.round(height * dpr)) {
    scopeCanvas.width = Math.round(width * dpr);
    scopeCanvas.height = Math.round(height * dpr);
  }

  const g = scope.ctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);

  const signal = scopeSignal();
  const mid = height / 2;
  const amplitude = height * 0.42;
  const steps = Math.max(64, Math.floor(width / 3));

  let samples = null;
  if (signal.analyser) {
    samples = scope.buffer.subarray(0, signal.analyser.fftSize);
    signal.analyser.getByteTimeDomainData(samples);
  }

  g.beginPath();
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const along = i / steps;
    let value = 0;

    if (samples) {
      // Speech is quiet next to full scale; boost it so it reads at a glance
      value = Math.max(-1, Math.min(1, ((samples[Math.floor(along * (samples.length - 1))] - 128) / 128) * 2.2));
    } else if (signal.pattern === 'pulse') {
      // A packet travelling left to right: something is happening, no signal yet
      const position = ((now / 1600) % 1.4) - 0.2;
      const envelope = Math.exp(-((along - position) ** 2) / 0.006);
      value = envelope * 0.35 * Math.sin(along * 90 - now / 60);
    } else if (signal.pattern === 'voice') {
      const swell = 0.25 + 0.2 * Math.sin(now / 310);
      value = Math.sin(along * 40 + now / 90) * swell * Math.sin(along * Math.PI);
    }

    const y = mid - value * amplitude;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }

  g.strokeStyle = signal.colour;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();

  // Corner readouts: what is being shown, and how loud it is
  g.font = '12px ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace';
  g.textBaseline = 'top';
  g.fillStyle = scope.colours.idle;
  g.textAlign = 'left';
  g.fillText(signal.label, 12, 10);
  if (samples) {
    // Smoothed so the number is readable rather than a blur
    const db = Math.max(-60, levelDb(samples));
    scope.db = scope.db === undefined ? db : scope.db * 0.85 + db * 0.15;
    g.textAlign = 'right';
    g.fillText(scope.db <= -59 ? '< -60 dB' : `${scope.db.toFixed(0)} dB`, width - 12, 10);
  } else {
    scope.db = undefined;
  }

  requestAnimationFrame(drawScope);
}

// ---------------------------------------------------------------------------
// Browser speech recognition: free transcription, with ElevenLabs as fallback
// ---------------------------------------------------------------------------

// The live recognition session, if any. The browser runs one at a time.
let hearing = null;
// What the session heard for the recording that just ended, handed from the
// stop handler to the code that runs the turn
let recordingHeard = null;

// Listens until finish() or cancel(). finish() resolves to what was said, ''
// if nothing was, or null if recognition broke and the recording should go to
// ElevenLabs instead.
function startHearing() {
  cancelHearing();

  const session = {
    parts: [],       // final phrases, in order
    base: 0,         // where this browser session's results start in parts
    markAt: 0,       // only phrases from here on belong to the utterance
    failed: false,
    stopping: false,
    cancelled: false
  };
  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });

  const recognition = new BrowserRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = navigator.language || 'en-US';

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        session.parts[session.base + i] = event.results[i][0].transcript;
      }
    }
  };

  recognition.onerror = (event) => {
    // no-speech is just a quiet stretch, and aborted is us cancelling
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('Browser speech recognition failed:', event.error);
    session.failed = true;
  };

  recognition.onend = () => {
    // Chrome ends continuous sessions on its own after a while; keep going
    // until we actually ask it to stop. Results restart from 0 in the new one.
    if (!session.stopping && !session.cancelled && !session.failed) {
      session.base = session.parts.length;
      try {
        recognition.start();
        return;
      } catch (err) {
        session.failed = true;
      }
    }
    resolveEnded();
  };

  try {
    recognition.start();
  } catch (err) {
    console.warn(err);
    session.failed = true;
    resolveEnded();
  }

  session.mark = () => {
    session.markAt = session.parts.length;
  };

  session.finish = async () => {
    session.stopping = true;
    if (hearing === session) hearing = null;
    recognition.stop(); // flushes whatever is still being recognised
    // A browser that never fires end shouldn't hang the turn
    await Promise.race([ended, new Promise((r) => setTimeout(r, 2500))]);
    if (session.failed) return null;
    return session.parts.slice(session.markAt).filter(Boolean).join(' ').trim();
  };

  session.cancel = () => {
    session.cancelled = true;
    if (hearing === session) hearing = null;
    recognition.abort();
  };

  hearing = session;
  return session;
}

function cancelHearing() {
  if (hearing) hearing.cancel();
}

// Hands-free keeps a session open whenever it is waiting for you, so the start
// of what you say is heard rather than lost while recognition spins up. It is
// shut while the assistant talks so it never transcribes its own voice.
function syncHandsFreeHearing() {
  const wanted = vad.enabled && mode === 'idle' && useBrowserHearing();
  if (wanted && !hearing) startHearing();
  if (!wanted && hearing && mode !== 'listening') cancelHearing();
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

// Safari doesn't support webm, so ask the browser what it can actually record
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function filenameFor(type) {
  if (type.includes('mp4')) return 'recording.mp4';
  if (type.includes('ogg')) return 'recording.ogg';
  return 'recording.webm';
}

function buildRecorder(stream, onComplete) {
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  audioChunks = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) audioChunks.push(event.data);
  };
  recorder.onstop = () => {
    const type = recorder.mimeType || 'audio/webm';
    onComplete(new Blob(audioChunks, { type }), filenameFor(type));
  };

  return recorder;
}

// Hands-free keeps one stream open for the whole session; push-to-talk opens
// one per utterance so the browser's recording indicator goes off in between
async function acquireStream() {
  if (vad.enabled && vad.stream) return vad.stream;
  pushToTalkStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return pushToTalkStream;
}

function releaseStream() {
  detachMicFromScope();
  if (pushToTalkStream) {
    pushToTalkStream.getTracks().forEach((track) => track.stop());
    pushToTalkStream = null;
  }
}

function startTimer() {
  startedAt = Date.now();
  timerId = setInterval(() => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    statusEl.textContent = `Listening  ${seconds}s`;
  }, 100);
}

async function startRecording() {
  if (isRecording || wantsToRecord) return;
  wakeAudio();
  closeMenus();

  // Grabbing the button part-way through a hands-free utterance: throw away
  // what the detector had so far and let the button take over
  if (vad.speaking) {
    vad.speaking = false;
    vad.captured = null;
    clearInterval(timerId);
    resetVadCounters();
  }

  // Barge-in: talking over the assistant cancels whatever it was doing
  cancelTurn(turn);
  turn = null;

  wantsToRecord = true;
  if (vad.enabled) vad.paused = true;

  // Start listening before the mic is ready so the first word isn't lost
  if (useBrowserHearing()) startHearing();
  else cancelHearing();

  try {
    const stream = await acquireStream();

    // The button may already have been released while we waited on the mic
    if (!wantsToRecord) {
      cancelHearing();
      releaseStream();
      return;
    }

    attachMicToScope(stream);
    mediaRecorder = buildRecorder(stream, handleRecording);
    mediaRecorder.start();
    isRecording = true;
    setMode('listening');
    startTimer();
  } catch (err) {
    wantsToRecord = false;
    cancelHearing();
    releaseStream();
    setMode('idle');
    addError('Mic permission denied or unavailable');
    console.error(err);
  }
}

function stopRecording() {
  wantsToRecord = false;
  if (!isRecording) return;

  isRecording = false;
  clearInterval(timerId);
  recordingHeard = hearing ? hearing.finish() : null;
  setMode('transcribing');
  mediaRecorder.stop(); // triggers the onstop handler, which builds the Blob
}

function handleRecording(blob, filename) {
  const elapsed = Date.now() - startedAt;
  const heard = recordingHeard;
  recordingHeard = null;
  releaseStream();

  if (elapsed < MIN_RECORDING_MS || blob.size === 0) {
    setMode('idle');
    statusEl.textContent = 'Too short. Hold a moment longer.';
    setTimeout(() => {
      if (mode === 'idle') statusEl.textContent = STATUS_TEXT.idle;
    }, 1600);
    return;
  }

  runTurn({ blob, filename, heard });
}

// ---------------------------------------------------------------------------
// Hands-free: watch the mic level and send when the talking stops
// ---------------------------------------------------------------------------

const vad = {
  enabled: false,
  paused: false,
  stream: null,
  context: null,
  analyser: null,
  samples: null,
  timer: null,
  calibrationFrames: 0,
  noiseFloor: 0,
  speechFrames: 0,
  silenceFrames: 0,
  speaking: false,
  utterance: null,
  capture: null,     // worklet node streaming raw samples off the mic
  preroll: [],       // the last moment of audio before speech was detected
  prerollLength: 0,
  captured: null     // sample chunks of the utterance in progress
};

// Hands-free records raw samples rather than using MediaRecorder. By the time
// the detector is sure you are talking, the first syllable has already gone
// past; a rolling buffer of the last half-second lets the clip begin before
// that, and the trailing silence can be cut instead of sent off and billed.
const PRE_ROLL_MS = 500;
const TAIL_KEEP_MS = 300;
const UPLOAD_SAMPLE_RATE = 16000;

const CAPTURE_WORKLET = `
  class Capture extends AudioWorkletProcessor {
    constructor() {
      super();
      this.buffer = new Float32Array(2048);
      this.filled = 0;
    }
    process(inputs) {
      const channel = inputs[0] && inputs[0][0];
      if (channel) {
        for (let i = 0; i < channel.length; i++) {
          this.buffer[this.filled++] = channel[i];
          if (this.filled === this.buffer.length) {
            this.port.postMessage(this.buffer.slice());
            this.filled = 0;
          }
        }
      }
      return true;
    }
  }
  registerProcessor('capture', Capture);
`;

function onCaptureChunk(chunk) {
  if (!vad.context) return; // a last message after hands-free was switched off
  if (vad.captured) {
    vad.captured.push(chunk);
    return;
  }
  vad.preroll.push(chunk);
  vad.prerollLength += chunk.length;
  const keep = vad.context.sampleRate * PRE_ROLL_MS / 1000;
  while (vad.preroll.length > 1 && vad.prerollLength - vad.preroll[0].length >= keep) {
    vad.prerollLength -= vad.preroll.shift().length;
  }
}

function resetVadCounters() {
  vad.speechFrames = 0;
  vad.silenceFrames = 0;
}

// Root mean square of the current audio frame: a rough loudness figure
function currentLevel() {
  vad.analyser.getByteTimeDomainData(vad.samples);
  let sum = 0;
  for (let i = 0; i < vad.samples.length; i++) {
    const centred = (vad.samples[i] - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / vad.samples.length);
}

function vadFrame() {
  if (vad.paused || isRecording) return;

  const level = currentLevel();

  // Spend the first second learning what this room sounds like when quiet
  if (vad.calibrationFrames < VAD_CALIBRATION_FRAMES) {
    vad.calibrationFrames++;
    vad.noiseFloor = vad.noiseFloor
      ? vad.noiseFloor * 0.8 + level * 0.2
      : level;
    return;
  }

  const threshold = Math.max(vad.noiseFloor * 3, 0.012);

  if (!vad.speaking) {
    vad.speechFrames = level > threshold ? vad.speechFrames + 1 : 0;
    if (vad.speechFrames >= VAD_START_FRAMES) beginVadUtterance();
    return;
  }

  if (level > threshold) vad.utterance.voicedFrames++;
  vad.silenceFrames = level > threshold ? 0 : vad.silenceFrames + 1;
  if (vad.silenceFrames >= VAD_END_FRAMES) endVadUtterance();
}

function beginVadUtterance() {
  vad.speaking = true;
  resetVadCounters();
  startedAt = Date.now();

  // The frames that opened the mic were voice too
  const utterance = { voicedFrames: VAD_START_FRAMES };
  vad.utterance = utterance;
  // Recognition has been running all along; only what follows is this utterance
  if (hearing) hearing.mark();

  // Start the clip from the buffered moment before speech was detected
  vad.captured = vad.preroll;
  vad.preroll = [];
  vad.prerollLength = 0;

  setMode('listening');
  startTimer();
}

async function endVadUtterance() {
  vad.speaking = false;
  resetVadCounters();
  clearInterval(timerId);
  recordingHeard = hearing ? hearing.finish() : null;
  setMode('transcribing');

  const chunks = vad.captured || [];
  vad.captured = null;
  const utterance = vad.utterance;
  // Read now: hands-free may be switched off while we wait on recognition
  const rate = vad.context.sampleRate;

  // The trailing silence alone makes every clip long enough to pass the
  // length check, so a cough or a door would cost a transcription. Judge it
  // on how much of it was voice instead, and drop it without a fuss.
  if (!utterance || utterance.voicedFrames < VAD_MIN_VOICED_FRAMES) {
    recordingHeard = null;
    setMode('idle');
    return;
  }

  // Loud but wordless (a TV, a laugh): the browser heard nothing to send, and
  // hands-free shouldn't put an error in the transcript for every one
  if (recordingHeard) {
    const text = await recordingHeard;
    if (mode !== 'transcribing') return; // the button took over meanwhile
    if (text === '') {
      recordingHeard = null;
      setMode('idle');
      return;
    }
    recordingHeard = Promise.resolve(text);
  }

  let samples = SpeechUtils.concatSamples(chunks);
  const trim = Math.floor(rate * (VAD_END_FRAMES * VAD_FRAME_MS - TAIL_KEEP_MS) / 1000);
  samples = samples.subarray(0, Math.max(0, samples.length - trim));
  samples = SpeechUtils.downsample(samples, rate, UPLOAD_SAMPLE_RATE);
  const wav = SpeechUtils.encodeWav(samples, UPLOAD_SAMPLE_RATE);

  handleRecording(new Blob([wav], { type: 'audio/wav' }), 'recording.wav');
}

async function enableHandsFree() {
  // Granting permission can take a while the first time, and a toggle that just
  // sits there looking on with nothing happening reads as broken
  hintEl.textContent = 'requesting microphone...';

  try {
    vad.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    handsFreeToggle.checked = false;
    updateHint();
    addError('Mic permission denied or unavailable');
    console.error(err);
    return;
  }

  // The user may have switched it back off while the prompt was up
  if (!handsFreeToggle.checked) {
    vad.stream.getTracks().forEach((track) => track.stop());
    vad.stream = null;
    updateHint();
    return;
  }

  vad.context = new (window.AudioContext || window.webkitAudioContext)();
  const source = vad.context.createMediaStreamSource(vad.stream);
  vad.analyser = vad.context.createAnalyser();
  vad.analyser.fftSize = 1024;
  source.connect(vad.analyser);
  vad.samples = new Uint8Array(vad.analyser.fftSize);

  try {
    const moduleUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: 'application/javascript' })
    );
    await vad.context.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    vad.capture = new AudioWorkletNode(vad.context, 'capture');
    vad.capture.port.onmessage = (event) => onCaptureChunk(event.data);
    source.connect(vad.capture);
    // Some browsers only run a node that leads somewhere; it outputs silence
    vad.capture.connect(vad.context.destination);
    // Creating the context after awaiting the mic can leave it suspended
    await vad.context.resume();
  } catch (err) {
    console.error(err);
    addError('Hands-free is not supported in this browser');
    handsFreeToggle.checked = false;
    disableHandsFree();
    return;
  }

  vad.enabled = true;
  vad.paused = mode !== 'idle';
  vad.calibrationFrames = 0;
  vad.noiseFloor = 0;
  resetVadCounters();
  vad.timer = setInterval(vadFrame, VAD_FRAME_MS);

  syncHandsFreeHearing();
  updateHint();
}

function disableHandsFree() {
  clearInterval(vad.timer);
  // An utterance in progress is dropped rather than sent
  if (vad.speaking) {
    clearInterval(timerId);
    if (mode === 'listening') setMode('idle');
  }
  if (vad.stream) vad.stream.getTracks().forEach((track) => track.stop());
  if (vad.context) vad.context.close();

  Object.assign(vad, {
    enabled: false,
    paused: false,
    stream: null,
    context: null,
    analyser: null,
    samples: null,
    timer: null,
    speaking: false,
    utterance: null,
    capture: null,
    preroll: [],
    prerollLength: 0,
    captured: null
  });

  syncHandsFreeHearing();
  updateHint();
}

// ---------------------------------------------------------------------------
// Input wiring
// ---------------------------------------------------------------------------

recordBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  startRecording();
});

// Listening on the window rather than the button means dragging off the button
// mid-sentence still ends the recording cleanly on release
window.addEventListener('pointerup', stopRecording);
window.addEventListener('pointercancel', stopRecording);

// Space typed into the text box, a select or the hands-free checkbox is just
// a space, not push-to-talk
function inField(event) {
  const el = event.target;
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement || el.isContentEditable;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenus();
    if (document.activeElement === textInput) textInput.blur();
    return;
  }
  if (inField(event)) return;

  if (event.code === 'Space' && !event.repeat) {
    event.preventDefault();
    startRecording();
  } else if (event.key === '/') {
    // Jump to the text box, the way search works in most developer tools
    event.preventDefault();
    textInput.focus();
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space' && (isRecording || wantsToRecord)) {
    event.preventDefault();
    stopRecording();
  }
});

// Typing skips hearing entirely, so it costs no transcription at all
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text || isRecording || wantsToRecord) return;

  wakeAudio();
  closeMenus();
  // Sending mid-reply interrupts it, the same as talking over it
  cancelTurn(turn);
  turn = null;
  textInput.value = '';
  runTurn({ typed: text });
});

hearingSelect.addEventListener('change', syncHandsFreeHearing);

handsFreeToggle.addEventListener('change', () => {
  wakeAudio();
  if (handsFreeToggle.checked) enableHandsFree();
  else disableHandsFree();
});

newChatBtn.addEventListener('click', async () => {
  cancelTurn(turn);
  turn = null;

  try {
    await postJSON('/api/reset', {});
  } catch (err) {
    addError(err.message);
    return;
  }

  // Nothing can reach these clips once the transcript is gone
  allAudioUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  transcript.querySelectorAll('.msg').forEach((el) => el.remove());
  transcript.classList.remove('has-messages');
  setMode('idle');
});

// The server keeps the conversation across reloads and restarts, so pick up
// where it left off. Replies come back as text only: replaying them would mean
// paying for the speech again.
async function restoreConversation() {
  try {
    const response = await fetch('/api/history');
    if (!response.ok) return;
    const { turns } = await response.json();
    // Something may have been said while this was loading
    if (transcript.querySelector('.msg')) return;
    for (const { role, text } of turns) addMessage(role, text, { time: null });
  } catch (err) {
    console.error(err);
  }
}

restoreConversation();
refreshMemories();
requestAnimationFrame(drawScope);
