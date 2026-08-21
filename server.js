require('dotenv').config();
const express = require('express');
const multer = require('multer');

const app = express();
// Uploads are held in memory, so cap the size to keep a runaway recording
// from ballooning the process
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = 3000;

// Serve our HTML/CSS/JS files
app.use(express.static('.'));
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
  'and offer to go into more detail.'
].join(' ');

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

// Holds the whole back-and-forth for the life of the server process, so
// Claude gets prior turns as context instead of seeing each message in isolation
let conversationHistory = [];
// Long sessions would otherwise resend an ever-growing history on every turn
const MAX_HISTORY_MESSAGES = 40;

function trimHistory(messages) {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  // The API requires the first message to be from the user, and slicing can
  // land mid-pair, so drop a leading assistant turn if trimming created one
  return recent[0]?.role === 'assistant' ? recent.slice(1) : recent;
}

app.post('/api/chat', async (req, res) => {
  try {
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    if (!response.ok) {
      const detail = await describeUpstreamError(response);
      console.error(`Anthropic ${response.status}:`, detail);
      return res.status(502).json({ error: `Claude request failed: ${detail}` });
    }

    const data = await response.json();
    const reply = data.content?.find((block) => block.type === 'text')?.text;

    if (!reply) {
      console.error('No text block in Claude response:', JSON.stringify(data));
      return res.status(502).json({ error: 'Claude returned no text' });
    }

    // Record both sides only now that the turn has succeeded
    conversationHistory = trimHistory([
      ...messages,
      { role: 'assistant', content: reply }
    ]);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chat request failed' });
  }
});

// Starts a fresh conversation without restarting the server
app.post('/api/reset', (req, res) => {
  conversationHistory = [];
  res.json({ ok: true });
});

// Proxy route: browser sends Claude's reply text here, we forward it to
// ElevenLabs and stream the generated speech audio back
app.post('/api/text-to-speech', async (req, res) => {
  try {
    const { text } = req.body;

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'No text to speak' });
    }
    if (!process.env.VOICE_ID) {
      return res.status(500).json({ error: 'VOICE_ID is not set in .env' });
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2'
        })
      }
    );

    // On failure ElevenLabs sends JSON rather than audio, so check the status
    // before treating the body as MP3 bytes
    if (!response.ok) {
      const detail = await describeUpstreamError(response);
      console.error(`ElevenLabs TTS ${response.status}:`, detail);
      return res.status(502).json({ error: `Text-to-speech failed: ${detail}` });
    }

    // ElevenLabs returns raw MP3 bytes, not JSON, so we read it as a
    // binary buffer and pass it straight through to the browser
    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Text-to-speech failed' });
  }
});

app.listen(PORT, () => {
  // Catch a missing .env now rather than as a confusing 401 mid-conversation
  const missing = ['ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY', 'VOICE_ID']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    console.warn(`Warning: missing from .env - ${missing.join(', ')}`);
  }
  console.log(`Server running at http://localhost:${PORT}`);
});
