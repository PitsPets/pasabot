/**
 * WAV in and out, without codecs: the browser records PCM and sends a RIFF/WAVE file (16-bit or 32-bit float,
 * any rate, mono or stereo); the engine wants mono float samples at 16 kHz; spoken replies go back as 16-bit PCM WAV.
 */

export class WavError extends Error {
  readonly code = 'bad_audio';
}

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

/** Lowest sample rate accepted (the browser records at 16 kHz); lower rates would be upsampled many times over. */
export const MIN_WAV_RATE = 8000;

export interface WavInfo {
  format: number;
  channels: number;
  rate: number;
  bits: number;
  /** sample frames in the data chunk */
  frames: number;
  /** frames / rate */
  seconds: number;
  data: Buffer;
}

/**
 * Read the header only (no sample is decoded, nothing is allocated beyond a view of `buf`), so the caller can refuse a
 * recording by its length before paying for decoding and resampling it.
 */
export function wavInfo(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new WavError('not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      let format = body.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24);
      fmt = {
        format,
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new WavError('WAV file without fmt or data');
  const { format, channels, rate, bits } = fmt;
  if (channels < 1 || channels > 8 || rate < MIN_WAV_RATE || rate > 192_000)
    throw new WavError('unsupported WAV layout');
  const pcm16 = format === 1 && bits === 16;
  const f32 = format === 3 && bits === 32;
  if (!pcm16 && !f32) throw new WavError('only 16-bit PCM or 32-bit float WAV');
  const frames = Math.floor(data.length / ((bits / 8) * channels));
  return { format, channels, rate, bits, frames, seconds: frames / rate, data };
}

/** Parse a RIFF/WAVE file to mono float samples in [-1, 1]. Only PCM 16-bit and IEEE float 32-bit. */
export function decodeWav(buf: Buffer): Pcm {
  const { format, channels, rate, bits, frames, data } = wavInfo(buf);
  const pcm16 = format === 1 && bits === 16;
  const width = bits / 8;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * width;
      sum += pcm16 ? data.readInt16LE(p) / 32768 : data.readFloatLE(p);
    }
    const v = sum / channels;
    out[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return { samples: out, sampleRate: rate };
}

/** Linear resample (speech only needs 16 kHz; good enough for recognisers, which band-limit anyway). */
export function resample(pcm: Pcm, rate: number): Pcm {
  if (pcm.sampleRate === rate) return pcm;
  const ratio = pcm.sampleRate / rate;
  const n = Math.floor(pcm.samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const a = Math.floor(x);
    const b = Math.min(a + 1, pcm.samples.length - 1);
    const t = x - a;
    out[i] = (pcm.samples[a] ?? 0) * (1 - t) + (pcm.samples[b] ?? 0) * t;
  }
  return { samples: out, sampleRate: rate };
}

/** Mono float samples to a 16-bit PCM WAV file. */
export function encodeWav(pcm: Pcm): Buffer {
  const n = pcm.samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(pcm.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm.samples[i] ?? 0));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}
