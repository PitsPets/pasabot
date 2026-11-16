// The speech process (W17): speech-to-text and text-to-speech run here, never in the server process, so a native
// crash, an out-of-memory model or a hung decode ends this process only (the server answers 503 and starts a fresh
// one on the next call). Config comes as JSON in argv[2]; requests and replies use the IPC channel
// (`serialization: 'advanced'`, so samples travel as Float32Array).
//
// Drivers:
// - `sherpa`: sherpa-onnx-node (optional dependency) with the models the owner downloaded (whisper for STT,
//   piper/VITS for TTS). Missing package or model files -> that half reports `unavailable`.
// - `fake`: for tests and the e2e server. STT looks the audio up in `fakeTranscripts` (sha256 of the 16 kHz float
//   samples -> text) and otherwise answers `fakeDefault`; TTS returns a short tone whose length follows the text.
import { createHash } from 'node:crypto';

const config = JSON.parse(process.argv[2] ?? '{}');

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

async function sherpaDriver() {
  let sherpa;
  try {
    const m = await import('sherpa-onnx-node');
    sherpa = m.default ?? m;
  } catch {
    sherpa = null;
  }
  let recognizer = null;
  let tts = null;
  return {
    stt(samples, sampleRate) {
      if (!sherpa) fail('unavailable', 'the sherpa-onnx package is not installed');
      const s = config.stt;
      if (!s) fail('unavailable', 'no speech-to-text model installed');
      if (!recognizer)
        recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            whisper: {
              encoder: s.encoder,
              decoder: s.decoder,
              language: s.language ?? '',
              task: 'transcribe',
            },
            tokens: s.tokens,
            numThreads: 2,
            provider: 'cpu',
            debug: 0,
          },
        });
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate, samples });
      recognizer.decode(stream);
      return String(recognizer.getResult(stream).text ?? '').trim();
    },
    tts(text) {
      if (!sherpa) fail('unavailable', 'the sherpa-onnx package is not installed');
      const t = config.tts;
      if (!t) fail('unavailable', 'no text-to-speech voice installed');
      if (!tts)
        tts = new sherpa.OfflineTts({
          model: {
            vits: { model: t.model, tokens: t.tokens, dataDir: t.dataDir ?? '' },
            numThreads: 1,
            provider: 'cpu',
            debug: 0,
          },
          maxNumSentences: 1,
        });
      const a = tts.generate({ text, sid: 0, speed: 1.0 });
      return { samples: Float32Array.from(a.samples), sampleRate: a.sampleRate };
    },
  };
}

function fakeDriver() {
  const map = config.fakeTranscripts ?? {};
  return {
    stt(samples) {
      const sha = createHash('sha256')
        .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
        .digest('hex');
      return map[sha] ?? config.fakeDefault ?? '';
    },
    tts(text) {
      // tests: a call that never ends (crash and time-limit proofs); the fake driver only
      if (text === '__hang__') for (;;) {}
      const sampleRate = 16000;
      const secs = Math.min(10, 0.25 + text.length * 0.04);
      const n = Math.floor(sampleRate * secs);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      return { samples, sampleRate };
    },
  };
}

const driver = config.driver === 'sherpa' ? await sherpaDriver() : fakeDriver();

process.on('message', (msg) => {
  const { id, op } = msg;
  try {
    let result;
    if (op === 'stt') result = { text: driver.stt(msg.samples, msg.sampleRate) };
    else if (op === 'tts') result = driver.tts(msg.text);
    // names only, never values: lets tests prove the server's secrets are not in this process
    else if (op === 'ping') result = { pid: process.pid, envKeys: Object.keys(process.env) };
    else fail('bad_op', `unknown op ${op}`);
    process.send({ id, ok: true, result });
  } catch (e) {
    process.send({
      id,
      ok: false,
      error: { code: e.code ?? 'engine_error', message: String(e.message ?? e) },
    });
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
