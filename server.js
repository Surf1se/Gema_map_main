import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const lifetime = 7 * 24 * 60 * 60 * 1000;
const freshness = 90_000;

export function createApp({ database = join(root, '.data', 'gema.sqlite'), secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);`);
  const app = express();
  const clients = new Map();
  const positions = new Map();
  const attempts = new Map();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=(self)',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Запрос с другого сайта запрещён.' });
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Недопустимый источник запроса.' });
    }
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  function auth(req, res, next) {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('gema_session='))?.slice(13);
    const session = cookie && db.prepare('SELECT users.id, users.name, sessions.token FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires_at>?').get(digest(cookie), Date.now());
    if (!session) return res.status(401).json({ error: 'Войдите в аккаунт.' });
    req.user = session;
    next();
  }
  function issueSession(res, user) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user.id, Date.now() + lifetime);
    res.cookie('gema_session', token, { httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: lifetime, path: '/' });
    return { id: user.id, name: user.name };
  }
  function rateLimit(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + 60_000 }; attempts.set(key, entry); }
    if (++entry.count > 20) return res.status(429).json({ error: 'Слишком много попыток. Подождите минуту.' });
    next();
  }
  const credentials = body => typeof body.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) && body.email.length <= 254 && typeof body.password === 'string' && body.password.length >= 10 && body.password.length <= 128;
  app.post('/api/register', rateLimit, async (req, res) => {
    const body = req.body || {};
    if (!credentials(body) || typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 40 || body.sharingConsent !== true)
      return res.status(400).json({ error: 'Укажите имя (2–40 символов), email, пароль (10–128 символов) и согласие с условиями передачи геопозиции.' });
    const email = body.email.trim().toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(body.password, salt, 64)).toString('hex');
    let id;
    try {
      id = Number(db.prepare('INSERT INTO users (name,email,password,created_at) VALUES (?,?,?,?)').run(body.name.trim(), email, `${salt}:${hash}`, Date.now()).lastInsertRowid);
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE')) return res.status(409).json({ error: 'Этот email уже зарегистрирован.' });
      throw error;
    }
    res.status(201).json({ user: issueSession(res, { id, name: body.name.trim() }) });
  });
  app.post('/api/login', rateLimit, async (req, res) => {
    const body = req.body || {};
    if (!credentials(body)) return res.status(400).json({ error: 'Укажите корректный email и пароль (10–128 символов).' });
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(body.email.trim().toLowerCase());
    const [salt, expected] = user ? user.password.split(':') : ['invalid-user-salt', '00'.repeat(64)];
    const actual = await scrypt(body.password, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')) || !user) return res.status(401).json({ error: 'Неверный email или пароль.' });
    res.json({ user: issueSession(res, user) });
  });
  app.get('/api/me', auth, (req, res) => res.json({ user: { id: req.user.id, name: req.user.name } }));
  const snapshot = () => [...positions.values()].filter(p => Date.now() - p.observedAt < freshness);
  function broadcast() {
    const data = `data: ${JSON.stringify({ positions: snapshot() })}\n\n`;
    for (const [res] of clients) res.write(data);
  }
  app.get('/api/events', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    clients.set(res, req.user.token);
    res.write(`data: ${JSON.stringify({ positions: snapshot() })}\n\n`);
    req.on('close', () => clients.delete(res));
  });
  app.post('/api/location', auth, (req, res) => {
    const { latitude, longitude, accuracy, observedAt } = req.body || {};
    if (![latitude, longitude, accuracy, observedAt].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 100_000 || observedAt > Date.now() + 10_000 || Date.now() - observedAt > 60_000)
      return res.status(400).json({ error: 'Нужны свежие корректные координаты.' });
    positions.set(req.user.id, { id: req.user.id, name: req.user.name, latitude, longitude, accuracy, observedAt });
    broadcast();
    res.sendStatus(204);
  });
  app.post('/api/location/stop', auth, (req, res) => { positions.delete(req.user.id); broadcast(); res.sendStatus(204); });
  app.post('/api/logout', auth, (req, res) => {
    positions.delete(req.user.id);
    db.prepare('DELETE FROM sessions WHERE token=?').run(req.user.token);
    for (const [client, token] of clients) if (token === req.user.token) { client.end(); clients.delete(client); }
    broadcast();
    res.clearCookie('gema_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies });
    res.sendStatus(204);
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/vendor/leaflet', express.static(join(root, 'node_modules/leaflet/dist')));
  app.use(express.static(join(root, 'public')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ error: error.type === 'entity.parse.failed' ? 'Некорректный JSON.' : 'Ошибка сервера. Попробуйте позже.' });
  });
  const timer = setInterval(() => {
    let changed = false;
    for (const [id, position] of positions) if (Date.now() - position.observedAt >= freshness) { positions.delete(id); changed = true; }
    for (const [key, entry] of attempts) if (entry.until < Date.now()) attempts.delete(key);
    for (const [res, token] of clients) {
      if (!db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires_at>?').get(token, Date.now())) { res.end(); clients.delete(res); }
      else res.write(': heartbeat\n\n');
    }
    if (changed) broadcast();
  }, 10_000);
  timer.unref();
  return { app, close() { clearInterval(timer); for (const [res] of clients) res.end(); db.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Gema Map listening on port ${port}`));
}
