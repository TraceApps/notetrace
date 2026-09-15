import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { detectImageType } from '../lib/image-magic.js';
import { audioToolsAvailable, convertToM4a, probeDurationMs } from '../lib/audio-tools.js';

const uploadLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'upload' });


const uploadsPath = process.env.UPLOADS_PATH || './uploads';
fs.mkdirSync(uploadsPath, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
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

/** { audio_convert }: what the server can do with audio. */
router.get('/capabilities', async (req, res) => {
  res.json({ audio_convert: await audioToolsAvailable() });
});

export default router;
