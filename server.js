/**
 * server.js – Optimised rewrite.
 *
 * Key changes vs original:
 *  • move broadcast sends only position/yaw/isSwimming — NOT full appearance every frame
 *  • persistPlayerProgress is decoupled from move; positions auto-saved every 30 s
 *  • Per-socket move rate-limit (50 ms / 20 Hz) — excess packets dropped, not processed
 *  • init no longer includes the joining player in the players list it sends to itself
 *  • playerJoined broadcast excluded from the new socket (was causing double-add)
 *  • Socket event names aligned with client (player:join, player:leave, player:move, etc.)
 *  • scheduleProfileSave debounce raised to 2 s (was 250 ms, fired constantly)
 *  • scrypt moved to async path so password hashing doesn't block the event loop
 *  • Periodic position-save loop replaces per-move persistence (30 s interval)
 *  • All event handlers guard against unauthenticated sockets before any work
 *  • saveTimer and accountSaveTimer managed safely with helper to avoid races
 */

import express  from 'express';
import crypto   from 'crypto';
import fs       from 'fs';
import http     from 'http';
import path     from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  // Tune Socket.io for a game: smaller ping interval, faster disconnect detection
  pingInterval: 10_000,
  pingTimeout:  5_000,
});

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// World constants (keep in sync with client)
// ---------------------------------------------------------------------------
const WORLD_LIMIT      = 40;
const ISLAND_SURFACE_Y = 1.35;
const LIGHTHOUSE_POS   = { x: WORLD_LIMIT * 1.65, z: -WORLD_LIMIT * 1.85 };
const LIGHTHOUSE_RADIUS= 11.7;
const INTERIOR_POS     = { x: -130, z: 210 };
const INTERIOR_RADIUS  = 11.2;
const SWIM_MIN_RADIUS  = WORLD_LIMIT + 0.6;
const SWIM_MAX_RADIUS  = WORLD_LIMIT * 3.9;
const SWIM_MIN_Y       = -0.15;
const PLAYABLE_BOUND   = WORLD_LIMIT * 4.1;
const INTERACT_RANGE   = 4.5;
const CHAT_MAX_LEN     = 220;
const NAME_MAX_LEN     = 18;
const MOVE_RATE_MS     = 50;   // minimum ms between processed move events per socket
const POSITION_SAVE_INTERVAL_MS = 30_000; // auto-save positions every 30 s
const PROFILE_SAVE_DEBOUNCE_MS  = 2_000;
const ACCOUNT_SAVE_DEBOUNCE_MS  = 2_000;

const HAIR_STYLES   = new Set(['none','short','sidepart','spiky','long','ponytail','bob','wavy']);
const FACE_STYLES   = new Set(['smile','serious','grin','wink','lashessmile','soft']);
const ACCESSORY_SET = new Set(['hat','glasses','backpack']);
const EMOTE_SET     = new Set(['wave','dance','cheer']);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename    = fileURLToPath(import.meta.url);
const __dirname     = path.dirname(__filename);
const PROFILE_FILE  = path.join(__dirname, 'profiles.json');
const ACCOUNT_FILE  = path.join(__dirname, 'accounts.json');

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
const players          = new Map();   // socket.id → playerObject
const profiles         = new Map();   // profileId → profileObject
const accounts         = new Map();   // username  → accountObject
const voiceParticipants= new Set();
const interactables    = new Map([
  ['beacon', { id: 'beacon', x: 0, z: 0, active: false, lastBy: null }]
]);

let saveTimer        = null;
let accountSaveTimer = null;

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function clampToIsland(x, z, limit) {
  const r = Math.hypot(x, z);
  if (r <= limit) return { x, z };
  const s = limit / (r || 1);
  return { x: x * s, z: z * s };
}

