import nodemailer from 'nodemailer';
import db from './db.js';
import { logger } from './logger.js';

/** Seed app_config from env vars at startup (env vars take priority) */
export function seedSmtpFromEnv() {
  const map = {
    SMTP_HOST:   'smtp_host',
    SMTP_PORT:   'smtp_port',
    SMTP_SECURE: 'smtp_secure',
    SMTP_USER:   'smtp_user',
    SMTP_PASS:   'smtp_pass',
    SMTP_FROM:   'smtp_from',
  };
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  let locked = false;
  for (const [envKey, dbKey] of Object.entries(map)) {
    if (process.env[envKey] != null) {
      upsert.run(dbKey, process.env[envKey]);
      locked = true;
    }
  }
  // Store lock flag so clients can disable the UI fields
  if (locked) upsert.run('smtp_env_locked', 'true');
}

export function isSmtpEnvLocked() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('smtp_env_locked');
  return row?.value === 'true';
}

/** Read SMTP config from app_config table (env vars already seeded at startup) */
function getSmtpConfig() {
  const rows = db.prepare('SELECT key, value FROM app_config WHERE key LIKE ?').all('smtp_%');
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = value;
  return cfg;
}

// Merge stored config with any inline overrides. Empty-string overrides
// still count as "user cleared this field"; only undefined falls back
// to storage. Lets the Settings UI test unsaved form values.
function _mergedCfg(overrides) {
  const stored = getSmtpConfig();
  if (!overrides) return stored;
  const merged = { ...stored };
  for (const k of ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from']) {
    if (overrides[k] !== undefined) merged[k] = overrides[k];
  }
  return merged;
}

/** Build a nodemailer transporter from stored config (or inline overrides), or throw if not configured */
function createTransport(overrides) {
  const cfg = _mergedCfg(overrides);
  if (!cfg.smtp_host) throw new Error('Email not configured. Ask your admin to set up SMTP in Settings.');
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   parseInt(cfg.smtp_port || '587'),
    secure: cfg.smtp_secure === 'true',
    auth:   cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass || '' } : undefined,
  });
}

export async function sendMail({ to, subject, html, text }) {
  const cfg = getSmtpConfig();
  const from = cfg.smtp_from || cfg.smtp_user || 'NoteTrace <noreply@notetrace.app>';
  const transport = createTransport();
  await transport.sendMail({ from, to, subject, html, text });
}

/** Send a real branded test email to prove end-to-end delivery, not just
 *  auth. If `overrides` is provided, uses those values for the connection
 *  (so unsaved form values can be tested). Recipient priority: explicit
 *  `to` arg, then smtp_from, then smtp_user. Returns the address the
 *  email was actually sent to so the UI can show it. */
export async function testSmtp({ overrides, to, origin, recipientName } = {}) {
  const cfg = _mergedCfg(overrides);
  const from = cfg.smtp_from || cfg.smtp_user || 'NoteTrace <noreply@notetrace.app>';
  const recipient = to || cfg.smtp_from || cfg.smtp_user;
  if (!recipient) throw new Error('No recipient. Fill in a From address (or make sure your account has an email set).');
  const transport = createTransport(overrides);
  const body = _testEmailBody(recipientName);
  await transport.sendMail({
    from,
    to: recipient,
    subject: 'NoteTrace SMTP Test',
    html: emailWrapper(origin || '', body, null, 'SMTP test from your NoteTrace instance'),
    text: `Hi${recipientName ? ' ' + recipientName : ''},\n\nThis is a test email from your NoteTrace instance. If you're reading this, your SMTP settings work end-to-end. Password resets, invites, and sharing notifications will be delivered through this config.\n\nSafe to delete this email.`,
  });
  return { to: recipient };
}

