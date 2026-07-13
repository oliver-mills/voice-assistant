require('dotenv').config();
const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer(); // handles file uploads in memory
const PORT = 3000;

// Serve our HTML/CSS/JS files
app.use(express.static('.'));

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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});