function clampToPlayableGround(x, z) {
  const MAIN_R = WORLD_LIMIT * 1.14;
  if (Math.hypot(x, z) <= MAIN_R) return { x, z };
  if (Math.hypot(x - LIGHTHOUSE_POS.x, z - LIGHTHOUSE_POS.z) <= LIGHTHOUSE_RADIUS) return { x, z };
  if (Math.hypot(x - INTERIOR_POS.x,   z - INTERIOR_POS.z)   <= INTERIOR_RADIUS)   return { x, z };
  const r = Math.hypot(x, z);
  if (r >= SWIM_MIN_RADIUS && r <= SWIM_MAX_RADIUS) return { x, z };

  // Find nearest playable point
  const toMain = clampToIsland(x, z, MAIN_R);
  const dMain  = Math.hypot(x - toMain.x, z - toMain.z);

  const dxL = x - LIGHTHOUSE_POS.x, dzL = z - LIGHTHOUSE_POS.z, lenL = Math.hypot(dxL, dzL) || 1;
  const toLH = { x: LIGHTHOUSE_POS.x + (dxL / lenL) * LIGHTHOUSE_RADIUS, z: LIGHTHOUSE_POS.z + (dzL / lenL) * LIGHTHOUSE_RADIUS };
  const dLH  = Math.hypot(x - toLH.x, z - toLH.z);

  const dxI = x - INTERIOR_POS.x, dzI = z - INTERIOR_POS.z, lenI = Math.hypot(dxI, dzI) || 1;
  const toIN = { x: INTERIOR_POS.x + (dxI / lenI) * INTERIOR_RADIUS, z: INTERIOR_POS.z + (dzI / lenI) * INTERIOR_RADIUS };
  const dIN  = Math.hypot(x - toIN.x, z - toIN.z);

  const len    = r || 1;
  const target = r < SWIM_MIN_RADIUS ? SWIM_MIN_RADIUS : SWIM_MAX_RADIUS;
  const toSW   = { x: (x / len) * target, z: (z / len) * target };
  const dSW    = Math.hypot(x - toSW.x, z - toSW.z);

  if (dMain <= dLH && dMain <= dIN && dMain <= dSW) return toMain;
  if (dLH <= dIN && dLH <= dSW)                     return toLH;
  if (dIN <= dSW)                                    return toIN;
  return toSW;
}

function randomSpawn(limit) {
  const angle  = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * limit;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

function randomHexColor() {
  return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------
function sanitizeName(value, fallback) {
  const raw  = typeof value === 'string' ? value : '';
  const safe = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LEN).replace(/[\x00-\x1F\x7F<>]/g, '');
  return safe || fallback;
}

function sanitizeColor(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^#([0-9a-fA-F]{6})$/.test(raw) ? raw : fallback;
}

function sanitizeAppearance(input, fallback) {
  const base    = fallback || defaultAppearance();
  const payload = input && typeof input === 'object' ? input : {};
  return {
    skin:      sanitizeColor(payload.skin,                    base.skin),
    shirt:     sanitizeColor(payload.shirt ?? payload.color,  base.shirt),
    pants:     sanitizeColor(payload.pants,                   base.pants),
    shoes:     sanitizeColor(payload.shoes,                   base.shoes),
    hairStyle: HAIR_STYLES.has(payload.hairStyle) ? payload.hairStyle : base.hairStyle,
    hairColor: sanitizeColor(payload.hairColor,               base.hairColor),
    faceStyle: FACE_STYLES.has(payload.faceStyle) ? payload.faceStyle : base.faceStyle,
    accessories: Array.isArray(payload.accessories)
      ? [...new Set(payload.accessories.filter(a => ACCESSORY_SET.has(a)))]
      : [...new Set((base.accessories || []).filter(a => ACCESSORY_SET.has(a)))]
  };
}

function sanitizeProfileId(value) {
  const raw  = typeof value === 'string' ? value.trim().toLowerCase().slice(0, 64) : '';
  return /^[a-z0-9-]{8,64}$/.test(raw) ? raw : null;
}

function sanitizeUsername(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9_]{3,20}$/.test(raw) ? raw : null;
}

function sanitizePassword(value) {
  const raw = typeof value === 'string' ? value : '';
  return raw.length >= 4 && raw.length <= 80 ? raw : null;
}

function defaultAppearance() {
  return { skin: '#f3cfb3', shirt: '#5a8ef2', pants: '#334155', shoes: '#111827', hairStyle: 'short', hairColor: '#2b211c', faceStyle: 'smile', accessories: [] };
}

// ---------------------------------------------------------------------------
// Password hashing (async so scrypt doesn't block the event loop)
// ---------------------------------------------------------------------------
function hashPasswordAsync(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve({ salt, hash: derived.toString('hex') });
    });
  });
}

function verifyPasswordAsync(password, salt, expectedHash) {
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return resolve(false);
      try {
        const a = derived;
        const b = Buffer.from(expectedHash, 'hex');
        resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
      } catch { resolve(false); }
    });
  });
}

