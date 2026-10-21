import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createToken, listTokens, revokeToken, SCOPE_DESCRIPTIONS } from '../lib/api-tokens.js';

const router = Router();
router.use(requireAuth);
router.use((req, res, next) => req.user?.id ? next() : res.status(400).json({ error: 'Capture tokens require a signed-in account.' }));
router.get('/', (req, res) => res.json({ tokens: listTokens(req.user.id).filter(t => t.scopes.length === 1 && t.scopes[0] === 'capture:write'),
  known_scopes: ['capture:write'], scope_descriptions: SCOPE_DESCRIPTIONS, mcp_state: {} }));
router.post('/', (req, res) => {
  if (req.body?.scopes?.length !== 1 || req.body.scopes[0] !== 'capture:write') return res.status(403).json({ error: 'Only capture:write tokens can be created here.' });
  const expiry = req.body.expires_at;
  if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) return res.status(400).json({ error: 'Choose a future expiration date.' });
  try {
    const { row, raw } = createToken({ userId: req.user.id, name: req.body.name, scopes: ['capture:write'], expiresAt: expiry || null });
    res.status(201).json({ token: row, raw });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const token = listTokens(req.user.id).find(t => t.id === id && t.scopes.length === 1 && t.scopes[0] === 'capture:write');
  if (!token || !revokeToken({ userId: req.user.id, id })) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
export default router;
