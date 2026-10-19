require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');
const localTools = require('./tools');

const app = express();
// Uploads are held in memory, so cap the size to keep a runaway recording
// from ballooning the process
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = Number(process.env.PORT) || 3000;
// Only this machine by default. Listening on every interface let anyone on the
// same network spend the API credits.
const HOST = process.env.HOST || '127.0.0.1';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const MODEL = 'claude-opus-5';
// Voice replies are short, so there is nothing here worth deep reasoning about.
// Low effort keeps the first token (and therefore the first spoken word) close.
const EFFORT = 'low';
// eleven_flash_v2_5 is noticeably faster if you would rather have speed than
// the richer voice quality of multilingual_v2
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
const MAX_TTS_CHARS = 400;

// Anthropic runs this one on their side: we declare it, they perform the search
// and feed the results back into the same response. Nothing to execute here.
// max_uses matters more here than in a chat app: every extra search is a few
// more seconds of silence for someone waiting to be spoken to
// The rest run here, in tools.js, and their results go back as tool_result.
const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  ...localTools.DEFINITIONS
];

// If Claude declines a request on safety grounds, the API reruns it on a
// fallback model it picks by the kind of refusal, within the same call
const BETAS = ['server-side-fallback-2026-07-01'];

// Searches can pause a turn and tool calls extend it; this stops a
// pathological loop
const MAX_TURN_LEGS = 6;

// Every request through here spends someone's API credits, so once the app is
// reachable beyond this machine it needs a password. Basic auth keeps it to a
// browser prompt with no login page, and the browser then sends it with every
// fetch on its own. The username is ignored.
function requirePassword(req, res, next) {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();

  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const supplied = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    // Hashing first gives timingSafeEqual the equal lengths it needs
    const hash = (value) => crypto.createHash('sha256').update(value).digest();
    if (crypto.timingSafeEqual(hash(supplied), hash(password))) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Voice Assistant", charset="UTF-8"');
  res.status(401).send('Password required');
}
app.use(requirePassword);

// Serve only the browser files. Serving the project root also handed out
// server.js, package.json and anything else that landed next to them.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Everything Claude says here gets read aloud, so the usual chat habits
// (markdown, bullet lists, long preambles) come out as noise. Ask for prose.
const SYSTEM_PROMPT = [
  'You are a voice assistant. Everything you say is read aloud by a',
  'text-to-speech engine, so keep replies short: usually one or two sentences,',
  'and never more than four.',
  'Write plain spoken prose. No markdown, no bullet points, no code blocks,',
  'no emoji, no asterisks or stage directions.',
  'If a question genuinely needs a long answer, give the short version first',
  'and offer to go into more detail.',
  'You can search the web. Use it when the answer depends on current facts',
  'like news, prices, weather, or sports results, and not for things you',
  'already know. Searching is slow, so prefer one search over several.',
  'Keep sourced answers just as short, and say where it came from the way a',
  'person would, such as "according to the BBC". Never read out a URL.',
  'You can save lasting facts about the user, delete them, and set timers.',
  'After using one of these, confirm it in a few words.'
].join(' ');

// The parts that change: the clock, so "in twenty minutes" and "what day is
// it" work, and what the assistant has been asked to remember
function buildSystemPrompt() {
  const now = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
  return [SYSTEM_PROMPT, `The current date and time is ${now}.`, localTools.describeMemories()]
    .join('\n\n');
}

// Both APIs report errors as JSON, but a proxy or gateway in between can
// return HTML instead. Falling back to raw text keeps the real cause visible
// rather than hiding it behind a generic 500 when response.json() throws.
async function describeUpstreamError(response) {
  const raw = (await response.text()).slice(0, 500);
  try {
    const body = JSON.parse(raw);
    return (
      body.error?.message ||                                   // Anthropic
      body.detail?.message ||                                  // ElevenLabs
      (typeof body.detail === 'string' ? body.detail : null) ||
      raw
    );
  } catch {
    return raw;
  }
}

