/**
 * /api/v1: NoteTrace's public API (TraceApps/notetrace#42), shaped like
 * CookTrace's and NutriTrace's: an API token from Settings > API Tokens,
 * per-token rate limit, scope-gated endpoints. The token's scope is the
 * opt-in; there's no server switch.
 *
 *   GET  /api/v1/me      any token: who it belongs to, this server, its scopes
 *   POST /api/v1/notes   notes:create: add a note or a task (lib/public-notes.js)
 *
 * A token with only notes:create can add notes and nothing else: it can't
 * read, list or change any, and isn't an MCP token.
 *
 * Safe retries: send `Idempotency-Key` (1 to 200 visible characters). The
 * same key with the same body within a day answers as the first time
 * without adding another note, even if that note was deleted since; the
 * same key with a different body is a 409. Keys belong to the user, not
 * the token, and "the same body" ignores the order of its keys.
 * Without the header every request adds a note. One request is one note: a
 * checklist carries several tasks, each with its own due date, so there's no
 * batch endpoint.
 */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { wrap } from '../logger.js';
import db from '../db.js';
import { bearerAuth, requireScope } from '../middleware/bearer-auth.js';
import { checkPublicNote, createPublicNote } from '../lib/public-notes.js';

const router = Router();

/** The body with every object's keys sorted, so key order never changes the hash. */
function _canonical(v) {
  if (Array.isArray(v)) return v.map(_canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, _canonical(v[k])]));
  }
  return v;
}
router.use(bearerAuth);

let _version = null;
function _appVersion() {
  if (_version) return _version;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    _version = String(JSON.parse(readFileSync(path.resolve(dir, '..', '..', 'package.json'), 'utf8')).version || 'unknown');
  } catch { _version = 'unknown'; }
  return _version;
}

router.get('/me', wrap((req, res) => {
  const u = req.apiUser;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host') || '';
  res.json({
    user: { id: u.id, username: u.username, full_name: u.full_name || null, role: u.role || null },
    instance: { url: host ? `${proto}://${host}` : null, version: _appVersion() },
    scopes: req.apiToken.scopes,
  });
}));

const KEY_OK = /^[\x21-\x7e]{1,200}$/;
const KEEP_SQL = `datetime('now', '-1 day')`;

router.post('/notes', requireScope('notes:create'), wrap((req, res) => {
  const u = req.apiUser.id;
  const key = req.get('idempotency-key');
  if (key != null && !KEY_OK.test(key)) {
    return res.status(400).json({ error: 'Idempotency-Key is 1 to 200 visible characters.', code: 'bad_idempotency_key' });
  }
  const bodyHash = createHash('sha256').update(JSON.stringify(_canonical(req.body ?? null))).digest('hex');
  // Checked, written and remembered in one go, so a retry racing the first
  // request can't add a second note.
  const outcome = db.transaction(() => {
    if (key != null) {
      const seen = db.prepare(
        `SELECT body_hash, status, response FROM api_idempotency WHERE user_id = ? AND key = ? AND created_at > ${KEEP_SQL}`
      ).get(u, key);
      if (seen) {
        if (seen.body_hash !== bodyHash) {
          return { status: 409, body: { error: 'This Idempotency-Key was already used with a different request.', code: 'idempotency_conflict' } };
        }
        return { status: seen.status, body: JSON.parse(seen.response), replay: true };
      }
    }
    const checked = checkPublicNote(req.body, u);
    const result = checked.error
      ? { status: 400, body: { error: checked.error, code: 'invalid', ...(checked.field ? { field: checked.field } : {}) } }
      : { status: 201, body: { note: createPublicNote(u, checked) } };
    if (key != null && result.status === 201) {
      db.prepare(
        `INSERT INTO api_idempotency (user_id, key, body_hash, status, response) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET body_hash = excluded.body_hash, status = excluded.status,
           response = excluded.response, created_at = datetime('now')`
      ).run(u, key, bodyHash, result.status, JSON.stringify(result.body));
    }
    return result;
  })();
  if (outcome.replay) res.set('Idempotent-Replayed', 'true');
  res.status(outcome.status).json(outcome.body);
}));

router.use((req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

export default router;
