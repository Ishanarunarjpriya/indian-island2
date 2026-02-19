import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const WORLD_LIMIT = 40;
const ISLAND_SURFACE_Y = 1.35;
const LIGHTHOUSE_POS = {
  x: WORLD_LIMIT * 1.65,
  z: -WORLD_LIMIT * 1.85
};
const LIGHTHOUSE_RADIUS = 11.7;
const INTERIOR_POS = { x: -130, z: 210 };
const INTERIOR_RADIUS = 11.2;
const SWIM_MIN_RADIUS = WORLD_LIMIT + 0.6;
const SWIM_MAX_RADIUS = WORLD_LIMIT * 3.9;
const SWIM_MIN_Y = -0.15;
const PLAYABLE_BOUND = WORLD_LIMIT * 4.1;
const INTERACT_RANGE = 4;
const CHAT_MAX_LEN = 220;
const NAME_MAX_LEN = 18;
const HAIR_STYLES = new Set(['none', 'short', 'sidepart', 'spiky', 'long', 'ponytail', 'bob', 'wavy']);
const FACE_STYLES = new Set(['smile', 'serious', 'grin', 'wink', 'lashessmile', 'soft']);
const ACCESSORY_TYPES = new Set(['hat', 'glasses', 'backpack']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_FILE = path.join(__dirname, 'profiles.json');
const ACCOUNT_FILE = path.join(__dirname, 'accounts.json');

const players = new Map();
const profiles = new Map();
const accounts = new Map();
const voiceParticipants = new Set();
const interactables = new Map([
  [
    'beacon',
    {
      id: 'beacon',
      x: 0,
      z: 0,
      active: false,
      lastBy: null
    }
  ]
]);
let saveTimer = null;
let accountSaveTimer = null;

app.use(express.static('public'));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampToIsland(x, z, limit) {
  const radius = Math.hypot(x, z);
  if (radius <= limit) {
    return { x, z };
  }

  const scale = limit / (radius || 1);
  return { x: x * scale, z: z * scale };
}

function clampToPlayableGround(x, z) {
  const MAIN_RADIUS = WORLD_LIMIT * 1.14;
  const onMain = Math.hypot(x, z) <= MAIN_RADIUS;
  const onLighthouse = Math.hypot(x - LIGHTHOUSE_POS.x, z - LIGHTHOUSE_POS.z) <= LIGHTHOUSE_RADIUS;
  const onInterior = Math.hypot(x - INTERIOR_POS.x, z - INTERIOR_POS.z) <= INTERIOR_RADIUS;
  const radius = Math.hypot(x, z);
  const onSwimRing = radius >= SWIM_MIN_RADIUS && radius <= SWIM_MAX_RADIUS;
  if (onMain || onLighthouse || onInterior || onSwimRing) {
    return { x, z };
  }

  const toMain = clampToIsland(x, z, MAIN_RADIUS);
  const distMain = Math.hypot(x - toMain.x, z - toMain.z);

  const dxL = x - LIGHTHOUSE_POS.x;
  const dzL = z - LIGHTHOUSE_POS.z;
  const lenL = Math.hypot(dxL, dzL) || 1;
  const toLighthouse = {
    x: LIGHTHOUSE_POS.x + (dxL / lenL) * LIGHTHOUSE_RADIUS,
    z: LIGHTHOUSE_POS.z + (dzL / lenL) * LIGHTHOUSE_RADIUS
  };
  const distLighthouse = Math.hypot(x - toLighthouse.x, z - toLighthouse.z);

  const dxI = x - INTERIOR_POS.x;
  const dzI = z - INTERIOR_POS.z;
  const lenI = Math.hypot(dxI, dzI) || 1;
  const toInterior = {
    x: INTERIOR_POS.x + (dxI / lenI) * INTERIOR_RADIUS,
    z: INTERIOR_POS.z + (dzI / lenI) * INTERIOR_RADIUS
  };
  const distInterior = Math.hypot(x - toInterior.x, z - toInterior.z);
  const toSwim = (() => {
    const len = Math.hypot(x, z) || 1;
    const target = len < SWIM_MIN_RADIUS ? SWIM_MIN_RADIUS : SWIM_MAX_RADIUS;
    const scale = target / len;
    return { x: x * scale, z: z * scale };
  })();
  const distSwim = Math.hypot(x - toSwim.x, z - toSwim.z);

  if (distMain <= distLighthouse && distMain <= distInterior && distMain <= distSwim) return toMain;
  if (distLighthouse <= distInterior && distLighthouse <= distSwim) return toLighthouse;
  if (distInterior <= distSwim) return toInterior;
  return toSwim;
}

function randomSpawn(limit) {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * limit;
  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius
  };
}

