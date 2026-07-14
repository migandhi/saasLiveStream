import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const db = new Database(process.env.DB_PATH || '/app/data/database.db');
const now = () => Math.floor(Date.now() / 1000);
const rnd = (n) => crypto.randomBytes(n).toString('hex');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL, parent_id INTEGER DEFAULT 0,
  username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  status TEXT DEFAULT 'pending', expires_at INTEGER DEFAULT 0,
  contact TEXT DEFAULT '', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER, title TEXT, starts_at INTEGER, minutes INTEGER
);
CREATE TABLE IF NOT EXISTS tickets(
  token TEXT PRIMARY KEY, room TEXT, kind TEXT, user_id INTEGER,
  expires_at INTEGER, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

// ---------- Passwords ----------
const hash = (p) => { const s = rnd(8); return s + ':' + crypto.scryptSync(p, s, 32).toString('hex'); };
const check = (p, h) => {
  try { const [s, k] = h.split(':');
    return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 32));
  } catch { return false; }
};

// ---------- Seed admin ----------
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  db.prepare("INSERT INTO users(role,username,pass,status,created_at) VALUES('admin',?,?,'active',?)")
    .run((process.env.ADMIN_USER || 'admin').toLowerCase(), hash(process.env.ADMIN_PASS || 'admin123'), now());
  console.log('Seeded admin account.');
}

// ---------- Admin-controlled settings (persisted) ----------
const settings = {
  maxConcurrentStreams: 1,        // hard cap on simultaneous streams
  extraStreamViewerThreshold: 20, // 2nd+ stream allowed only if total viewers < this
  maxViewersPerRoom: 50,
  maxTotalViewers: 60,            // global viewer budget (bandwidth protection)
  requireSchedule: 1,             // 1 = can only go live inside a booked slot
  maxBookingsPerSub: 3,           // fairness: max upcoming bookings per subscriber
  maxSlotMinutes: 120
};
for (const r of db.prepare('SELECT * FROM settings').all())
  if (r.key in settings) settings[r.key] = parseInt(r.value);
const saveSetting = (k, v) =>
  db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?').run(k, String(v), String(v));

// ---------- Helpers ----------
const expired = (u) => u.expires_at > 0 && u.expires_at < now();
const subActive = (u) => u && u.status === 'active' && !expired(u);
const roomOf = (subId) => 'sub' + subId;

const getUser = (req) => {
  const sid = (req.headers.cookie || '').split(';').map(c => c.trim())
    .find(c => c.startsWith('sid='))?.slice(4);
  if (!sid) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.sid=?').get(sid) || null;
};
const auth = (role) => (req, res, next) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  if (role && u.role !== role) return res.status(403).json({ error: 'Forbidden' });
  req.user = u; next();
};

// ---------- MediaMTX radar ----------
let mtxState = {};
const isLive = (p) => p.ready === true || p.sourceReady === true;
const liveRoomPaths = () => Object.keys(mtxState).filter(k => mtxState[k].ready);
const totalViewers = () => Object.values(mtxState).reduce((a, p) => a + (p.viewers || 0), 0);

async function kickRoom(room) {
  const mtxPath = 'live/' + room;
  for (const kind of ['webrtcsessions', 'rtspsessions', 'rtmpconns', 'srtconns']) {
    try {
      const r = await fetch(`http://127.0.0.1:9997/v3/${kind}/list`);
      if (!r.ok) continue;
      for (const item of (await r.json()).items || [])
        if (item.path === mtxPath)
          await fetch(`http://127.0.0.1:9997/v3/${kind}/kick/${item.id}`, { method: 'POST' });
    } catch {}
  }
}

// Slot covering "now" for a subscriber (10 min early entry allowed)
const currentSlot = (subId) =>
  db.prepare('SELECT * FROM schedules WHERE subscriber_id=? AND starts_at-600<=? AND starts_at+minutes*60>?')
    .get(subId, now(), now());

/**
 * 🚦 STREAM ADMISSION — the concurrency gate (admin-controlled, flexible)
 */
