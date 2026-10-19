import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaceIndex, nextMoscowReset, parsePost, regionNameForCode } from './lib/alerts.js';
import { lookupBoundary } from './lib/boundaries.js';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const lifetime = 7 * 24 * 60 * 60 * 1000;
let cachedPlaces;

export function createApp({ database = join(root, '.data', 'gema.sqlite'), secureCookies = process.env.NODE_ENV === 'production', boundaryLookup = lookupBoundary, yandexTilesKey = process.env.YANDEX_TILES_API_KEY } = {}) {
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS alerts (message_id TEXT PRIMARY KEY, place_id INTEGER NOT NULL, place_name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, radius INTEGER NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, region_code TEXT, area_type TEXT NOT NULL DEFAULT 'settlement');
    CREATE TABLE IF NOT EXISTS alert_clearances (place_id TEXT PRIMARY KEY, cleared_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recent_clearances (source TEXT NOT NULL, place_id INTEGER NOT NULL, place_name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, radius INTEGER NOT NULL, region_code TEXT, area_type TEXT NOT NULL, cleared_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(source,place_id));
    CREATE TABLE IF NOT EXISTS place_boundaries (place_id INTEGER PRIMARY KEY, geometry TEXT, retry_after INTEGER NOT NULL);`);
  db.prepare('DELETE FROM alerts WHERE expires_at<=?').run(Date.now());
  db.prepare('DELETE FROM recent_clearances WHERE expires_at<=?').run(Date.now());
  const places = cachedPlaces ||= loadPlaceIndex();
  if (!db.prepare('PRAGMA table_info(alerts)').all().some(column => column.name === 'region_code')) db.exec('ALTER TABLE alerts ADD COLUMN region_code TEXT');
  if (!db.prepare('PRAGMA table_info(alerts)').all().some(column => column.name === 'area_type')) db.exec("ALTER TABLE alerts ADD COLUMN area_type TEXT NOT NULL DEFAULT 'settlement'");
  db.exec("UPDATE alerts SET message_id='radar_moscoww:'||message_id||':'||place_id WHERE instr(message_id,':')=0");
  db.exec("UPDATE alert_clearances SET place_id='radar_moscoww:'||place_id WHERE instr(place_id,':')=0");
  const oldAlerts = db.prepare('SELECT message_id,place_id FROM alerts WHERE region_code IS NULL').all();
  if (oldAlerts.length) {
    const regionById = new Map([...places.values()].flat().map(place => [place.id, place.region]));
    for (const alert of oldAlerts) db.prepare('UPDATE alerts SET region_code=? WHERE message_id=?').run(regionById.get(alert.place_id) || null, alert.message_id);
  }
  const app = express();
  const clients = new Map();
  const attempts = new Map();
  let closed = false;
  let feedStatus = 'off';
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org https://tiles.api-maps.yandex.ru; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Запрос с другого сайта запрещён.' });
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Недопустимый источник запроса.' });
    }
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.get('/api/map-config', (req, res) => res.json(yandexTilesKey?.trim() ? { provider: 'yandex', key: yandexTilesKey.trim() } : { provider: 'openstreetmap' }));
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
    if (!credentials(body) || typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 40)
      return res.status(400).json({ error: 'Укажите имя (2–40 символов), email и пароль (10–128 символов).' });
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
  const onlineCount = () => new Set([...clients.values()].map(client => client.userId)).size;
  const alerts = () => db.prepare('SELECT a.message_id AS messageKey, a.place_id AS placeId, a.place_name AS place, a.area_type AS areaType, a.latitude, a.longitude, a.radius, a.observed_at AS observedAt, b.geometry AS boundaryJson FROM alerts a LEFT JOIN place_boundaries b ON b.place_id=a.place_id WHERE a.expires_at>? ORDER BY a.observed_at DESC').all(Date.now())
    .map(({ messageKey, boundaryJson, ...alert }) => ({ ...alert, source: messageKey.split(':')[0], messageId: messageKey.split(':')[1], boundary: boundaryJson ? JSON.parse(boundaryJson) : null }));
  const clearances = () => db.prepare('SELECT c.place_id AS placeId, c.place_name AS place, c.area_type AS areaType, c.latitude, c.longitude, c.radius, c.cleared_at AS observedAt, c.expires_at AS expiresAt, b.geometry AS boundaryJson FROM recent_clearances c LEFT JOIN place_boundaries b ON b.place_id=c.place_id WHERE c.expires_at>? ORDER BY c.cleared_at DESC').all(Date.now())
    .map(({ boundaryJson, ...clearance }) => ({ ...clearance, boundary: boundaryJson ? JSON.parse(boundaryJson) : null }));
  function broadcast() {
    if (closed) return;
    const data = `data: ${JSON.stringify({ online: onlineCount(), alerts: alerts(), clearances: clearances(), feedStatus })}\n\n`;
    for (const [res] of clients) res.write(data);
  }
  let clearanceTimer;
  function scheduleClearanceExpiry() {
    clearTimeout(clearanceTimer);
    const next = db.prepare('SELECT min(expires_at) AS time FROM recent_clearances WHERE expires_at>?').get(Date.now()).time;
    if (next === null) return;
    clearanceTimer = setTimeout(() => {
      db.prepare('DELETE FROM recent_clearances WHERE expires_at<=?').run(Date.now());
      broadcast();
      scheduleClearanceExpiry();
    }, Math.max(1, next - Date.now()));
    clearanceTimer.unref();
  }
  scheduleClearanceExpiry();
  const pendingBoundaries = new Set();
  let boundaryQueue = Promise.resolve();
  let nextBoundaryRequestAt = 0;
  function scheduleBoundary(place) {
    const cached = db.prepare('SELECT retry_after FROM place_boundaries WHERE place_id=?').get(place.id);
    if (cached?.retry_after > Date.now() || pendingBoundaries.has(place.id)) return;
    pendingBoundaries.add(place.id);
    boundaryQueue = boundaryQueue.then(async () => {
      const wait = nextBoundaryRequestAt - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (closed) return;
      nextBoundaryRequestAt = Date.now() + 1100;
      let geometry = null;
      let retryAfter = Date.now() + 7 * 86_400_000;
      try { geometry = await boundaryLookup({ ...place, regionName: regionNameForCode(place.region) }); }
      catch (error) {
        retryAfter = Date.now() + 10 * 60_000;
        console.warn(`Не удалось получить контур для ${place.name}: ${error.message}`);
      }
      if (closed) return;
      const previous = db.prepare('SELECT geometry FROM place_boundaries WHERE place_id=?').get(place.id)?.geometry || null;
      const encoded = geometry ? JSON.stringify(geometry) : null;
      db.prepare('INSERT INTO place_boundaries VALUES (?,?,?) ON CONFLICT(place_id) DO UPDATE SET geometry=excluded.geometry,retry_after=excluded.retry_after')
        .run(place.id, encoded, retryAfter);
      if (encoded !== previous) broadcast();
    }).catch(error => console.error(`Ошибка обработки контура: ${error.message}`)).finally(() => pendingBoundaries.delete(place.id));
  }
  for (const place of db.prepare("SELECT DISTINCT place_id AS id, place_name AS name, latitude, longitude, radius, region_code AS region, area_type AS areaType FROM alerts WHERE expires_at>? AND area_type!='settlement'").all(Date.now())) scheduleBoundary(place);
  function setFeedStatus(status) {
    if (!['off', 'connecting', 'connected', 'error'].includes(status)) return;
    if (status === feedStatus) return;
    feedStatus = status;
    broadcast();
  }
  function applyPost({ source = 'radar_moscoww', id, text, date }) {
    const messageId = String(id);
    const observedAt = Number(date);
    if (!['radar_moscoww', 'radarrussiia'].includes(source) || !/^\d+$/.test(messageId) || !Number.isFinite(observedAt) || observedAt > Date.now() + 60_000) return;
    const parsed = parsePost(text, places);
    if (parsed.kind !== 'clear') db.prepare('DELETE FROM alerts WHERE message_id GLOB ?').run(`${source}:${messageId}:*`);
    if (parsed.kind === 'clear') {
      const scopes = parsed.places.length ? parsed.places.map(place => place.areaType === 'region' ? `region:${place.region}` : String(place.id)) : parsed.regions.length ? parsed.regions.map(code => `region:${code}`) : ['*'];
      for (const scope of scopes) db.prepare('INSERT INTO alert_clearances (place_id,cleared_at) VALUES (?,?) ON CONFLICT(place_id) DO UPDATE SET cleared_at=max(cleared_at,excluded.cleared_at)').run(`${source}:${scope}`, observedAt);
      const affected = parsed.places.length
        ? db.prepare('SELECT * FROM alerts WHERE message_id GLOB ? AND observed_at<=?').all(`${source}:*`, observedAt).filter(alert => parsed.places.some(place => place.areaType === 'region' ? alert.region_code === place.region : alert.place_id === place.id))
        : parsed.regions.length
          ? db.prepare('SELECT * FROM alerts WHERE message_id GLOB ? AND observed_at<=?').all(`${source}:*`, observedAt).filter(alert => parsed.regions.includes(alert.region_code))
          : db.prepare('SELECT * FROM alerts WHERE message_id GLOB ? AND observed_at<=?').all(`${source}:*`, observedAt);
      db.prepare('DELETE FROM alerts WHERE message_id GLOB ?').run(`${source}:${messageId}:*`);
      if (observedAt + 5 * 60_000 > Date.now()) for (const alert of affected) {
        db.prepare('INSERT INTO recent_clearances (source,place_id,place_name,latitude,longitude,radius,region_code,area_type,cleared_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,place_id) DO UPDATE SET place_name=excluded.place_name,latitude=excluded.latitude,longitude=excluded.longitude,radius=excluded.radius,region_code=excluded.region_code,area_type=excluded.area_type,cleared_at=max(cleared_at,excluded.cleared_at),expires_at=max(expires_at,excluded.expires_at)')
          .run(source, alert.place_id, alert.place_name, alert.latitude, alert.longitude, alert.radius, alert.region_code, alert.area_type, observedAt, observedAt + 5 * 60_000);
      }
      if (parsed.places.length) for (const place of parsed.places) {
        if (place.areaType === 'region') db.prepare('DELETE FROM alerts WHERE message_id GLOB ? AND region_code=? AND observed_at<=?').run(`${source}:*`, place.region, observedAt);
        else db.prepare('DELETE FROM alerts WHERE message_id GLOB ? AND place_id=? AND observed_at<=?').run(`${source}:*`, place.id, observedAt);
      }
      else if (parsed.regions.length) for (const code of parsed.regions) db.prepare('DELETE FROM alerts WHERE message_id GLOB ? AND region_code=? AND observed_at<=?').run(`${source}:*`, code, observedAt);
      else db.prepare('DELETE FROM alerts WHERE message_id GLOB ? AND observed_at<=?').run(`${source}:*`, observedAt);
    } else if (parsed.kind === 'danger' && nextMoscowReset(observedAt) > Date.now()) {
      for (const place of parsed.places) {
        const cleared = db.prepare('SELECT max(cleared_at) AS time FROM alert_clearances WHERE place_id IN (?,?,?)').get(`${source}:*`, `${source}:${place.id}`, `${source}:region:${place.region}`).time;
        if (cleared === null || observedAt > cleared) {
          db.prepare('INSERT INTO alerts (message_id,place_id,place_name,latitude,longitude,radius,observed_at,expires_at,region_code,area_type) VALUES (?,?,?,?,?,?,?,?,?,?)').run(`${source}:${messageId}:${place.id}`, place.id, place.name, place.latitude, place.longitude, place.radius, observedAt, nextMoscowReset(observedAt), place.region, place.areaType);
          db.prepare('DELETE FROM recent_clearances WHERE source=? AND place_id=? AND cleared_at<?').run(source, place.id, observedAt);
          if (place.areaType !== 'settlement') scheduleBoundary(place);
        }
      }
    }
    scheduleClearanceExpiry();
    broadcast();
  }
  app.get('/api/events', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    clients.set(res, { token: req.user.token, userId: req.user.id });
    broadcast();
    req.on('close', () => { if (clients.delete(res)) broadcast(); });
  });
  app.post('/api/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token=?').run(req.user.token);
    for (const [client, session] of clients) if (session.token === req.user.token) { client.end(); clients.delete(client); }
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
    for (const [key, entry] of attempts) if (entry.until < Date.now()) attempts.delete(key);
    for (const [res, session] of clients) {
      if (!db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires_at>?').get(session.token, Date.now())) { res.end(); clients.delete(res); changed = true; }
      else res.write(': heartbeat\n\n');
    }
    if (changed) broadcast();
  }, 10_000);
  timer.unref();
  let resetTimer;
  function scheduleReset() {
    resetTimer = setTimeout(() => {
      db.prepare('DELETE FROM alerts WHERE expires_at<=?').run(Date.now());
      broadcast();
      scheduleReset();
    }, nextMoscowReset(Date.now()) - Date.now());
    resetTimer.unref();
  }
  scheduleReset();
  return { app, applyPost, setFeedStatus, close() { closed = true; clearInterval(timer); clearTimeout(resetTimer); clearTimeout(clearanceTimer); for (const [res] of clients) res.end(); db.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const { app, applyPost, setFeedStatus } = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Gema Map listening on port ${port}`));
  import('./lib/telegram-watcher.js').then(({ startTelegramWatcher }) => startTelegramWatcher(applyPost, setFeedStatus)).catch(error => { setFeedStatus('error'); console.error(`Telegram: ${error.message}`); });
}
