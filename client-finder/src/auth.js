import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db.js';

const COOKIE = 'wz_session';
const SESSION_DAYS = 14;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function upsertUser(email, password) {
  if (!email || !password || password.length < 10) {
    throw new Error('Email and a password of at least 10 characters are required.');
  }
  const existing = get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), existing.id);
    run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    return existing.id;
  }
  return Number(run('INSERT INTO users(email, password_hash) VALUES(?, ?)', email.toLowerCase(), hashPassword(password)).lastInsertRowid);
}

export function bootstrapAdmin() {
  const count = get('SELECT COUNT(*) AS n FROM users').n;
  if (count === 0 && config.adminEmail && config.adminPassword) {
    upsertUser(config.adminEmail, config.adminPassword);
    console.log(`[auth] Created owner account ${config.adminEmail}`);
  } else if (count === 0) {
    console.warn('[auth] No user exists. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run `npm run set-password -- <email> <password>`.');
  }
}

export function login(email, password) {
  const user = get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase());
  // Always run a hash to keep timing similar for unknown users.
  const ok = user ? verifyPassword(password || '', user.password_hash) : (hashPassword('x'), false);
  if (!ok) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)', sha256(token), user.id, expires);
  run("DELETE FROM sessions WHERE expires_at < ?", new Date().toISOString());
  return { token, user: { id: user.id, email: user.email }, expires };
}

export function logout(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setSessionCookie(res, token, expires) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(expires).toUTCString()}`];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
}

export function currentUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  const row = get(
    'SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    sha256(token)
  );
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, email: row.email, token };
}

/** Express middleware: require a session; for mutating requests also require
 *  the X-Requested-With header (CSRF defence in addition to SameSite=Lax). */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Missing CSRF header' });
  }
  req.user = user;
  next();
}