function canStartStream(subId) {
  const room = 'live/' + roomOf(subId);
  const live = liveRoomPaths();
  if (live.includes(room))
    return { error: 'You are already live from another device or location. Stop that stream first.' };
  if (live.length >= settings.maxConcurrentStreams)
    return { error: 'All stream slots are busy right now. Please wait for the current broadcast to end.' };
  if (live.length > 0 && totalViewers() >= settings.extraStreamViewerThreshold)
    return { error: 'Server is under viewer load — a simultaneous stream is not allowed right now.' };
  if (settings.requireSchedule && !currentSlot(subId))
    return { error: 'You have no booked slot right now. Book a free slot in your dashboard first.' };
  return { ok: true };
}

setInterval(async () => {
  try {
    const r = await fetch('http://127.0.0.1:9997/v3/paths/list');
    if (r.ok) {
      const data = await r.json(); const s = {};
      (data.items || []).forEach(p => s[p.name] = { viewers: p.readers?.length || 0, ready: isLive(p) });
      mtxState = s;
    }
  } catch {}

  // ⏱ SLOT ENFORCEMENT: kick any live stream whose slot ended >5 min ago
  if (settings.requireSchedule) {
    for (const path of liveRoomPaths()) {
      const subId = parseInt(path.replace('live/sub', ''));
      if (!subId) continue;
      const slot = db.prepare('SELECT 1 FROM schedules WHERE subscriber_id=? AND starts_at-600<=? AND starts_at+minutes*60+300>?')
        .get(subId, now(), now());
      if (!slot) { console.log(`SLOT ENDED: kicking room sub${subId}`); await kickRoom('sub' + subId); }
    }
  }

  db.prepare('DELETE FROM tickets WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now() - 7 * 86400);
  db.prepare('DELETE FROM schedules WHERE starts_at < ?').run(now() - 86400);
}, 3000);

// =====================================================
// AUTH (single login per user)
// =====================================================
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?')
    .get(String(req.body.username || '').trim().toLowerCase());
  if (!u || !check(req.body.password || '', u.pass))
    return res.status(401).json({ error: 'Invalid username or password' });
  if (u.status === 'pending') return res.status(403).json({ error: 'Awaiting approval. Contact us on WhatsApp to activate.' });
  if (u.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact us to renew.' });
  if (u.role === 'subscriber' && expired(u)) return res.status(403).json({ error: 'Subscription expired. Contact us to renew.' });
  if (u.role === 'user') {
    const p = db.prepare('SELECT * FROM users WHERE id=?').get(u.parent_id);
    if (!subActive(p)) return res.status(403).json({ error: 'Your provider\'s subscription is inactive.' });
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  const sid = rnd(24);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sid, u.id, now());
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ role: u.role });
});

app.post('/api/logout', auth(), (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => {
  const { id, role, username, status, expires_at } = req.user;
  res.json({ id, role, username, status, expires_at });
});

app.post('/api/signup', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username: 3-30 chars (a-z 0-9 - _)' });
  if ((req.body.password || '').length < 6) return res.status(400).json({ error: 'Password: min 6 chars' });
  try {
    db.prepare("INSERT INTO users(role,username,pass,status,contact,created_at) VALUES('subscriber',?,?,'pending',?,?)")
      .run(username, hash(req.body.password), String(req.body.contact || '').slice(0, 100), now());
    res.json({ ok: true, message: 'Registered! Contact us on WhatsApp/phone to arrange payment and activation.' });
  } catch { res.status(400).json({ error: 'Username already taken' }); }
});

// =====================================================
// ADMIN
// =====================================================
app.get('/api/admin/subscribers', auth('admin'), (req, res) => {
  const subs = db.prepare("SELECT id,username,status,expires_at,contact,created_at FROM users WHERE role='subscriber' ORDER BY id DESC").all();
  res.json({
    settings,
    totals: { liveStreams: liveRoomPaths().length, totalViewers: totalViewers() },
    subscribers: subs.map(s => ({
      ...s, expired: expired(s),
      users: db.prepare('SELECT COUNT(*) c FROM users WHERE parent_id=?').get(s.id).c,
      live: !!mtxState['live/' + roomOf(s.id)]?.ready,
      viewers: mtxState['live/' + roomOf(s.id)]?.viewers || 0
    }))
  });
});

