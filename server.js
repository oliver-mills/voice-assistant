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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});