// Proxy route: browser sends audio here, we forward it to ElevenLabs
app.post('/api/speech-to-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file was received' });
    }

    const formData = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
    // Browsers differ on what they can record (Safari gives mp4, not webm), so
    // forward the name the client sent — the extension has to match the bytes
    formData.append('file', audioBlob, req.file.originalname || 'recording.webm');
    formData.append('model_id', 'scribe_v1');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: formData
    });

    if (!response.ok) {
      const detail = await describeUpstreamError(response);
      console.error(`ElevenLabs STT ${response.status}:`, detail);
      return res.status(502).json({ error: `Transcription failed: ${detail}` });
    }

    const data = await response.json();

    // A silent or very short clip transcribes to an empty string. That is not
    // a failure, but there is nothing to send onward either, so say so plainly.
    if (!data.text || !data.text.trim()) {
      return res.status(422).json({ error: 'No speech detected' });
    }

    res.json({ text: data.text.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// The back-and-forth so far, so Claude gets prior turns as context instead of
// seeing each message in isolation. Saved to disk so a restart keeps it.
let conversationHistory = store.load('history', []);
// Long sessions would otherwise resend an ever-growing history on every turn
const MAX_HISTORY_MESSAGES = 40;

// A message the user actually said, as opposed to tool results, which also go
// in as user messages
function isUserTurn(message) {
  return message.role === 'user' && typeof message.content === 'string';
}

function trimHistory(messages) {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  // Slicing can land mid-turn: on an assistant reply, or on tool results whose
  // tool call was cut off. Either is rejected by the API, so start at the
  // first thing the user said.
  const start = recent.findIndex(isUserTurn);
  return start === -1 ? [] : recent.slice(start);
}

// Server-sent events: one JSON payload per named event, blank line terminated
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Streams the reply token by token instead of waiting for the whole thing. The
// client turns each finished sentence into speech as it arrives, so playback
// starts about a sentence after you stop talking rather than a full reply later.
app.post('/api/chat', async (req, res) => {
  const { text } = req.body;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'No text to send' });
  }

  // Build the outgoing messages without committing them to history yet, so a
  // failed request doesn't leave a dangling user turn behind
  const messages = trimHistory([
    ...conversationHistory,
    { role: 'user', content: text }
  ]);

  // Barge-in: when the browser drops the connection mid-reply, stop paying for
  // tokens nobody will hear
  // Watch the response, not the request: req emits 'close' as soon as Express
  // finishes reading the body, which would abort every turn instantly
  let aborted = false;
  let currentStream = null;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      if (currentStream) currentStream.abort();
    }
  });

  // Headers are held back until the first token so that a failure before then
  // (bad key, rate limit) can still be reported as a real HTTP status
  let streaming = false;
  function beginStream() {
    if (streaming) return;
    streaming = true;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
  }

  let reply = '';
  try {
    // A turn can take more than one request: searching the web is long-running,
    // so the API may hand back stop_reason "pause_turn" partway through and
    // expect the partial reply to be sent straight back to be continued.
    const turnMessages = [...messages];

    // Built once per turn so every leg sees the same prompt
    const system = buildSystemPrompt();

    for (let leg = 0; leg < MAX_TURN_LEGS; leg++) {
      const stream = anthropic.beta.messages.stream({
        model: MODEL,
        betas: BETAS,
        fallbacks: 'default',
        // Thinking and search calls count against this too, so it can't double
        // as a speech budget without cutting replies off. The browser caps how
        // much of a reply it actually sends to ElevenLabs instead.
        max_tokens: 1000,
        system,
        output_config: { effort: EFFORT },
        tools: TOOLS,
        messages: turnMessages
      });
      currentStream = stream;

      for await (const event of stream) {
        // Tell the client a search has started, so the pause before the answer
        // reads as looking something up rather than the app having frozen
        if (event.type === 'content_block_start' &&
            event.content_block.type === 'server_tool_use') {
          beginStream();
          sendEvent(res, 'searching', { tool: event.content_block.name });
        }

        // A reply that searched comes back as several text blocks. Run together
        // they read as "look that up.Kimi", which also hides the sentence break
        // the speech chunker needs, so restore the gap between them.
        if (event.type === 'content_block_start' &&
            event.content_block.type === 'text' &&
            reply && !/\s$/.test(reply)) {
          beginStream();
          reply += ' ';
          sendEvent(res, 'delta', { text: ' ' });
        }

        // Adaptive thinking also emits deltas; only the text ones get spoken
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          beginStream();
          reply += event.delta.text;
          sendEvent(res, 'delta', { text: event.delta.text });
        }
      }

      if (aborted) return;

      // Keep the whole message, not just its text: the search calls and their
      // results have to go back verbatim for the next turn to make sense
      const final = await stream.finalMessage();
      // A reply cut off mid tool call holds a call that will never get a
      // result, which the API rejects on the next turn. Drop it.
      const content = final.stop_reason === 'tool_use'
        ? final.content
        : final.content.filter((block) => block.type !== 'tool_use');
      turnMessages.push({ role: 'assistant', content });

      if (final.stop_reason === 'pause_turn') continue;
      if (final.stop_reason !== 'tool_use') {
        if (final.stop_reason === 'refusal' && !reply.trim()) {
          throw new Error('Claude declined to answer that');
        }
        break;
      }

      // One of our own tools. Every call in the message gets its result back
      // in a single user message, then the turn carries on from there.
      const results = final.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          ...localTools.run(block, {
            onTimer: (timer) => {
              beginStream();
              sendEvent(res, 'timer', timer);
            }
          })
        }));
      turnMessages.push({ role: 'user', content: results });
    }

    if (!reply.trim()) {
      throw new Error('Claude returned no text');
    }

    // Record both sides only now that the turn has succeeded
    conversationHistory = trimHistory(turnMessages);
    saveHistory();

    beginStream();
    sendEvent(res, 'done', { reply });
    res.end();
  } catch (err) {
    if (aborted) return;
    console.error('Chat stream failed:', (err && err.stack) || err);

    const message = err instanceof Anthropic.APIError
      ? `Claude request failed: ${err.message}`
      : err.message || 'Chat request failed';

    // Once the headers are out the status line is fixed, so a mid-stream
    // failure has to be reported inside the stream instead
    if (streaming) {
      sendEvent(res, 'error', { error: message });
      res.end();
    } else {
      res.status(502).json({ error: message });
    }
  }
});