function randomHexColor() {
  const value = Math.floor(Math.random() * 0xffffff);
  return `#${value.toString(16).padStart(6, '0')}`;
}

function sanitizeName(value, fallback) {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LEN);
  const safe = normalized.replace(/[\x00-\x1F\x7F<>]/g, '');
  return safe || fallback;
}

function sanitizeColor(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const isHex = /^#([0-9a-fA-F]{6})$/.test(raw);
  return isHex ? raw : fallback;
}

function defaultAppearance() {
  return {
    skin: '#f3cfb3',
    shirt: '#5a8ef2',
    pants: '#334155',
    shoes: '#111827',
    hairStyle: 'short',
    hairColor: '#2b211c',
    faceStyle: 'smile',
    accessories: []
  };
}

function sanitizeAppearance(input, fallback) {
  const base = fallback || defaultAppearance();
  const payload = input && typeof input === 'object' ? input : {};

  return {
    skin: sanitizeColor(payload.skin, base.skin),
    shirt: sanitizeColor(payload.shirt ?? payload.color, base.shirt),
    pants: sanitizeColor(payload.pants, base.pants),
    shoes: sanitizeColor(payload.shoes, base.shoes),
    hairStyle: HAIR_STYLES.has(payload.hairStyle) ? payload.hairStyle : base.hairStyle,
    hairColor: sanitizeColor(payload.hairColor, base.hairColor),
    faceStyle: FACE_STYLES.has(payload.faceStyle) ? payload.faceStyle : base.faceStyle,
    accessories: Array.isArray(payload.accessories)
      ? [...new Set(payload.accessories.filter((item) => ACCESSORY_TYPES.has(item)))]
      : Array.isArray(base.accessories)
        ? [...new Set(base.accessories.filter((item) => ACCESSORY_TYPES.has(item)))]
        : []
  };
}

function sanitizeProfileId(value) {
  const raw = typeof value === 'string' ? value : '';
  const safe = raw.trim().toLowerCase().slice(0, 64);
  return /^[a-z0-9-]{8,64}$/.test(safe) ? safe : null;
}

function sanitizeUsername(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const lower = raw.toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(lower) ? lower : null;
}

function sanitizePassword(value) {
  const raw = typeof value === 'string' ? value : '';
  return raw.length >= 4 && raw.length <= 80 ? raw : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function readProfiles() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) {
      return;
    }
    const fileData = fs.readFileSync(PROFILE_FILE, 'utf8');
    const parsed = JSON.parse(fileData);
    for (const [profileId, profile] of Object.entries(parsed)) {
      if (!sanitizeProfileId(profileId)) continue;
      const name = sanitizeName(profile?.name, `Player-${profileId.slice(0, 4)}`);
      const color = sanitizeColor(profile?.color, randomHexColor());
      const appearance = sanitizeAppearance(profile?.appearance, {
        ...defaultAppearance(),
        shirt: color
      });
      const x = Number(profile?.x);
      const y = Number(profile?.y);
      const z = Number(profile?.z);
      profiles.set(profileId, {
        name,
        color: appearance.shirt,
        appearance,
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null,
        z: Number.isFinite(z) ? z : null
      });
    }
  } catch {
    // Ignore corrupt profile storage and continue with runtime defaults.
  }
}

function readAccounts() {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) {
      return;
    }
    const fileData = fs.readFileSync(ACCOUNT_FILE, 'utf8');
    const parsed = JSON.parse(fileData);
    for (const [usernameKey, account] of Object.entries(parsed)) {
      const username = sanitizeUsername(usernameKey);
      if (!username) continue;
      const salt = typeof account?.salt === 'string' ? account.salt : '';
      const hash = typeof account?.hash === 'string' ? account.hash : '';
      const profileId = sanitizeProfileId(account?.profileId) || `acct-${username}`;
      if (!salt || !hash) continue;
      accounts.set(username, { username, salt, hash, profileId });
    }
  } catch {
    // Ignore corrupt account storage and continue.
  }
}

function scheduleProfileSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    const serialized = {};
    for (const [profileId, profile] of profiles.entries()) {
      serialized[profileId] = {
        name: profile.name,
        color: profile.color,
        appearance: profile.appearance,
        x: Number.isFinite(profile.x) ? profile.x : null,
        y: Number.isFinite(profile.y) ? profile.y : null,
        z: Number.isFinite(profile.z) ? profile.z : null
      };
    }
    fs.writeFile(PROFILE_FILE, JSON.stringify(serialized, null, 2), () => {});
  }, 250);
}