const getSub = (id) => db.prepare("SELECT * FROM users WHERE id=? AND role='subscriber'").get(id);

app.post('/api/admin/subscribers/:id/approve', auth('admin'), (req, res) => {
  const days = parseInt(req.body.days) || 30;
  db.prepare("UPDATE users SET status='active', expires_at=? WHERE id=? AND role='subscriber'")
    .run(now() + days * 86400, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/subscribers/:id/renew', auth('admin'), (req, res) => {
  const s = getSub(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' });
  const days = parseInt(req.body.days) || 30;
  const base = Math.max(now(), s.expires_at || 0);
  db.prepare("UPDATE users SET status='active', expires_at=? WHERE id=?").run(base + days * 86400, s.id);
  res.json({ ok: true });
});

app.post('/api/admin/subscribers/:id/suspend', auth('admin'), async (req, res) => {
  const s = getSub(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(s.id);
  db.prepare("DELETE FROM sessions WHERE user_id=? OR user_id IN (SELECT id FROM users WHERE parent_id=?)").run(s.id, s.id);
  db.prepare('DELETE FROM schedules WHERE subscriber_id=?').run(s.id);   // free their slots
  await kickRoom(roomOf(s.id));
  res.json({ ok: true });
});

app.post('/api/admin/subscribers/:id/delete', auth('admin'), async (req, res) => {
  const s = getSub(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare("DELETE FROM sessions WHERE user_id=? OR user_id IN (SELECT id FROM users WHERE parent_id=?)").run(s.id, s.id);
  db.prepare('DELETE FROM users WHERE parent_id=?').run(s.id);
  db.prepare('DELETE FROM users WHERE id=?').run(s.id);
  db.prepare('DELETE FROM schedules WHERE subscriber_id=?').run(s.id);
  await kickRoom(roomOf(s.id));
  res.json({ ok: true });
});

app.post('/api/admin/kick/:id', auth('admin'), async (req, res) => {
  await kickRoom(roomOf(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/settings', auth('admin'), (req, res) => {
  for (const k of Object.keys(settings)) {
    if (req.body[k] !== undefined) {
      settings[k] = parseInt(req.body[k]) || 0;
      saveSetting(k, settings[k]);
    }
  }
  res.json({ ok: true, settings });
});

// FUTURE PAYMENTS: a Stripe webhook simply calls the /renew logic. Nothing else changes.

// =====================================================
// SUBSCRIBER
// =====================================================
app.get('/api/sub/me', auth('subscriber'), (req, res) => {
  const room = roomOf(req.user.id);
  res.json({
    username: req.user.username, status: req.user.status, expires_at: req.user.expires_at,
    active: subActive(req.user),
    live: !!mtxState['live/' + room]?.ready, viewers: mtxState['live/' + room]?.viewers || 0,
    requireSchedule: !!settings.requireSchedule,
    bookingsUsed: db.prepare('SELECT COUNT(*) c FROM schedules WHERE subscriber_id=? AND starts_at>?').get(req.user.id, now()).c,
    bookingsMax: settings.maxBookingsPerSub, maxSlotMinutes: settings.maxSlotMinutes
  });
});

app.get('/api/sub/users', auth('subscriber'), (req, res) => {
  res.json(db.prepare('SELECT id,username,status,created_at FROM users WHERE parent_id=? ORDER BY username').all(req.user.id));
});

function addUser(subId, username, password) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.@-]{3,50}$/.test(username)) return { error: 'bad username: ' + username };
  if (String(password || '').length < 4) return { error: 'password too short for: ' + username };
  try {
    db.prepare("INSERT INTO users(role,parent_id,username,pass,status,created_at) VALUES('user',?,?,?,'active',?)")
      .run(subId, username, hash(String(password)), now());
    return { ok: true };
  } catch { return { error: 'username taken: ' + username }; }
}

app.post('/api/sub/users', auth('subscriber'), (req, res) => {
  const r = addUser(req.user.id, req.body.username, req.body.password);
  r.ok ? res.json(r) : res.status(400).json(r);
});

app.post('/api/sub/users/:id/delete', auth('subscriber'), (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
  db.prepare("DELETE FROM users WHERE id=? AND parent_id=? AND role='user'").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/sub/users/:id/toggle', auth('subscriber'), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND parent_id=? AND role='user'").get(req.params.id, req.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const st = u.status === 'active' ? 'suspended' : 'active';
  db.prepare('UPDATE users SET status=? WHERE id=?').run(st, u.id);
  if (st === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  res.json({ ok: true, status: st });
});

app.get('/api/sub/users.csv', auth('subscriber'), (req, res) => {
  const rows = db.prepare('SELECT username,status,created_at FROM users WHERE parent_id=?').all(req.user.id);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
  res.send('username,status,created\n' + rows.map(r =>
    `${r.username},${r.status},${new Date(r.created_at * 1000).toISOString().slice(0, 10)}`).join('\n'));
});

app.post('/api/sub/users/import', auth('subscriber'), (req, res) => {
  const lines = String(req.body.csv || '').split(/\r?\n/).filter(l => l.trim());
  let added = 0; const errors = [];
  for (const line of lines) {
    if (/^username\s*,/i.test(line)) continue;
    const [u, p] = line.split(',').map(x => (x || '').trim());
    const r = addUser(req.user.id, u, p);
    r.ok ? added++ : errors.push(r.error);
  }
  res.json({ added, errors });
});

// =====================================================
// SCHEDULER — slot booking with overlap prevention + fairness quota
// =====================================================
app.get('/api/sub/slots', auth('subscriber'), (req, res) => {
  // All upcoming bookings (other subscribers anonymized) so free slots are visible
  const rows = db.prepare('SELECT id,subscriber_id,title,starts_at,minutes FROM schedules WHERE starts_at+minutes*60 > ? ORDER BY starts_at LIMIT 200')
    .all(now());
  res.json(rows.map(r => ({
    id: r.subscriber_id === req.user.id ? r.id : null,
    starts_at: r.starts_at, minutes: r.minutes,
    mine: r.subscriber_id === req.user.id,
    title: r.subscriber_id === req.user.id ? r.title : 'Booked'
  })));
});

app.post('/api/sub/schedules', auth('subscriber'), (req, res) => {
  if (!subActive(req.user)) return res.status(403).json({ error: 'Subscription inactive' });
  const starts = parseInt(req.body.starts_at);
  const minutes = Math.min(Math.max(parseInt(req.body.minutes) || 60, 15), settings.maxSlotMinutes);
  if (!starts || !req.body.title) return res.status(400).json({ error: 'Title and start time required' });
  if (starts < now()) return res.status(400).json({ error: 'Slot is in the past' });

  // FAIRNESS: limit upcoming bookings per subscriber
  const mine = db.prepare('SELECT COUNT(*) c FROM schedules WHERE subscriber_id=? AND starts_at>?').get(req.user.id, now()).c;
  if (mine >= settings.maxBookingsPerSub)
    return res.status(400).json({ error: `Booking limit reached (${settings.maxBookingsPerSub} upcoming). Let others have a turn.` });

  const ends = starts + minutes * 60;
  // No self-overlap ever
  const ownClash = db.prepare('SELECT 1 FROM schedules WHERE subscriber_id=? AND starts_at<? AND starts_at+minutes*60>?')
    .get(req.user.id, ends, starts);
  if (ownClash) return res.status(400).json({ error: 'You already have a booking overlapping this time' });
  // OVERLAP RULE: slot is full when overlapping bookings >= maxConcurrentStreams
  const clashes = db.prepare('SELECT COUNT(*) c FROM schedules WHERE starts_at<? AND starts_at+minutes*60>?')
    .get(ends, starts).c;
  if (clashes >= settings.maxConcurrentStreams)
    return res.status(400).json({ error: 'This slot is already booked. Pick an empty slot.' });

  db.prepare('INSERT INTO schedules(subscriber_id,title,starts_at,minutes) VALUES(?,?,?,?)')
    .run(req.user.id, String(req.body.title).slice(0, 100), starts, minutes);
  res.json({ ok: true });
});

app.post('/api/sub/schedules/:id/delete', auth('subscriber'), (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id=? AND subscriber_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// =====================================================
// STREAM TICKETS (single-use, 20s TTL)
// =====================================================
app.post('/api/stream/pub-ticket', auth('subscriber'), (req, res) => {
  if (!subActive(req.user)) return res.status(403).json({ error: 'Subscription inactive' });
  const gate = canStartStream(req.user.id);              // 🚦 concurrency + slot + double-publish
  if (gate.error) return res.status(403).json(gate);
  const room = roomOf(req.user.id);
  const ttl = Math.min(parseInt(req.body.ttl) || 20, 300);
  const token = 'p_' + rnd(16);
  db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?,0)').run(token, room, 'pub', req.user.id, now() + ttl);
  res.json({ room, token });
});

app.post('/api/stream/view-ticket', auth(), (req, res) => {
  const u = req.user;
  const subId = u.role === 'user' ? u.parent_id : u.role === 'subscriber' ? u.id : 0;
  if (!subId) return res.status(403).json({ error: 'No stream for this account' });
  const sub = db.prepare('SELECT * FROM users WHERE id=?').get(subId);
  if (!subActive(sub) || u.status !== 'active') return res.status(403).json({ error: 'Broadcast unavailable' });
  const room = roomOf(subId);
  const live = !!mtxState['live/' + room]?.ready;
  const next = db.prepare('SELECT title,starts_at,minutes FROM schedules WHERE subscriber_id=? AND starts_at+minutes*60 > ? ORDER BY starts_at LIMIT 1')
    .get(subId, now());
  if (!live) return res.json({ live: false, next, provider: sub.username });
  // Per-room AND global viewer caps
  if ((mtxState['live/' + room]?.viewers || 0) >= settings.maxViewersPerRoom)
    return res.status(403).json({ error: 'This broadcast is at capacity' });
  if (totalViewers() >= settings.maxTotalViewers)
    return res.status(403).json({ error: 'Server is at full capacity, please try again shortly' });
  const token = 'v_' + rnd(16);
  db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?,0)').run(token, room, 'view', u.id, now() + 20);
  res.json({ live: true, room, token, next, provider: sub.username });
});

// =====================================================
// MediaMTX AUTH WEBHOOK — final line of defense (re-checks everything)
// =====================================================
app.post('/api/mtx/auth', (req, res) => {
  const { action, path: streamPath, query, password } = req.body;
  const q = new URLSearchParams(query || '');
  let t = password || q.get('token') || q.get('jwt');
  if (t) t = t.replace('Bearer ', '');
  const room = String(streamPath || '').replace(/^live\//, '');
  const kind = action === 'publish' ? 'pub' : action === 'read' ? 'view' : null;
  if (!kind || !t) return res.sendStatus(401);

  const row = db.prepare('SELECT * FROM tickets WHERE token=? AND room=? AND kind=? AND used=0 AND expires_at>?')
    .get(t, room, kind, now());
  if (!row) return res.sendStatus(401);
  db.prepare('UPDATE tickets SET used=1 WHERE token=?').run(t);

  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if (!owner || owner.status !== 'active') return res.sendStatus(401);

  if (kind === 'pub') {
    // Re-check concurrency at the exact moment of connection (excluding own room)
    const others = liveRoomPaths().filter(p => p !== 'live/' + room);
    if (others.length >= settings.maxConcurrentStreams) return res.sendStatus(401);
    if (others.length > 0 && totalViewers() >= settings.extraStreamViewerThreshold) return res.sendStatus(401);
  }
  if (kind === 'view') {
    if ((mtxState['live/' + room]?.viewers || 0) >= settings.maxViewersPerRoom) return res.sendStatus(401);
    if (totalViewers() >= settings.maxTotalViewers) return res.sendStatus(401);
  }
  return res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log('SaaS backend running on 3000'));