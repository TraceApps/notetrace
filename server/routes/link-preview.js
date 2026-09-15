/**
 * link-preview.js: previews for links in notes.
 *
 *   GET /api/link-preview?url=         { url, title, description, site, image, icon } or 204
 *   GET /api/link-preview/image?url=   the preview image for that page
 *   GET /api/link-preview/icon?url=    the site icon for that page
 *
 * The image and icon routes don't need a session so an <img> can load them
 * on every platform; they only serve assets of pages already previewed.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { getLinkPreview, getPreviewAsset } from '../lib/link-preview.js';

const router = Router();
const previewLimit = makeRateLimiter({ max: 120, windowMs: 60_000, label: 'link-preview' });
const assetLimit = makeRateLimiter({ max: 240, windowMs: 60_000, label: 'link-preview-asset' });

router.get('/', requireAuth, previewLimit, wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (!url || url.length > 2048) return res.status(400).json({ error: 'url required' });
  const preview = await getLinkPreview(url);
  if (!preview) return res.status(204).end();
  res.set('Cache-Control', 'private, max-age=3600');
  res.json(preview);
}));

for (const kind of ['image', 'icon']) {
  router.get(`/${kind}`, assetLimit, wrap(async (req, res) => {
    const asset = await getPreviewAsset(String(req.query.url || ''), kind);
    if (!asset) return res.status(404).end();
    res.set('Content-Type', asset.type);
    res.set('Cache-Control', 'public, max-age=604800');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(asset.body);
  }));
}

export default router;
