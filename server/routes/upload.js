import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { detectImageType } from '../lib/image-magic.js';
import { safeUploadExtension } from '../lib/upload-paths.js';
import { audioToolsAvailable, convertToM4a, probeDurationMs, splitAudio } from '../lib/audio-tools.js';

const uploadLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'upload' });


const uploadsPath = process.env.UPLOADS_PATH || './uploads';
fs.mkdirSync(uploadsPath, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsPath),
  filename: (req, file, cb) => {
    const ext = safeUploadExtension(file.mimetype, file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

// 100MB cap — recipe images stay tiny but video instructions can be
// chunky (5-min smartphone clip ≈ 50MB). Authenticated users only,
// per-user disk cost stays bounded.
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    if (file.mimetype.startsWith('video/')) return cb(null, true);
    if (file.mimetype.startsWith('audio/')) return cb(null, true);
    cb(new Error('Images, audio, or videos only'));
  },
});

/** An /uploads/<file> URL to its path on disk, or null (no directories, no escaping). */
export function uploadFilePath(url) {
  const m = String(url || '').match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
  if (!m || m[1].startsWith('.')) return null;
  const file = path.join(uploadsPath, m[1]);
  return fs.existsSync(file) ? file : null;
}

// Pieces of long recordings, kept a few hours for the app to transcribe.
const splitDir = path.join(uploadsPath, 'split-tmp');
function _cleanSplits() {
  try {
    const cutoff = Date.now() - 3 * 3600 * 1000;
    for (const f of fs.readdirSync(splitDir)) {
      const p = path.join(splitDir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* nothing to clean */ }
}

const router = Router();
router.use(requireAuth);

router.post('/', uploadLimit, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Video uploads skip the image magic-byte check. The route is auth-
    // gated and the MIME prefix already filtered for video/*; magic-byte
    // identification across mp4/webm/mov/m4v variants is messy enough
    // that we trust the (authenticated) client here.
    if (/^(video|audio)\//.test(req.file.mimetype || '')) {
      return res.json({ url: `/uploads/${req.file.filename}` });
    }

    // Image path: byte-inspect to reject anything spoofed.
    let detected = null;
    try {
      detected = await detectImageType(req.file.path);
    } catch (e) {
      // Fall through to the rejection branch below.
    }
    if (!detected) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({
        error: 'File is not a supported image (JPEG, PNG, WebP, GIF, HEIC, AVIF, BMP).',
      });
    }
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

// Audio from a file or an import. ?convert=1 turns a format browsers can't play
// (Keep's 3GP/AMR and the like) into M4A. Replies { url, mime, duration_ms }.
router.post('/audio', uploadLimit, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const src = req.file.path;
    const convert = req.query.convert === '1';
    if (!convert) {
      return res.json({ url: `/uploads/${req.file.filename}`, mime: req.file.mimetype, duration_ms: await probeDurationMs(src) });
    }
    if (!(await audioToolsAvailable())) {
      try { fs.unlinkSync(src); } catch {}
      return res.status(501).json({ error: 'This server can\'t convert audio (ffmpeg isn\'t installed).' });
    }
    const name = `${path.basename(req.file.filename, path.extname(req.file.filename))}.m4a`;
    const dest = path.join(uploadsPath, name);
    const ok = await convertToM4a(src, dest);
    try { fs.unlinkSync(src); } catch {}
    if (!ok) return res.status(415).json({ error: 'That audio file couldn\'t be read.' });
    res.json({ url: `/uploads/${name}`, mime: 'audio/mp4', duration_ms: await probeDurationMs(dest) });
  });
});

// A long voice note in pieces, for transcribing with a provider's size limit.
// Body: { url, seconds }. Replies { pieces: [{ url, offset }] } (offset in seconds).
router.post('/split', uploadLimit, async (req, res) => {
  const file = uploadFilePath(req.body?.url);
  if (!file) return res.status(400).json({ error: 'An uploaded voice note is required' });
  if (!(await audioToolsAvailable())) return res.status(501).json({ error: 'This server can\'t split audio (ffmpeg isn\'t installed).' });
  _cleanSplits();
  const pieces = await splitAudio(file, Number(req.body?.seconds) || 600, splitDir);
  if (!pieces) return res.status(415).json({ error: 'That recording couldn\'t be split.' });
  res.json({ pieces: pieces.map(p => ({ url: `/uploads/split-tmp/${path.basename(p.file)}`, offset: p.offset })) });
});

/** { audio_convert }: what the server can do with audio. */
router.get('/capabilities', async (req, res) => {
  res.json({ audio_convert: await audioToolsAvailable() });
});

export default router;