// Branded body for the SMTP test email. Same wrapper + helpers as
// sendInvite / sendPasswordReset so the test proves the full email
// pipeline (including images + styling) and not just plaintext.
function _testEmailBody(name) {
  return `
    ${greeting(name)}
    <p class="nt-heading" style="margin:0 0 10px;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      SMTP Test Successful
    </p>
    <p class="nt-body-txt" style="margin:0 0 16px;font-size:15px;color:#8A93A8;line-height:1.7;">
      This is a test email from your <strong style="color:#FFFFFF;">NoteTrace</strong> instance. If you&rsquo;re reading this,
      your SMTP settings work end-to-end.
    </p>
    <p class="nt-body-txt" style="margin:0 0 24px;font-size:15px;color:#8A93A8;line-height:1.7;">
      Password resets, user invites, and sharing notifications will be
      delivered through this SMTP config.
    </p>
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      Safe to delete this email.
    </p>`;
}

export function isEmailConfigured() {
  const cfg = getSmtpConfig();
  return !!cfg.smtp_host;
}

// ── Email templates ────────────────────────────────────────────────────────

// ── Shared template helpers ────────────────────────────────────────────────

const _FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;

function emailWrapper(origin, bodyHtml, footerNote, preheaderText) {
  const logoUrl = `${origin}/icons/logo-email.png`;
  const year    = new Date().getFullYear();
  const preheader = preheaderText
    ? `<div style="display:none;font-size:1px;color:#0A0B0F;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheaderText}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <style>
    @media (prefers-color-scheme: light) {
      .nt-body     { background-color:#F4F6FA !important; }
      .nt-outer    { background-color:#F4F6FA !important; }
      .nt-header   { background-color:#F2EEFD !important; border-color:#DCD2F7 !important; }
      .nt-stripe   { background:#9A7CF0 !important; }
      .nt-card     { background-color:#FFFFFF !important; border-color:#DDE3EE !important; }
      .nt-footer   { background-color:#F0F2F7 !important; border-color:#DDE3EE !important; }
      .nt-heading  { color:#110D1A !important; }
      .nt-body-txt { color:#4B5563 !important; }
      .nt-muted    { color:#9CA3AF !important; }
      .nt-fb-url   { color:#7C5CE0 !important; }
      .nt-expiry   { color:#6B7280 !important; }
      .nt-expiry strong { color:#374151 !important; }
      .nt-section  { color:#6D4FD6 !important; }
      .nt-stat-lbl { color:#4B5563 !important; }
      .nt-stat-val { color:#111827 !important; }
      .nt-stat-div { border-color:#E5E7EB !important; }
    }
  </style>
</head>
<body class="nt-body" style="margin:0;padding:0;background-color:#0A0B0F;">
${preheader}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="nt-outer" style="background-color:#0A0B0F;">
  <tr>
    <td align="center" style="padding:48px 16px 40px;">

      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="520" style="max-width:520px;width:100%;">

        <!-- Header -->
        <tr>
          <td class="nt-header" align="center" style="background-color:#130F1D;padding:36px 40px 30px;border-radius:16px 16px 0 0;border:1px solid #2A2440;border-bottom:none;">
            <img src="${logoUrl}" alt="NoteTrace" width="60" height="60"
              style="display:block;margin:0 auto 18px;border-radius:14px;" />
            <div style="font-family:${_FONT};font-size:26px;font-weight:700;color:#FFFFFF;letter-spacing:-0.4px;line-height:1;">
              NoteTrace
            </div>
            <div style="font-family:${_FONT};font-size:11px;font-weight:600;color:#9A7CF0;letter-spacing:0.22em;text-transform:uppercase;margin-top:8px;">
              Trace Every Bite
            </div>
          </td>
        </tr>

        <!-- Accent stripe -->
        <tr>
          <td class="nt-stripe" style="background:linear-gradient(90deg,#130F1D,#9A7CF0 40%,#9A7CF0 60%,#130F1D);height:2px;border-left:1px solid #2A2440;border-right:1px solid #2A2440;"></td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="nt-card" style="background-color:#111318;padding:36px 40px;border-left:1px solid #1E2330;border-right:1px solid #1E2330;font-family:${_FONT};">
            ${bodyHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="nt-footer" style="background-color:#0D0F14;padding:22px 40px 28px;border-radius:0 0 16px 16px;border:1px solid #1A1F2E;border-top:1px solid #252D3D;">
            ${footerNote ? `<p class="nt-muted" style="margin:0 0 10px;font-family:${_FONT};font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">${footerNote}</p>` : ''}
            <p class="nt-muted" style="margin:0;font-family:${_FONT};font-size:11px;color:#323850;text-align:center;">
              &copy; ${year} NoteTrace &nbsp;&middot;&nbsp; Self-hosted &nbsp;&middot;&nbsp; Your data, your rules
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function greeting(name) {
  return `<p class="nt-body-txt" style="margin:0 0 20px;font-size:15px;color:#8A93A8;line-height:1.7;">
    Hi${name ? ' <strong style="color:#FFFFFF;">' + name + '</strong>' : ''},
  </p>`;
}

function ctaButton(href, label) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" style="border-radius:10px;background-color:#9A7CF0;">
          <a href="${href}"
            style="display:inline-block;padding:14px 36px;font-family:${_FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;letter-spacing:0.01em;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

function fallbackUrl(url) {
  return `<p class="nt-expiry" style="margin:24px 0 0;font-family:${_FONT};font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">
    Button not working? Copy this link into your browser:<br/>
    <a class="nt-fb-url" href="${url}" style="color:#9A7CF0;word-break:break-all;font-size:11px;">${url}</a>
  </p>`;
}

// ── Templates ──────────────────────────────────────────────────────────────

export async function sendPasswordReset(email, resetUrl) {
  const origin = new URL(resetUrl).origin;
  const body = `
    ${greeting(null)}
    <p class="nt-heading" style="margin:0 0 10px;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      Password Reset Requested
    </p>
    <p class="nt-body-txt" style="margin:0 0 28px;font-size:15px;color:#8A93A8;line-height:1.7;">
      We received a request to reset the password for your NoteTrace account.
      Click the button below to choose a new password.
    </p>
    ${ctaButton(resetUrl, 'Reset My Password')}
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      This link expires in <strong style="color:#8A93A8;">1 hour</strong>.
      If you didn&rsquo;t request this, you can safely ignore this email.
    </p>
    ${fallbackUrl(resetUrl)}`;

  await sendMail({
    to: email,
    subject: 'Reset your NoteTrace password',
    html: emailWrapper(origin, body, null, 'Reset your NoteTrace password — this link expires in 1 hour.'),
    text: `Reset your NoteTrace password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

export async function sendInvite(email, inviteUrl, inviterName) {
  const origin  = new URL(inviteUrl).origin;
  const sender  = inviterName
    ? `<strong style="color:#FFFFFF;">${inviterName}</strong> has invited you to join`
    : `You&rsquo;ve been invited to join`;

  const body = `
    ${greeting(null)}
    <p class="nt-heading" style="margin:0 0 10px;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      You&rsquo;re Invited
    </p>
    <p class="nt-body-txt" style="margin:0 0 16px;font-size:15px;color:#8A93A8;line-height:1.7;">
      ${sender} <strong style="color:#FFFFFF;">NoteTrace</strong>, a self-hosted notes app
      where your notes, lists, and reminders live on your own server and nowhere else.
    </p>
    <p class="nt-body-txt" style="margin:0 0 32px;font-size:15px;color:#8A93A8;line-height:1.7;">
      Capture a thought in seconds, keep shared lists in sync with your household, and
      find anything later, beautifully and privately.
    </p>
    ${ctaButton(inviteUrl, 'Accept Invitation')}
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      This invitation expires in <strong style="color:#8A93A8;">7 days</strong>.
    </p>
    ${fallbackUrl(inviteUrl)}`;

  await sendMail({
    to: email,
    subject: `You've been invited to NoteTrace`,
    html: emailWrapper(origin, body, null, `${inviterName || 'Someone'} invited you to NoteTrace, accept within 7 days.`),
    text: `${inviterName ? inviterName + ' has invited you' : "You've been invited"} to join NoteTrace.\n\nAccept your invitation:\n${inviteUrl}\n\nThis invite expires in 7 days.`,
  });
}