function scheduleAccountSave() {
  if (accountSaveTimer) {
    clearTimeout(accountSaveTimer);
  }
  accountSaveTimer = setTimeout(() => {
    const serialized = {};
    for (const [username, account] of accounts.entries()) {
      serialized[username] = {
        salt: account.salt,
        hash: account.hash,
        profileId: account.profileId
      };
    }
    fs.writeFile(ACCOUNT_FILE, JSON.stringify(serialized, null, 2), () => {});
  }, 250);
}

readProfiles();
readAccounts();

function spawnPlayer(socket, profileId, username) {
  const profile = profiles.get(profileId);
  const spawnPoint = randomSpawn(WORLD_LIMIT * 0.65);
  const savedX = Number(profile?.x);
  const savedY = Number(profile?.y);
  const savedZ = Number(profile?.z);
  const hasSavedPosition = Number.isFinite(savedX) && Number.isFinite(savedY) && Number.isFinite(savedZ);
  const boundedSaved = hasSavedPosition
    ? clampToPlayableGround(
      clamp(savedX, -PLAYABLE_BOUND, PLAYABLE_BOUND),
      clamp(savedZ, -PLAYABLE_BOUND, PLAYABLE_BOUND)
    )
    : null;
  const spawn = {
    id: socket.id,
    profileId,
    name: profile?.name || username || `Player-${socket.id.slice(0, 4)}`,
    x: boundedSaved ? boundedSaved.x : spawnPoint.x,
    y: hasSavedPosition ? clamp(savedY, SWIM_MIN_Y, 30) : ISLAND_SURFACE_Y,
    z: boundedSaved ? boundedSaved.z : spawnPoint.z,
    appearance: sanitizeAppearance(profile?.appearance, {
      ...defaultAppearance(),
      shirt: profile?.color || randomHexColor()
    })
  };
  spawn.color = spawn.appearance.shirt;
  players.set(socket.id, spawn);
  socket.emit('init', {
    id: socket.id,
    players: [...players.values()],
    worldLimit: WORLD_LIMIT,
    interactables: [...interactables.values()]
  });
  socket.broadcast.emit('playerJoined', spawn);
}

function persistPlayerProgress(player) {
  if (!player?.profileId) return;
  profiles.set(player.profileId, {
    name: player.name,
    color: player.color,
    appearance: player.appearance,
    x: player.x,
    y: player.y,
    z: player.z
  });
  scheduleProfileSave();
}

function removeAuthenticatedPlayer(socket) {
  const existing = players.get(socket.id);
  if (!existing) return;
  persistPlayerProgress(existing);
  players.delete(socket.id);
  voiceParticipants.delete(socket.id);
  socket.broadcast.emit('voice:user-left', socket.id);
  io.emit('playerLeft', socket.id);
}