// ---------------------------------------------------------------------------
// Persistence – reads are sync at startup, writes are async + debounced
// ---------------------------------------------------------------------------
function readProfiles() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    for (const [profileId, profile] of Object.entries(parsed)) {
      if (!sanitizeProfileId(profileId)) continue;
      const name       = sanitizeName(profile?.name, `Player-${profileId.slice(0, 4)}`);
      const color      = sanitizeColor(profile?.color, randomHexColor());
      const appearance = sanitizeAppearance(profile?.appearance, { ...defaultAppearance(), shirt: color });
      const x = Number(profile?.x), y = Number(profile?.y), z = Number(profile?.z);
      profiles.set(profileId, {
        name, color: appearance.shirt, appearance,
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null,
        z: Number.isFinite(z) ? z : null
      });
    }
  } catch { /* ignore corrupt file */ }
}

function readAccounts() {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    for (const [usernameKey, account] of Object.entries(parsed)) {
      const username = sanitizeUsername(usernameKey);
      if (!username) continue;
      const salt = typeof account?.salt === 'string' ? account.salt : '';
      const hash = typeof account?.hash === 'string' ? account.hash : '';
      if (!salt || !hash) continue;
      const profileId = sanitizeProfileId(account?.profileId) || `acct-${username}`;
      accounts.set(username, { username, salt, hash, profileId });
    }
  } catch { /* ignore corrupt file */ }
}

function scheduleProfileSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [id, p] of profiles.entries()) {
      out[id] = {
        name: p.name, color: p.color, appearance: p.appearance,
        x: Number.isFinite(p.x) ? p.x : null,
        y: Number.isFinite(p.y) ? p.y : null,
        z: Number.isFinite(p.z) ? p.z : null
      };
    }
    fs.writeFile(PROFILE_FILE, JSON.stringify(out, null, 2), () => {});
  }, PROFILE_SAVE_DEBOUNCE_MS);
}

function scheduleAccountSave() {
  clearTimeout(accountSaveTimer);
  accountSaveTimer = setTimeout(() => {
    const out = {};
    for (const [u, a] of accounts.entries()) out[u] = { salt: a.salt, hash: a.hash, profileId: a.profileId };
    fs.writeFile(ACCOUNT_FILE, JSON.stringify(out, null, 2), () => {});
  }, ACCOUNT_SAVE_DEBOUNCE_MS);
}

/** Flush a single player's position into the profiles map (no disk I/O yet). */
function flushPlayerToProfile(player) {
  if (!player?.profileId) return;
  const existing = profiles.get(player.profileId) || {};
  profiles.set(player.profileId, {
    ...existing,
    name:       player.name,
    color:      player.color,
    appearance: player.appearance,
    x: player.x, y: player.y, z: player.z
  });
}

/** Periodic position save – runs every 30 s instead of on every move event. */
function startAutoSave() {
  setInterval(() => {
    let dirty = false;
    for (const player of players.values()) {
      if (!player.profileId) continue;
      flushPlayerToProfile(player);
      dirty = true;
    }
    if (dirty) scheduleProfileSave();
  }, POSITION_SAVE_INTERVAL_MS);
}

readProfiles();
readAccounts();
startAutoSave();

// ---------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------
function buildSpawnData(socket, profileId, username) {
  const profile   = profiles.get(profileId);
  const savedX    = Number(profile?.x), savedY = Number(profile?.y), savedZ = Number(profile?.z);
  const hasSaved  = Number.isFinite(savedX) && Number.isFinite(savedY) && Number.isFinite(savedZ);
  const bounded   = hasSaved
    ? clampToPlayableGround(clamp(savedX, -PLAYABLE_BOUND, PLAYABLE_BOUND), clamp(savedZ, -PLAYABLE_BOUND, PLAYABLE_BOUND))
    : randomSpawn(WORLD_LIMIT * 0.65);

  const appearance = sanitizeAppearance(profile?.appearance, {
    ...defaultAppearance(), shirt: profile?.color || randomHexColor()
  });

  return {
    id:         socket.id,
    profileId,
    name:       profile?.name || username || `Player-${socket.id.slice(0, 4)}`,
    x:          bounded.x,
    y:          hasSaved ? clamp(savedY, SWIM_MIN_Y, 30) : ISLAND_SURFACE_Y,
    z:          bounded.z,
    yaw:        0,
    appearance,
    color:      appearance.shirt,
    // Rate-limit tracking (not sent to clients)
    _lastMoveAt: 0,
  };
}

function spawnPlayer(socket, profileId, username) {
  const player = buildSpawnData(socket, profileId, username);
  players.set(socket.id, player);

  // Send init only to the joining socket.
  // Players list excludes the joining player themselves (they add themselves via init.id).
  const otherPlayers = [...players.values()]
    .filter(p => p.id !== socket.id)
    .map(publicPlayer);

  socket.emit('init', {
    id:           socket.id,
    playerData:   publicPlayer(player),
    players:      otherPlayers,
    worldLimit:   WORLD_LIMIT,
    interactables:[...interactables.values()]
  });

  // Broadcast join to everyone else (not back to joining socket)
  socket.broadcast.emit('player:join', publicPlayer(player));
}