// A failed save shouldn't fail the turn the user just heard
function saveHistory() {
  try {
    store.save('history', conversationHistory);
  } catch (err) {
    console.error('Could not save conversation history:', err.message);
  }
}

// Lets the page show the conversation that was going on before a reload
app.get('/api/history', (req, res) => {
  const turns = [];
  for (const message of conversationHistory) {
    if (isUserTurn(message)) {
      turns.push({ role: 'user', text: message.content });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();
    if (!text) continue;
    // One turn can span several assistant messages; show it as one bubble
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant') last.text += ` ${text}`;
    else turns.push({ role: 'assistant', text });
  }
  res.json({ turns });
});

// The memory panel: see what has been saved about you, and delete it directly
// rather than having to ask
app.get('/api/memories', (req, res) => {
  res.json({ memories: localTools.listMemories() });
});

app.delete('/api/memories/:id', (req, res) => {
  const removed = localTools.removeMemory(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'No saved fact with that id' });
  res.json({ ok: true });
});

// Starts a fresh conversation. Saved facts about the user are kept; delete
// them from the memory panel or ask the assistant to forget them.
app.post('/api/reset', (req, res) => {
  conversationHistory = [];
  saveHistory();
  res.json({ ok: true });
});

// Proxy route: browser sends one sentence of Claude's reply here, we forward it
// to ElevenLabs and stream the generated speech audio back
app.post('/api/text-to-speech', async (req, res) => {
  const upstream = new AbortController();
  try {
    const { text } = req.body;

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'No text to speak' });
    }
    // Credits are charged per character, so a runaway request shouldn't be able
    // to spend a large slice of them at once. The client never sends chunks
    // this long; this is only a backstop.
    if (text.length > MAX_TTS_CHARS) {
      return res.status(413).json({
        error: `Too long to speak (${text.length} characters, limit ${MAX_TTS_CHARS})`
      });
    }
    if (!process.env.VOICE_ID) {
      return res.status(500).json({ error: 'VOICE_ID is not set in .env' });
    }

    // Barge-in cancels the browser's request; pass that on so we stop pulling
    // audio from ElevenLabs that nobody will hear
    res.on('close', () => {
      if (!res.writableEnded) upstream.abort();
    });

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: TTS_MODEL
        }),
        signal: upstream.signal
      }
    );

    // On failure ElevenLabs sends JSON rather than audio, so check the status
    // before treating the body as MP3 bytes
    if (!response.ok) {
      const detail = await describeUpstreamError(response);
      console.error(`ElevenLabs TTS ${response.status}:`, detail);
      return res.status(502).json({ error: `Text-to-speech failed: ${detail}` });
    }

    // Pipe the audio through as it arrives rather than buffering the whole clip
    res.set('Content-Type', 'audio/mpeg');
    const audio = Readable.fromWeb(response.body);
    // Aborting mid-clip errors this stream, and an unhandled stream error would
    // take the whole server down
    audio.on('error', () => res.end());
    audio.pipe(res);
  } catch (err) {
    if (upstream.signal.aborted) return; // the client left; nothing to report
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Text-to-speech failed' });
    } else {
      res.end();
    }
  }
});

// Tests load this file for its helpers without starting a server
if (require.main === module) {
  const local = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!local && !process.env.APP_PASSWORD) {
    console.error(`Refusing to listen on ${HOST} without APP_PASSWORD set: anyone who`);
    console.error('could reach it would be spending your API credits.');
    process.exit(1);
  }

  app.listen(PORT, HOST, () => {
    // Catch a missing .env now rather than as a confusing 401 mid-conversation
    const missing = ['ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY', 'VOICE_ID']
      .filter((name) => !process.env[name]);
    if (missing.length) {
      console.warn(`Warning: missing from .env - ${missing.join(', ')}`);
    }
    console.log(local
      ? `Server running at http://localhost:${PORT}`
      : `Server listening on ${HOST}:${PORT}, password protected`);
  });
}

module.exports = { app, trimHistory };
