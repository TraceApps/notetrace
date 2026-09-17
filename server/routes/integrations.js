/**
 * integrations.js: links to other TraceApps.
 *
 *   GET    /api/integrations/cooktrace           the link (never the token)
 *   PUT    /api/integrations/cooktrace           { url, token }: check, then save
 *   DELETE /api/integrations/cooktrace           unlink
 *   GET    /api/integrations/cooktrace/shopping  the CookTrace shopping list { items }
 *   POST   /api/integrations/cooktrace/shopping  { items }: add to it → { added, skipped, names }
 *   PATCH  /api/integrations/cooktrace/shopping/:id  { checked }: check an item off, or back on
 *   DELETE /api/integrations/cooktrace/shopping/checked  clear checked items
 *
 * `items` is a checklist ([{ text, checked }]) or plain names; unchecked
 * items are sent unless `include_checked` is true.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import * as CookTrace from '../lib/cooktrace.js';
import { shoppingNames } from '../lib/cooktrace-core.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const linkLimit = makeRateLimiter({ max: 10, windowMs: 60_000, label: 'cooktrace-link' });
const sendLimit = makeRateLimiter({ max: 20, windowMs: 60_000, label: 'cooktrace-send' });

function _fail(res, e) {
  if (e instanceof CookTrace.CooktraceError) return res.status(e.status).json({ error: e.message });
  throw e;
}

router.get('/cooktrace', wrap((req, res) => {
  res.json(CookTrace.getLink(uid(req)));
}));

router.put('/cooktrace', linkLimit, wrap(async (req, res) => {
  try {
    res.json(await CookTrace.link(uid(req), req.body || {}));
  } catch (e) { _fail(res, e); }
}));

router.delete('/cooktrace', wrap((req, res) => {
  CookTrace.unlink(uid(req));
  res.json({ connected: false });
}));

const listLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'cooktrace-list' });

router.get('/cooktrace/shopping', listLimit, wrap(async (req, res) => {
  try {
    res.json(await CookTrace.listShopping(uid(req)));
  } catch (e) { _fail(res, e); }
}));

router.post('/cooktrace/shopping', sendLimit, wrap(async (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = raw.map(it => (typeof it === 'string' ? { text: it, checked: false } : it));
  const names = shoppingNames(items, { includeChecked: !!req.body?.include_checked });
  if (!names.length) return res.status(400).json({ error: 'There are no items to send.' });
  try {
    res.json({ ...(await CookTrace.addToShoppingList(uid(req), names)), names });
  } catch (e) { _fail(res, e); }
}));

router.patch('/cooktrace/shopping/:id', listLimit, wrap(async (req, res) => {
  try {
    res.json(await CookTrace.checkShoppingItem(uid(req), req.params.id, !!req.body?.checked));
  } catch (e) { _fail(res, e); }
}));

router.delete('/cooktrace/shopping/checked', sendLimit, wrap(async (req, res) => {
  try {
    res.json(await CookTrace.clearCheckedShopping(uid(req)));
  } catch (e) { _fail(res, e); }
}));

export default router;
