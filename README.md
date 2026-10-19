# Voice Assistant

A voice assistant in the browser. Hold the button (or space) and talk, or turn
on hands-free and just speak. Claude answers out loud, a sentence at a time as
the reply streams in, and you can talk over it to interrupt.

- **Thinking:** Claude, with web search for anything current
- **Hearing:** the browser's own speech recognition (free), or ElevenLabs
- **Speaking:** ElevenLabs, or the browser's own voice (free)
- **Remembers** facts you tell it across conversations, and keeps the
  conversation across restarts
- **Timers and reminders** that chime in the page

## Setup

Needs Node 20 or newer.

```sh
npm install
cp .env.example .env   # then fill in the keys
npm start
```

Open <http://localhost:3000> in Chrome, Edge or Safari. Firefox works too, but
has no speech recognition, so hearing always goes through ElevenLabs there.

| Variable | |
| --- | --- |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `ELEVENLABS_API_KEY` | From elevenlabs.io |
| `VOICE_ID` | An ElevenLabs voice, from the Voice Library |
| `ELEVENLABS_TTS_MODEL` | Optional. `eleven_flash_v2_5` is faster and cheaper; `eleven_multilingual_v2` (default) sounds better |
| `HOST`, `APP_PASSWORD` | Optional. See [Running it beyond this machine](#running-it-beyond-this-machine) |
| `PORT` | Optional, default 3000 |
| `DATA_DIR` | Optional. Where history and saved facts live, default `./data` |

## Keeping ElevenLabs usage down

The free tier runs out quickly, so the app tries hard not to spend it:

- **Hearing defaults to the browser**, which is free. ElevenLabs only gets the
  recording if browser recognition fails outright. Switch with the Hearing picker.
- **Voice: Browser** in the header makes a session entirely ElevenLabs-free,
  which is the way to test changes.
- Speech is requested one sentence ahead of what is playing, so interrupting
  only wastes the sentence in flight.
- A reply stops being spoken after 700 characters (the rest stays in the
  transcript), and the server refuses any single request over 400.
- Hands-free ignores clips with little actual voice in them (coughs, doors),
  and trims trailing silence before anything is sent for transcription.
- Replay reuses the audio already fetched.

Tune these in `public/app.js` (`MAX_SPOKEN_CHARS`, `TTS_LOOKAHEAD`,
`VAD_MIN_VOICED_FRAMES`) and `server.js` (`MAX_TTS_CHARS`).

## Memory

Say "remember that..." and it saves the fact to `data/memories.json`, then
includes it in every conversation after. Ask it to forget something and it
will. **New chat** clears the conversation but keeps saved facts.

The conversation itself is kept in `data/history.json` (the last 40 messages).
`data/` is git-ignored and holds everything you have said to it, so treat it
as private.

## Running it beyond this machine

By default the server only listens on localhost. To reach it from elsewhere,
set `HOST` (e.g. `0.0.0.0`) and `APP_PASSWORD`; it refuses to start on a
non-local address without a password, since anyone who could reach it would
be spending your credits. The browser asks for the password once (any
username).

Browsers only allow the microphone on `https://` pages or localhost, so a
deployment needs HTTPS in front of it, for example a reverse proxy or a
hosting platform that terminates TLS. Basic auth over plain HTTP sends the
password in the clear.

## Development

```sh
npm test
```

The tests use fake keys and a fake `fetch`, so they never call Anthropic or
ElevenLabs.

| File | |
| --- | --- |
| `server.js` | Express server: proxies to ElevenLabs, streams Claude's replies over server-sent events, runs the turn loop |
| `tools.js` | The tools Claude can call that run here: `remember`, `forget`, `set_timer` |
| `store.js` | Reads and writes the JSON files in `data/` |
| `public/app.js` | Recording, hands-free detection, speech playback, transcript |
| `public/speech-utils.js` | Pure helpers shared with the tests: sentence chunking, WAV encoding |
