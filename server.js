require('dotenv').config();
const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer(); // handles file uploads in memory
const PORT = 3000;

// Serve our HTML/CSS/JS files
app.use(express.static('.'));
app.use(express.json());

// Proxy route: browser sends audio here, we forward it to ElevenLabs
app.post('/api/speech-to-text', upload.single('file'), async (req, res) => {
  try {
    const formData = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
    formData.append('file', audioBlob, 'recording.webm');
    formData.append('model_id', 'scribe_v1');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: formData
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { text } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [
          { role: 'user', content: text }
        ]
      })
    });

    const data = await response.json();
    const reply = data.content[0].text;
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chat request failed' });
  }
});

// Proxy route: browser sends Claude's reply text here, we forward it to
// ElevenLabs and stream the generated speech audio back
app.post('/api/text-to-speech', async (req, res) => {
  try {
    const { text } = req.body;

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
  console.log(`Server running at http://localhost:${PORT}`);
});