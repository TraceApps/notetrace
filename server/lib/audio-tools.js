/**
 * audio-tools.js: the server's small ffmpeg (built into the Docker image with
 * only audio formats). Converts recordings a browser can't play, such as
 * Google Keep's 3GP/AMR, to M4A; reads a file's length; and splits long
 * recordings for transcription. Everything degrades to "not available" when
 * ffmpeg isn't installed (running the server outside Docker).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function _run(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

let _available = null;
/** True when ffmpeg and ffprobe run. Checked once. */
export async function audioToolsAvailable() {
  if (_available === null) {
    const [a, b] = await Promise.all([_run(FFMPEG, ['-version'], { timeoutMs: 5000 }), _run(FFPROBE, ['-version'], { timeoutMs: 5000 })]);
    _available = a.code === 0 && b.code === 0;
  }
  return _available;
}

/** A file's length in milliseconds, or null. */
export async function probeDurationMs(file) {
  if (!(await audioToolsAvailable())) return null;
  const r = await _run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 30000 });
  const secs = parseFloat(r.out);
  return r.code === 0 && Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
}

/** Convert any audio ffmpeg can read to mono AAC in M4A. Resolves true on success. */
export async function convertToM4a(input, output) {
  if (!(await audioToolsAvailable())) return false;
  const r = await _run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', output]);
  if (r.code !== 0) { try { fs.unlinkSync(output); } catch { /* nothing written */ } }
  return r.code === 0;
}

/**
 * Split a recording into pieces of about `seconds` each, without re-encoding.
 * Resolves [{ file, offset }] (offset in seconds), or null.
 */
export async function splitAudio(input, seconds, outDir) {
  if (!(await audioToolsAvailable())) return null;
  const ext = path.extname(input).toLowerCase() || '.m4a';
  const muxExt = ['.webm', '.ogg', '.opus', '.m4a', '.mp4'].includes(ext) ? ext : '.m4a';
  const base = path.join(outDir, `split-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const copy = muxExt === ext;
  const r = await _run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn',
    ...(copy ? ['-c', 'copy'] : ['-ac', '1', '-c:a', 'aac', '-b:a', '48k']),
    '-f', 'segment', '-segment_time', String(Math.max(30, Math.round(seconds))), '-reset_timestamps', '1',
    `${base}-%03d${muxExt}`]);
  const files = fs.readdirSync(outDir).filter(f => f.startsWith(path.basename(base))).sort().map(f => path.join(outDir, f));
  if (r.code !== 0 || !files.length) { files.forEach(f => { try { fs.unlinkSync(f); } catch { /* gone */ } }); return null; }
  const out = [];
  let offset = 0;
  for (const file of files) {
    out.push({ file, offset });
    offset += ((await probeDurationMs(file)) || seconds * 1000) / 1000;
  }
  return out;
}