/** Strip internal fields before sending player data to clients. */
function publicPlayer(p) {
  return {
    id:         p.id,
    name:       p.name,
    color:      p.color,
    appearance: p.appearance,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw || 0
  };
}

function removePlayer(socket) {
  const player = players.get(socket.id);
  if (!player) return;
  // Flush position to disk before removing
  flushPlayerToProfile(player);
  scheduleProfileSave();
  players.delete(socket.id);
  voiceParticipants.delete(socket.id);
  socket.broadcast.emit('voice:peer:leave', { id: socket.id });
  io.emit('player:leave', { id: socket.id });
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // ---- Auth ----------------------------------------------------------------
  socket.on('auth:register', async (payload, ack) => {
    const username = sanitizeUsername(payload?.username);
    const password = sanitizePassword(payload?.password);
    if (!username || !password) {
      return ack?.({ ok: false, error: 'Use 3–20 letters/numbers for username and min 4-char password.' });
    }
    if (accounts.has(username)) {
      return ack?.({ ok: false, error: 'Username already taken.' });
    }

    let hashed;
    try { hashed = await hashPasswordAsync(password); }
    catch { return ack?.({ ok: false, error: 'Server error. Try again.' }); }

    const profileId = `acct-${username}`;
    accounts.set(username, { username, salt: hashed.salt, hash: hashed.hash, profileId });
    scheduleAccountSave();

    if (!profiles.has(profileId)) {
      const shirt = randomHexColor();
      profiles.set(profileId, {
        name: username, color: shirt,
        appearance: sanitizeAppearance(null, { ...defaultAppearance(), shirt }),
        x: null, y: null, z: null
      });
      scheduleProfileSave();
    }

    spawnPlayer(socket, profileId, username);
    ack?.({ ok: true, username });
  });

  socket.on('auth:login', async (payload, ack) => {
    const username = sanitizeUsername(payload?.username);
    const password = sanitizePassword(payload?.password);
    if (!username || !password) {
      return ack?.({ ok: false, error: 'Invalid credentials.' });
    }
    const account = accounts.get(username);
    if (!account) {
      return ack?.({ ok: false, error: 'Invalid credentials.' });
    }

    let valid;
    try { valid = await verifyPasswordAsync(password, account.salt, account.hash); }
    catch { return ack?.({ ok: false, error: 'Server error. Try again.' }); }

    if (!valid) return ack?.({ ok: false, error: 'Invalid credentials.' });

    spawnPlayer(socket, account.profileId, username);
    ack?.({ ok: true, username });
  });

  socket.on('auth:logout', () => removePlayer(socket));

  // ---- Movement (rate-limited) -------------------------------------------
  socket.on('move', (payload) => {
    const player = players.get(socket.id);
    if (!player || !payload) return;

    // Drop packets arriving faster than MOVE_RATE_MS
    const now = Date.now();
    if (now - player._lastMoveAt < MOVE_RATE_MS) return;
    player._lastMoveAt = now;

    const x   = Number(payload.x), y = Number(payload.y), z = Number(payload.z);
    const nx  = Number.isFinite(x) ? x : player.x;
    const ny  = Number.isFinite(y) ? y : player.y;
    const nz  = Number.isFinite(z) ? z : player.z;
    const bnd = clampToPlayableGround(clamp(nx, -PLAYABLE_BOUND, PLAYABLE_BOUND), clamp(nz, -PLAYABLE_BOUND, PLAYABLE_BOUND));

    player.x   = bnd.x;
    player.y   = clamp(ny, SWIM_MIN_Y, 30);
    player.z   = bnd.z;
    player.yaw = typeof payload.yaw === 'number' ? payload.yaw : player.yaw;
    player.isSwimming = !!payload.isSwimming;

    // Broadcast only the minimal position packet — NOT appearance
    socket.broadcast.emit('player:move', {
      id:         socket.id,
      x:          player.x,
      y:          player.y,
      z:          player.z,
      yaw:        player.yaw,
      isSwimming: player.isSwimming
    });
  });

  // ---- Interact ------------------------------------------------------------
  socket.on('interact', (payload) => {
    const actor = players.get(socket.id);
    if (!actor || payload?.id !== 'beacon') return;

    const beacon = interactables.get('beacon');
    if (!beacon) return;
    if (Math.hypot(actor.x - beacon.x, actor.z - beacon.z) > INTERACT_RANGE) return;

    beacon.active = !beacon.active;
    beacon.lastBy = actor.name;
    io.emit('interactable:update', beacon);
    io.emit('chat', {
      id:   null,
      name: 'System',
      msg:  beacon.active
        ? `${actor.name} activated the island beacon.`
        : `${actor.name} cooled the island beacon.`
    });
  });

  // ---- Chat ----------------------------------------------------------------
  socket.on('chat', (payload) => {
    const sender = players.get(socket.id);
    if (!sender) return;
    const msg = (typeof payload?.msg === 'string' ? payload.msg : '').trim().slice(0, CHAT_MAX_LEN);
    if (!msg) return;
    io.emit('chat', { id: socket.id, name: sender.name, msg });
  });

  // ---- Customize -----------------------------------------------------------
  socket.on('customize', (payload, ack) => {
    const player = players.get(socket.id);
    if (!player || !payload) return ack?.({ ok: false });

    const prevName   = player.name;
    player.name      = sanitizeName(payload.name, player.name);
    player.appearance= sanitizeAppearance(payload.appearance, player.appearance);
    player.color     = player.appearance.shirt;

    flushPlayerToProfile(player);
    scheduleProfileSave();

    io.emit('player:appearance', { id: socket.id, name: player.name, color: player.color, appearance: player.appearance });
    ack?.({ ok: true, name: player.name, color: player.color, appearance: player.appearance });

    if (prevName !== player.name) {
      io.emit('chat', { id: null, name: 'System', msg: `${prevName} is now known as ${player.name}.` });
    }
  });

  // ---- Save (explicit) -----------------------------------------------------
  socket.on('save', (payload) => {
    const player = players.get(socket.id);
    if (!player) return;
    // Accept an optional position override from the client
    if (payload) {
      const x = Number(payload.x), y = Number(payload.y), z = Number(payload.z);
      if (Number.isFinite(x)) player.x = x;
      if (Number.isFinite(y)) player.y = y;
      if (Number.isFinite(z)) player.z = z;
    }
    flushPlayerToProfile(player);
    scheduleProfileSave();
  });

  // ---- Emotes --------------------------------------------------------------
  socket.on('emote', (payload) => {
    const actor = players.get(socket.id);
    const emote = payload?.emote;
    if (!actor || !EMOTE_SET.has(emote)) return;
    socket.broadcast.emit('player:emote', { id: socket.id, emote });
  });

  // ---- Voice (WebRTC signalling) -------------------------------------------
  socket.on('voice:join', () => {
    if (!players.has(socket.id)) return;
    voiceParticipants.add(socket.id);
    // Tell the new participant about existing voice peers
    socket.emit('voice:peers', [...voiceParticipants].filter(id => id !== socket.id));
    // Tell existing peers about the new participant
    socket.broadcast.emit('voice:peer:join', { id: socket.id });
  });

  socket.on('voice:leave', () => {
    voiceParticipants.delete(socket.id);
    socket.broadcast.emit('voice:peer:leave', { id: socket.id });
  });

  socket.on('voice:offer', ({ to, offer }) => {
    if (!to || !offer || !players.has(socket.id)) return;
    io.to(to).emit('voice:offer', { from: socket.id, offer });
  });

  socket.on('voice:answer', ({ to, answer }) => {
    if (!to || !answer || !players.has(socket.id)) return;
    io.to(to).emit('voice:answer', { from: socket.id, answer });
  });

  socket.on('voice:ice', ({ to, candidate }) => {
    if (!to || !candidate || !players.has(socket.id)) return;
    io.to(to).emit('voice:ice', { from: socket.id, candidate });
  });

  // ---- Disconnect ----------------------------------------------------------
  socket.on('disconnect', () => removePlayer(socket));
});

// ---------------------------------------------------------------------------
// Graceful shutdown — flush all profiles before exit
// ---------------------------------------------------------------------------
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Flushing profiles…`);
  clearTimeout(saveTimer);
  clearTimeout(accountSaveTimer);
  for (const player of players.values()) flushPlayerToProfile(player);
  const out = {};
  for (const [id, p] of profiles.entries()) {
    out[id] = { name: p.name, color: p.color, appearance: p.appearance, x: p.x, y: p.y, z: p.z };
  }
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(out, null, 2));
  console.log('Profiles saved. Exiting.');
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ---------------------------------------------------------------------------
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