io.on('connection', (socket) => {
  socket.emit('auth:required');

  socket.on('auth:register', (payload, ack) => {
    const username = sanitizeUsername(payload?.username);
    const password = sanitizePassword(payload?.password);
    if (!username || !password) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Use 3-20 letters/numbers for username and min 4-char password.' });
      return;
    }
    if (accounts.has(username)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Username already exists.' });
      return;
    }
    const { salt, hash } = hashPassword(password);
    const profileId = `acct-${username}`;
    accounts.set(username, { username, salt, hash, profileId });
    scheduleAccountSave();
    if (!profiles.has(profileId)) {
      const shirt = randomHexColor();
      profiles.set(profileId, {
        name: username,
        color: shirt,
        appearance: sanitizeAppearance(null, { ...defaultAppearance(), shirt }),
        x: null,
        y: null,
        z: null
      });
      scheduleProfileSave();
    }
    spawnPlayer(socket, profileId, username);
    if (typeof ack === 'function') ack({ ok: true, username });
  });

  socket.on('auth:login', (payload, ack) => {
    const username = sanitizeUsername(payload?.username);
    const password = sanitizePassword(payload?.password);
    if (!username || !password) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Invalid username or password.' });
      return;
    }
    const account = accounts.get(username);
    if (!account || !verifyPassword(password, account.salt, account.hash)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Invalid username or password.' });
      return;
    }
    spawnPlayer(socket, account.profileId, username);
    if (typeof ack === 'function') ack({ ok: true, username });
  });

  socket.on('auth:logout', () => {
    removeAuthenticatedPlayer(socket);
  });

  socket.on('move', (payload) => {
    const current = players.get(socket.id);
    if (!current || !payload) return;

    const x = Number(payload.x);
    const y = Number(payload.y);
    const z = Number(payload.z);
    const nextX = Number.isFinite(x) ? x : current.x;
    const nextY = Number.isFinite(y) ? y : current.y;
    const nextZ = Number.isFinite(z) ? z : current.z;
    const boundedX = clamp(nextX, -PLAYABLE_BOUND, PLAYABLE_BOUND);
    const boundedZ = clamp(nextZ, -PLAYABLE_BOUND, PLAYABLE_BOUND);
    const next = clampToPlayableGround(boundedX, boundedZ);

    current.x = next.x;
    current.y = clamp(nextY, SWIM_MIN_Y, 30);
    current.z = next.z;
    players.set(socket.id, current);
    persistPlayerProgress(current);

    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      x: current.x,
      y: current.y,
      z: current.z,
      name: current.name,
      color: current.color,
      appearance: current.appearance
    });
  });

  socket.on('interact', (payload) => {
    const actor = players.get(socket.id);
    if (!actor || !payload || payload.id !== 'beacon') return;

    const beacon = interactables.get('beacon');
    if (!beacon) return;

    const distance = Math.hypot(actor.x - beacon.x, actor.z - beacon.z);
    if (distance > INTERACT_RANGE) return;

    beacon.active = !beacon.active;
    beacon.lastBy = actor.name;
    interactables.set(beacon.id, beacon);

    io.emit('interactableUpdated', beacon);
    io.emit('chat', {
      fromName: 'System',
      text: beacon.active ? `${actor.name} activated the island beacon.` : `${actor.name} cooled the island beacon.`,
      sentAt: Date.now()
    });
  });

  socket.on('chat', (payload) => {
    const sender = players.get(socket.id);
    if (!sender || !payload) return;

    const rawText = typeof payload.text === 'string' ? payload.text : '';
    const text = rawText.trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;

    io.emit('chat', {
      fromId: socket.id,
      fromName: sender.name,
      text,
      sentAt: Date.now()
    });
  });

  socket.on('customize', (payload, ack) => {
    const current = players.get(socket.id);
    if (!current || !payload) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }

    const previousName = current.name;
    current.name = sanitizeName(payload.name, current.name);
    current.appearance = sanitizeAppearance(payload.appearance, {
      ...current.appearance,
      shirt: sanitizeColor(payload.color, current.color)
    });
    current.color = current.appearance.shirt;
    players.set(socket.id, current);
    persistPlayerProgress(current);

    io.emit('playerCustomized', {
      id: current.id,
      name: current.name,
      color: current.color,
      appearance: current.appearance
    });

    if (typeof ack === 'function') {
      ack({
        ok: true,
        name: current.name,
        color: current.color,
        appearance: current.appearance
      });
    }

    if (previousName !== current.name) {
      io.emit('chat', {
        fromName: 'System',
        text: `${previousName} is now ${current.name}.`,
        sentAt: Date.now()
      });
    }
  });

  socket.on('emote', (payload) => {
    const actor = players.get(socket.id);
    const type = payload?.type;
    if (!actor || !['wave', 'dance', 'cheer'].includes(type)) return;

    io.emit('playerEmote', {
      id: socket.id,
      type,
      sentAt: Date.now()
    });
  });

  socket.on('voice:join', () => {
    if (!players.has(socket.id)) return;
    voiceParticipants.add(socket.id);
    socket.emit('voice:participants', [...voiceParticipants].filter((id) => id !== socket.id));
    socket.broadcast.emit('voice:user-joined', socket.id);
  });

  socket.on('voice:leave', () => {
    voiceParticipants.delete(socket.id);
    socket.broadcast.emit('voice:user-left', socket.id);
  });

  socket.on('voice:offer', ({ to, offer }) => {
    if (!to || !offer) return;
    io.to(to).emit('voice:offer', { from: socket.id, offer });
  });

  socket.on('voice:answer', ({ to, answer }) => {
    if (!to || !answer) return;
    io.to(to).emit('voice:answer', { from: socket.id, answer });
  });

  socket.on('voice:ice', ({ to, candidate }) => {
    if (!to || !candidate) return;
    io.to(to).emit('voice:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    removeAuthenticatedPlayer(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
