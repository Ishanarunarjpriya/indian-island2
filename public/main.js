/**
 * main.js – Performance-optimised rewrite of the island multiplayer client.
 *
 * Key changes vs original:
 *  • InstancedMesh for palms, bushes, grass tufts and flower patches
 *    (collapses ~200+ individual draw calls into ~10 instanced batches)
 *  • Merged BufferGeometry for lighthouse stair steps + bridges
 *    (collapses 252 meshes into 2 draw calls)
 *  • Shared, cached geometry + material constants (no per-tree allocation)
 *  • Spatial hash grid for world-collision lookups  (O(1) vs O(n))
 *  • Throttled minimap redraws (every 100 ms, not every frame)
 *  • Throttled name-tag DOM updates (every 50 ms)
 *  • Palm frond group is now correctly added to the scene (bug fix)
 *  • Geometry + material disposed on player removal (memory leak fix)
 *  • crypto.getRandomValues for guest credential entropy
 *  • Single shared dummy matrix / colour objects in hot loops
 */

import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GROUND_Y            = 1.36;
const GRAVITY             = 18;
const JUMP_VELOCITY       = 7.2;
const SPRINT_SPEED        = 9.5;
const WALK_SPEED          = 5.2;
const SLIDE_SPEED         = 11;
const SLIDE_DURATION      = 0.38;
const STAMINA_MAX         = 1;
const STAMINA_DRAIN       = 0.38;
const STAMINA_RECOVER     = 0.22;
const PLAYER_COLLISION_RADIUS = 0.46;
const CHAT_BUBBLE_MS      = 4500;
const BUBBLE_PIXEL_GAP    = 44;
const VOICE_RADIUS        = 22;
const SWIM_MIN_RADIUS     = 0; // set after worldLimit is known
const SWIM_MAX_RADIUS     = 0;
const SWIM_SURFACE_Y      = 0.38;
const SWIM_SINK_Y         = -0.15;

let worldLimit = 40;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const statusEl           = document.getElementById('status');
const playerCountEl      = document.getElementById('player-count');
const interactHintEl     = document.getElementById('interact-hint');
const timeLabelEl        = document.getElementById('time-label');
const weatherLabelEl     = document.getElementById('weather-label');
const compassEl          = document.getElementById('compass');
const minimapEl          = document.getElementById('mini-map');
const minimapCtx         = minimapEl.getContext('2d');
const chatLogEl          = document.getElementById('chat-log');
const chatFormEl         = document.getElementById('chat-form');
const chatInputEl        = document.getElementById('chat-input');
const customizeFormEl    = document.getElementById('customize-form');
const nameInputEl        = document.getElementById('name-input');
const skinInputEl        = document.getElementById('skin-input');
const hairStyleInputEl   = document.getElementById('hair-style-input');
const hairColorInputEl   = document.getElementById('hair-color-input');
const faceStyleInputEl   = document.getElementById('face-style-input');
const colorInputEl       = document.getElementById('color-input');
const pantsColorInputEl  = document.getElementById('pants-color-input');
const shoesColorInputEl  = document.getElementById('shoes-color-input');
const customizeStatusEl  = document.getElementById('customize-status');
const customizeOpenEl    = document.getElementById('customize-open');
const customizeCloseEl   = document.getElementById('customize-close');
const customizeModalEl   = document.getElementById('customize-modal');
const customizePreviewEl = document.getElementById('customize-preview');
const itemCards          = Array.from(document.querySelectorAll('.item-card'));
const outfitSaveButtons  = Array.from(document.querySelectorAll('[data-outfit-save]'));
const outfitLoadButtons  = Array.from(document.querySelectorAll('[data-outfit-load]'));
const staminaFillEl      = document.getElementById('stamina-fill');
const voiceToggleEl      = document.getElementById('voice-toggle');
const menuToggleEl       = document.getElementById('menu-toggle');
const menuOverlayEl      = document.getElementById('menu-overlay');
const saveQuitEl         = document.getElementById('save-quit');
const authModalEl        = document.getElementById('auth-modal');
const authUsernameEl     = document.getElementById('auth-username');
const authPasswordEl     = document.getElementById('auth-password');
const authLoginEl        = document.getElementById('auth-login');
const authRegisterEl     = document.getElementById('auth-register');
const authStatusEl       = document.getElementById('auth-status');
const emoteWheelEl       = document.getElementById('emote-wheel');
const wheelButtons       = Array.from(document.querySelectorAll('[data-wheel-emote]'));
const nameTagsEl         = document.getElementById('name-tags');
const emoteButtons       = Array.from(document.querySelectorAll('[data-emote]'));
const joystickEl         = document.getElementById('joystick');
const joystickStickEl    = document.getElementById('joystick-stick');
const mobileJumpEl       = document.getElementById('btn-jump');
const mobileUseEl        = document.getElementById('btn-use');
const mobileEmoteEl      = document.getElementById('btn-emote');

const gameplayPanels = ['hud','mini-panel','action-panel','chat-panel','world-state']
  .map(id => document.getElementById(id)).filter(Boolean);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const socket       = io();
const players      = new Map();
const interactables= new Map();
const keys         = new Set();

let localPlayerId     = null;
let customizeTimer    = null;
let lastInteractAt    = 0;
let lastEmoteAt       = 0;
let pendingJump       = false;
let emoteWheelOpen    = false;
let menuOpen          = false;
let isAuthenticated   = false;
let voiceEnabled      = false;
let localVoiceStream  = null;
const voicePeers      = new Map();
const voiceAudioEls   = new Map();

// Lighthouse / interior
let lighthouseInteriorGroup  = null;
let lighthouseInteriorPortal = null;
let lighthouseTopPortal      = null;
let inLighthouseInterior     = false;
let isTeleporting            = false;

// Camera
let cameraYaw           = 0;
let cameraPitch         = 0.38;
let cameraDistance      = 14;
let cameraDistanceTarget= 14;

// Throttle timestamps
let _lastMinimapDraw  = 0;
let _lastNameTagUpdate= 0;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const cachedAuthUsername = localStorage.getItem('island_auth_username') || '';
const cachedAuthPassword = localStorage.getItem('island_auth_password') || '';
if (authUsernameEl) authUsernameEl.value = cachedAuthUsername;
if (authPasswordEl) authPasswordEl.value = cachedAuthPassword;

/** Use crypto for better entropy */
function makeGuestCredentials() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  const suffix = Array.from(arr).map(b => b.toString(36)).join('').slice(0, 8);
  const arr2 = new Uint8Array(2);
  crypto.getRandomValues(arr2);
  const pin = (arr2[0] * 256 + arr2[1]) % 9000 + 1000;
  return { username: `guest_${suffix}`, password: `g_${suffix}${pin}` };
}

function persistAuth(username, password) {
  localStorage.setItem('island_auth_username', username);
  localStorage.setItem('island_auth_password', password);
  if (authUsernameEl) authUsernameEl.value = username;
  if (authPasswordEl) authPasswordEl.value = password;
}

function autoAuthToGameplay() {
  const u = (authUsernameEl?.value || '').trim().toLowerCase();
  const p = authPasswordEl?.value || '';
  const creds = u && p ? { username: u, password: p } : makeGuestCredentials();

  const tryGuestFallback = () => {
    const guest = makeGuestCredentials();
    if (authStatusEl) authStatusEl.textContent = 'Creating guest session…';
    socket.emit('auth:register', guest, r => {
      if (!r?.ok) { if (authStatusEl) authStatusEl.textContent = r?.error || 'Login failed. Click Login.'; return; }
      persistAuth(guest.username, guest.password);
      if (authStatusEl) authStatusEl.textContent = `Welcome, ${guest.username}.`;
    });
  };

  if (authStatusEl) authStatusEl.textContent = 'Signing in…';
  socket.emit('auth:login', creds, r => {
    if (r?.ok) { persistAuth(creds.username, creds.password); if (authStatusEl) authStatusEl.textContent = `Welcome, ${creds.username}.`; return; }
    socket.emit('auth:register', creds, r2 => {
      if (r2?.ok) { persistAuth(creds.username, creds.password); if (authStatusEl) authStatusEl.textContent = `Welcome, ${creds.username}.`; return; }
      tryGuestFallback();
    });
  });
}

// ---------------------------------------------------------------------------
// Cached profile
// ---------------------------------------------------------------------------
const cachedName       = localStorage.getItem('island_profile_name');
const cachedShirt      = localStorage.getItem('island_profile_color');
const cachedSkin       = localStorage.getItem('island_profile_skin');
const cachedHairStyle  = localStorage.getItem('island_profile_hair_style');
const cachedHairColor  = localStorage.getItem('island_profile_hair_color');
const cachedFaceStyle  = localStorage.getItem('island_profile_face_style');
const cachedPants      = localStorage.getItem('island_profile_pants_color');
const cachedShoes      = localStorage.getItem('island_profile_shoes_color');
const cachedAccessories= localStorage.getItem('island_profile_accessories');

const HEX6 = /^#[0-9a-fA-F]{6}$/;
if (cachedName)                                                       nameInputEl.value       = cachedName;
if (HEX6.test(cachedShirt  || ''))                                    colorInputEl.value      = cachedShirt;
if (HEX6.test(cachedSkin   || ''))                                    skinInputEl.value       = cachedSkin;
if (['none','short','sidepart','spiky','long','ponytail','bob','wavy'].includes(cachedHairStyle||''))
                                                                      hairStyleInputEl.value  = cachedHairStyle;
if (HEX6.test(cachedHairColor || ''))                                 hairColorInputEl.value  = cachedHairColor;
if (['smile','serious','grin','wink','lashessmile','soft'].includes(cachedFaceStyle||''))
                                                                      faceStyleInputEl.value  = cachedFaceStyle;
if (HEX6.test(cachedPants  || ''))                                    pantsColorInputEl.value = cachedPants;
if (HEX6.test(cachedShoes  || ''))                                    shoesColorInputEl.value = cachedShoes;

const selectedAccessories = new Set(
  (cachedAccessories||'').split(',').map(s=>s.trim()).filter(s=>['hat','glasses','backpack'].includes(s))
);

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setGameplayVisible(v) {
  gameplayPanels.forEach(p => { p.style.display = v ? '' : 'none'; });
  if (menuToggleEl) menuToggleEl.style.display = v ? '' : 'none';
}

function clearSessionWorld() {
  localPlayerId = null;
  players.forEach((_, id) => removePlayer(id));
  interactables.clear();
  boatState.onboard = false;
}

function setAuthModalOpen(open, statusText = '') {
  if (!authModalEl) return;
  authModalEl.classList.toggle('hidden', !open);
  if (authStatusEl) authStatusEl.textContent = statusText;
  isAuthenticated = !open;
  setGameplayVisible(!open);
  if (open) {
    keys.clear(); pendingJump = false; emoteWheelOpen = false;
    emoteWheelEl?.classList.add('hidden');
    setCustomizeModal(false);
    menuOpen = false; menuOverlayEl?.classList.add('hidden');
  }
}

function setMenuOpen(open) {
  if (!isAuthenticated) return;
  menuOpen = open;
  if (open) {
    keys.clear(); pendingJump = false; emoteWheelOpen = false;
    emoteWheelEl?.classList.add('hidden');
    setCustomizeModal(false);
  }
  menuOverlayEl?.classList.toggle('hidden', !open);
}

setAuthModalOpen(true, 'Login or create an account to continue.');

// ---------------------------------------------------------------------------
// Three.js renderer
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xb7d7e6, 45, 160);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, 11, 16);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.touchAction = 'none';

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Lights
const hemi = new THREE.HemisphereLight(0xd6f1ff, 0x4d3a27, 1.1);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.12);
sun.position.set(14, 32, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

// Water
const water = new THREE.Mesh(
  new THREE.CircleGeometry(170, 80),
  new THREE.MeshStandardMaterial({ color: 0x2c7ea1, roughness: 0.2, metalness: 0.05 })
);
water.rotation.x = -Math.PI / 2;
water.position.y = -0.35;
scene.add(water);

// ---------------------------------------------------------------------------
// Island shape helpers
// ---------------------------------------------------------------------------
function mainIslandRadiusAtAngle(angle) {
  return THREE.MathUtils.clamp(
    worldLimit * (0.86 + Math.sin(angle*2.2+0.6)*0.11 + Math.sin(angle*4.6-0.9)*0.06 + Math.cos(angle*1.2+2.1)*0.04),
    worldLimit * 0.66, worldLimit * 1.08
  );
}

function radialShape(radiusOffset = 0, segments = 144) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const r = Math.max(2.2, mainIslandRadiusAtAngle(t) + radiusOffset);
    i === 0 ? shape.moveTo(Math.cos(t)*r, Math.sin(t)*r) : shape.lineTo(Math.cos(t)*r, Math.sin(t)*r);
  }
  shape.closePath();
  return shape;
}

function addMainIslandTerrain() {
  const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.96, metalness: 0.01 });

  const cliff = new THREE.Mesh(new THREE.CylinderGeometry(worldLimit+4, worldLimit+7, 4.9, 72, 1), mat(0xc6b188));
  cliff.position.y = -2.5; cliff.receiveShadow = true; scene.add(cliff);

  [[2.6, 1.31, 0xbb9c6b],[0.85, 1.34, 0xcdb180],[-1.65, 1.36, 0x79a85d]].forEach(([off, y, col]) => {
    const g = new THREE.ShapeGeometry(radialShape(off), 132);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat(col));
    m.position.y = y; m.receiveShadow = true; scene.add(m);
  });
}
addMainIslandTerrain();

// ---------------------------------------------------------------------------
// Spatial hash for collision (O(1) lookups instead of O(n))
// ---------------------------------------------------------------------------
const CELL_SIZE = 8;
const collisionGrid = new Map();

function _cellKey(cx, cz) { return `${cx},${cz}`; }
function _cellsForRadius(x, z, radius) {
  const cells = [];
  const minCX = Math.floor((x - radius) / CELL_SIZE);
  const maxCX = Math.floor((x + radius) / CELL_SIZE);
  const minCZ = Math.floor((z - radius) / CELL_SIZE);
  const maxCZ = Math.floor((z + radius) / CELL_SIZE);
  for (let cx = minCX; cx <= maxCX; cx++)
    for (let cz = minCZ; cz <= maxCZ; cz++)
      cells.push(_cellKey(cx, cz));
  return cells;
}

const worldColliders = [];
function addWorldCollider(x, z, radius, tag = 'solid') {
  const c = { x, z, radius, tag };
  worldColliders.push(c);
  const minCX = Math.floor((x - radius) / CELL_SIZE);
  const maxCX = Math.floor((x + radius) / CELL_SIZE);
  const minCZ = Math.floor((z - radius) / CELL_SIZE);
  const maxCZ = Math.floor((z + radius) / CELL_SIZE);
  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      const key = _cellKey(cx, cz);
      if (!collisionGrid.has(key)) collisionGrid.set(key, []);
      collisionGrid.get(key).push(c);
    }
  }
}

function resolveWorldCollisions(x, z, y = GROUND_Y) {
  let nextX = x, nextZ = z;
  const nearDoor = Math.hypot(nextX - LIGHTHOUSE_DOOR_POS.x, nextZ - LIGHTHOUSE_DOOR_POS.z) < 2.35 && y <= GROUND_Y + 2.2;
  // Query only cells that overlap the player radius
  const checkedTags = new Set();
  const cells = _cellsForRadius(nextX, nextZ, PLAYER_COLLISION_RADIUS + 3);
  const seen = new Set();
  for (const key of cells) {
    const bucket = collisionGrid.get(key);
    if (!bucket) continue;
    for (const collider of bucket) {
      if (seen.has(collider)) continue;
      seen.add(collider);
      if (collider.tag === 'lighthouse-shell' && (inLighthouseInterior || nearDoor || y > GROUND_Y + 2.6)) continue;
      const dx = nextX - collider.x;
      const dz = nextZ - collider.z;
      const minDist = PLAYER_COLLISION_RADIUS + collider.radius;
      const dist = Math.hypot(dx, dz);
      if (dist >= minDist) continue;
      const scale = minDist / (dist || 1);
      nextX = collider.x + dx * scale;
      nextZ = collider.z + dz * scale;
    }
  }
  return { x: nextX, z: nextZ };
}

// ---------------------------------------------------------------------------
// InstancedMesh pools (major draw-call reduction)
// ---------------------------------------------------------------------------

// Shared dummy objects reused across all instancing
const _m4    = new THREE.Matrix4();
const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _color = new THREE.Color();

// --- Palms ---
const PALM_MAX = 32;
const palmTrunkGeo  = new THREE.CylinderGeometry(0.2, 0.38, 4.8, 10);
const palmFrondGeo  = new THREE.ConeGeometry(0.22, 2.25, 6);
const palmTrunkMat  = new THREE.MeshStandardMaterial({ color: 0x7b5135, roughness: 0.9 });
const palmFrondMat  = new THREE.MeshStandardMaterial({ color: 0x2f7f46, roughness: 0.82 });

const palmTrunkInst = new THREE.InstancedMesh(palmTrunkGeo, palmTrunkMat, PALM_MAX);
const palmFrondInst = new THREE.InstancedMesh(palmFrondGeo, palmFrondMat, PALM_MAX * 6);
palmTrunkInst.castShadow = true;
palmFrondInst.castShadow = true;
let palmCount = 0;
scene.add(palmTrunkInst, palmFrondInst);

function addPalm(x, z, scale = 1) {
  const i = palmCount++;
  // Trunk
  _pos.set(x + 0.15*scale, 2.5*scale, z - 0.12*scale);
  _euler.set(0, 0, 0.13); _quat.setFromEuler(_euler);
  _scale.setScalar(scale);
  _m4.compose(_pos, _quat, _scale);
  palmTrunkInst.setMatrixAt(i, _m4);

  // Fronds (6 per palm) — yaw first, then tilt outward so they fan correctly
  for (let f = 0; f < 6; f++) {
    const yawAngle  = (f / 6) * Math.PI * 2;
    const tiltAngle = 0.72; // radians outward from vertical
    // Offset tip position so the base of each cone sits at the trunk top
    const tipDist = 1.1 * scale;
    _pos.set(
      x + Math.sin(yawAngle) * tipDist,
      5.45 * scale - 0.2 * scale,
      z + Math.cos(yawAngle) * tipDist
    );
    // Tilt: rotate around the axis perpendicular to the yaw direction
    _euler.set(tiltAngle, yawAngle, 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _scale.setScalar(scale);
    _m4.compose(_pos, _quat, _scale);
    palmFrondInst.setMatrixAt(i*6 + f, _m4);
  }
  palmTrunkInst.instanceMatrix.needsUpdate = true;
  palmFrondInst.instanceMatrix.needsUpdate = true;
  addWorldCollider(x, z, 0.64*scale, 'tree');
}

// --- Bushes ---
const BUSH_MAX = 24;
const bushGeo  = new THREE.SphereGeometry(0.78, 10, 8);
const bushMat  = new THREE.MeshStandardMaterial({ color: 0x3d8e4d, roughness: 0.88 });
const bushInst = new THREE.InstancedMesh(bushGeo, bushMat, BUSH_MAX);
bushInst.castShadow = true; bushInst.receiveShadow = true;
let bushCount = 0;
scene.add(bushInst);

function addBush(x, z, scale = 1) {
  const i = bushCount++;
  _pos.set(x, 1.62 + 0.2*scale, z);
  _scale.setScalar(scale);
  _m4.compose(_pos, _quat.identity(), _scale);
  bushInst.setMatrixAt(i, _m4);
  bushInst.instanceMatrix.needsUpdate = true;
  addWorldCollider(x, z, 0.5*scale, 'bush');
}

// --- Grass tufts ---
const GRASS_MAX = 256;
const grassBladeGeo = new THREE.ConeGeometry(0.08, 0.55, 5);
const grassBladeMat1 = new THREE.MeshStandardMaterial({ color: 0x4f8a3f, roughness: 0.9 });
const grassBladeMat2 = new THREE.MeshStandardMaterial({ color: 0x568f45, roughness: 0.9 });
const grassInst1 = new THREE.InstancedMesh(grassBladeGeo, grassBladeMat1, GRASS_MAX * 4);
const grassInst2 = new THREE.InstancedMesh(grassBladeGeo, grassBladeMat2, GRASS_MAX * 4);
let grassCount1 = 0, grassCount2 = 0;
scene.add(grassInst1, grassInst2);

function addGrassTuft(x, z, scale = 1, colorVariant = 0) {
  const inst = colorVariant ? grassInst2 : grassInst1;
  const base = colorVariant ? grassCount2 : grassCount1;
  for (let b = 0; b < 4; b++) {
    _pos.set(
      x + (Math.random()-0.5)*0.18*scale,
      1.45 + 0.2*scale,
      z + (Math.random()-0.5)*0.18*scale
    );
    _euler.set((Math.random()-0.5)*0.24, 0, (Math.random()-0.5)*0.24);
    _quat.setFromEuler(_euler);
    _scale.setScalar(scale);
    _m4.compose(_pos, _quat, _scale);
    inst.setMatrixAt(base + b, _m4);
  }
  if (colorVariant) { grassCount2 += 4; grassInst2.instanceMatrix.needsUpdate = true; }
  else              { grassCount1 += 4; grassInst1.instanceMatrix.needsUpdate = true; }
}

// --- Flowers ---
const FLOWER_MAX = 200;
const flowerStemGeo   = new THREE.CylinderGeometry(0.016, 0.016, 0.36, 6);
const flowerBloomGeo  = new THREE.SphereGeometry(0.08, 8, 6);
const flowerStemMat   = new THREE.MeshStandardMaterial({ color: 0x3c8a3a, roughness: 0.92 });
const flowerColors    = [0xfef08a, 0xfda4af, 0xbfdbfe, 0xf5d0fe];
const flowerBloomMats = flowerColors.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 }));
const flowerStemInst  = new THREE.InstancedMesh(flowerStemGeo,  flowerStemMat,     FLOWER_MAX);
const flowerBloomInst0 = new THREE.InstancedMesh(flowerBloomGeo, flowerBloomMats[0], FLOWER_MAX);
const flowerBloomInst1 = new THREE.InstancedMesh(flowerBloomGeo, flowerBloomMats[1], FLOWER_MAX);
const flowerBloomInst2 = new THREE.InstancedMesh(flowerBloomGeo, flowerBloomMats[2], FLOWER_MAX);
const flowerBloomInst3 = new THREE.InstancedMesh(flowerBloomGeo, flowerBloomMats[3], FLOWER_MAX);
const bloomInsts = [flowerBloomInst0, flowerBloomInst1, flowerBloomInst2, flowerBloomInst3];
let flowerCount = 0;
scene.add(flowerStemInst, ...bloomInsts);

function addFlowerPatch(x, z, count = 10, spread = 2.2) {
  for (let i = 0; i < count; i++) {
    const px = x + (Math.random()-0.5)*spread;
    const pz = z + (Math.random()-0.5)*spread;
    const fi = flowerCount++;
    // stem
    _pos.set(px, 1.53, pz); _quat.identity(); _scale.setScalar(1);
    _m4.compose(_pos, _quat, _scale);
    flowerStemInst.setMatrixAt(fi, _m4);
    // bloom
    _pos.set(px, 1.76, pz);
    _m4.compose(_pos, _quat, _scale);
    bloomInsts[i % 4].setMatrixAt(fi, _m4);
  }
  flowerStemInst.instanceMatrix.needsUpdate = true;
  bloomInsts.forEach(b => { b.instanceMatrix.needsUpdate = true; });
}

// ---------------------------------------------------------------------------
// World positions
// ---------------------------------------------------------------------------
const LIGHTHOUSE_POS         = new THREE.Vector3(worldLimit*1.65, 0, -worldLimit*1.85);
const ISLAND_DOCK_POS        = new THREE.Vector3(worldLimit*0.92, 1.42, worldLimit*0.24);
const ISLAND_DOCK_YAW        = Math.atan2(-ISLAND_DOCK_POS.z, ISLAND_DOCK_POS.x);
const _toMain                = new THREE.Vector2(-LIGHTHOUSE_POS.x, -LIGHTHOUSE_POS.z).normalize();
const LIGHTHOUSE_DOCK_POS    = new THREE.Vector3(LIGHTHOUSE_POS.x + _toMain.x*10.6, 1.36, LIGHTHOUSE_POS.z + _toMain.y*10.6);
const LIGHTHOUSE_DOCK_YAW    = Math.atan2(-(LIGHTHOUSE_DOCK_POS.z - LIGHTHOUSE_POS.z), LIGHTHOUSE_DOCK_POS.x - LIGHTHOUSE_POS.x);
const LIGHTHOUSE_DOOR_POS    = new THREE.Vector3(LIGHTHOUSE_POS.x, 1.36, LIGHTHOUSE_POS.z + 2.8);
const LIGHTHOUSE_TOP_POS     = new THREE.Vector3(LIGHTHOUSE_POS.x, 14.2, LIGHTHOUSE_POS.z);
const LIGHTHOUSE_INTERIOR_BASE = new THREE.Vector3(-130, 0, 210);
const INTERIOR_PLAY_RADIUS   = 11.2;
const INTERIOR_ENTRY_POS     = new THREE.Vector3(LIGHTHOUSE_INTERIOR_BASE.x, 1.36, LIGHTHOUSE_INTERIOR_BASE.z + 8.6);
const INTERIOR_TOP_POS       = new THREE.Vector3(LIGHTHOUSE_INTERIOR_BASE.x, 20.8, LIGHTHOUSE_INTERIOR_BASE.z);
const INTERIOR_STAIR_RADIUS  = 7.25;
const INTERIOR_STAIR_START_Y = 1.5;
const INTERIOR_STAIR_RISE    = 0.155;
const INTERIOR_STAIR_ANGLE_STEP = 0.17;
const INTERIOR_STAIR_STEPS   = 126;
const INTERIOR_STAIR_END_ANGLE = (INTERIOR_STAIR_STEPS - 1) * INTERIOR_STAIR_ANGLE_STEP;
const INTERIOR_EXIT_PORTAL_POS = new THREE.Vector3(
  LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(INTERIOR_STAIR_END_ANGLE) * (INTERIOR_STAIR_RADIUS + 0.45),
  INTERIOR_TOP_POS.y + 0.14,
  LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(INTERIOR_STAIR_END_ANGLE) * (INTERIOR_STAIR_RADIUS + 0.45)
);
const SWIM_MIN_R = worldLimit + 0.6;
const SWIM_MAX_R = worldLimit * 3.9;

// ---------------------------------------------------------------------------
// Boat state
// ---------------------------------------------------------------------------
function dockOffsetPosition(dock, yaw, forward = 0, side = 0) {
  const fX = Math.sin(yaw), fZ = Math.cos(yaw);
  const rX = Math.cos(yaw), rZ = -Math.sin(yaw);
  return { x: dock.x + fX*forward + rX*side, z: dock.z + fZ*forward + rZ*side };
}

function isWaterAt(x, z) {
  const r = Math.hypot(x, z);
  if (r > SWIM_MAX_R) return false;
  const angle = Math.atan2(z, x);
  if (r <= Math.max(mainIslandRadiusAtAngle(angle) + 3.5, worldLimit + 18)) return false;
  if (Math.hypot(x - LIGHTHOUSE_POS.x, z - LIGHTHOUSE_POS.z) <= 13.8) return false;
  return true;
}

function findWaterSideSlot(dock, yaw, preferSide = 1, forward = 6.0, baseSide = 3.2) {
  for (const side of [preferSide, -preferSide]) {
    for (let s = baseSide; s <= baseSide + 8; s += 0.5) {
      const pos = dockOffsetPosition(dock, yaw, forward, s * side);
      if (isWaterAt(pos.x, pos.z)) return pos;
    }
  }
  return dockOffsetPosition(dock, yaw, forward, baseSide * preferSide);
}

const boatState = {
  mesh: null,
  ...findWaterSideSlot(ISLAND_DOCK_POS, ISLAND_DOCK_YAW, 1, 6.0, 3.2),
  y: 1.05, yaw: ISLAND_DOCK_YAW, speed: 0, onboard: false,
  paddleLeftPivot: null, paddleRightPivot: null, paddlePhase: 0
};

const BOAT_CLEARANCE_MAIN       = worldLimit + 3.4;
const BOAT_CLEARANCE_LIGHTHOUSE = 12.6;
addWorldCollider(LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.z, 2.32, 'lighthouse-shell');

function dockSlots() {
  return [
    { dock: ISLAND_DOCK_POS,      yaw: ISLAND_DOCK_YAW },
    { dock: LIGHTHOUSE_DOCK_POS,  yaw: LIGHTHOUSE_DOCK_YAW }
  ];
}

function nearestDockSlot(point, maxDistance = Infinity) {
  let best = null;
  for (const slot of dockSlots()) {
    const d = distance2D(point, slot.dock);
    if (d <= maxDistance && (!best || d < best.distance)) best = { ...slot, distance: d };
  }
  return best;
}

function boatPoseForDock(slot) {
  if (slot.dock === ISLAND_DOCK_POS)
    return { ...findWaterSideSlot(slot.dock, slot.yaw, 1, 6.0, 3.2), yaw: slot.yaw };
  return { ...dockOffsetPosition(slot.dock, slot.yaw, 1.8, 0.8), yaw: slot.yaw };
}

// ---------------------------------------------------------------------------
// Dock builder
// ---------------------------------------------------------------------------
function addDock(anchor, yaw = 0, opts = {}) {
  const segments    = opts.segments    ?? 7;
  const plankLength = opts.plankLength ?? 2.2;
  const plankWidth  = opts.plankWidth  ?? 0.7;
  const spacing     = opts.spacing     ?? 1.05;
  const addRamp     = opts.addRamp !== false;
  const dock = new THREE.Group();
  dock.position.copy(anchor); dock.rotation.y = yaw;

  const lastCX = (segments-1)*spacing;
  const deckLen = lastCX + plankLength;
  const deckMid = lastCX * 0.5;
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 });
  const darkWood= new THREE.MeshStandardMaterial({ color: 0x5b412c, roughness: 0.95 });

  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckLen, 0.16, plankWidth), woodMat);
  deck.position.set(deckMid, 0.05, 0); deck.castShadow = true; deck.receiveShadow = true; dock.add(deck);

  if (addRamp) {
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, plankWidth+0.34), new THREE.MeshStandardMaterial({ color: 0x80552f, roughness: 0.9 }));
    ramp.position.set(-1.45, -0.01, 0); ramp.rotation.z = 0.07; ramp.receiveShadow = true; dock.add(ramp);
  }

  const seamGeo = new THREE.BoxGeometry(0.03, 0.165, plankWidth*0.98);
  for (let i = 0; i < segments; i++) {
    const seam = new THREE.Mesh(seamGeo, darkWood);
    seam.position.set(i*spacing - spacing*0.5, 0.06, 0); seam.castShadow = true; dock.add(seam);
  }

  const railOff = plankWidth*0.5 + 0.2;
  const railGeo = new THREE.BoxGeometry(deckLen+0.3, 0.1, 0.12);
  for (const z of [-railOff, railOff]) {
    const rail = new THREE.Mesh(railGeo, darkWood);
    rail.position.set(deckMid, 0.36, z); rail.castShadow = true; dock.add(rail);
  }

  const pillarGeo = new THREE.CylinderGeometry(0.14, 0.18, 1.0, 10);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4b3623, roughness: 0.95 });
  const pillarRows = Math.max(5, Math.floor(segments*0.6));
  for (let i = 0; i < pillarRows; i++) {
    const t = pillarRows === 1 ? 0 : i/(pillarRows-1);
    const px = -plankLength*0.5 + 0.25 + t*(deckLen-0.5);
    for (const z of [-railOff+0.08, railOff-0.08]) {
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(px, -0.4, z); p.castShadow = true; dock.add(p);
    }
  }
  scene.add(dock);
}

// ---------------------------------------------------------------------------
// Lighthouse island + exterior
// ---------------------------------------------------------------------------
function addLighthouseIsland() {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(12.5, 14.5, 3.0, 36), new THREE.MeshStandardMaterial({ color: 0x8b6a4c, roughness: 0.95 }));
  base.position.set(LIGHTHOUSE_POS.x, -0.4, LIGHTHOUSE_POS.z); base.receiveShadow = true; scene.add(base);

  const top = new THREE.Mesh(new THREE.CylinderGeometry(10.8, 12.3, 1.3, 40), new THREE.MeshStandardMaterial({ color: 0x7ea35f, roughness: 0.9 }));
  top.position.set(LIGHTHOUSE_POS.x, 1.35, LIGHTHOUSE_POS.z); top.receiveShadow = true; scene.add(top);

  const lh = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 2.0, 12.5, 24), new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.75 }));
  tower.position.y = 7.4; tower.castShadow = true;
  const band = new THREE.Mesh(new THREE.TorusGeometry(1.88, 0.12, 8, 24), new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.55 }));
  band.rotation.x = Math.PI/2; band.position.y = 8.1;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.95, 2.4, 24), new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.55 }));
  roof.position.y = 14.7; roof.castShadow = true;
  const balcony = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.55, 0.24, 24), new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.72 }));
  balcony.position.y = 13.1; balcony.receiveShadow = true;
  const rail = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.08, 8, 32), new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.72 }));
  rail.rotation.x = Math.PI/2; rail.position.y = 13.58;

  lighthouseTopPortal = new THREE.Group();
  const topDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.1, 24), new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x0284c7, emissiveIntensity: 1.15, roughness: 0.28, metalness: 0.32 }));
  const topRing = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.08, 12, 28), new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0ea5e9, emissiveIntensity: 0.85, roughness: 0.35 }));
  topRing.rotation.x = Math.PI/2; topRing.position.y = 0.06;
  lighthouseTopPortal.position.set(0, 13.23, 0);
  lighthouseTopPortal.add(topDisc, topRing);
  const topPtLight = new THREE.PointLight(0x67e8f9, 0.75, 8, 2);
  topPtLight.position.set(0, 13.55, 0);
  lighthouseTopPortal.add(topPtLight);

  lh.add(tower, band, balcony, rail, roof, lighthouseTopPortal);
  lh.position.set(LIGHTHOUSE_POS.x, 0, LIGHTHOUSE_POS.z);
  scene.add(lh);
}

// ---------------------------------------------------------------------------
// Lighthouse INTERIOR – merged geometry (252 meshes → 2 draw calls)
// ---------------------------------------------------------------------------
function addLighthouseInterior() {
  const interior  = new THREE.Group();
  const shellMat  = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.86, side: THREE.DoubleSide });
  const trimMat   = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.72 });
  const woodMat   = new THREE.MeshStandardMaterial({ color: 0x8d5a2b, roughness: 0.82 });
  const stoneMat  = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 });
  const brassMat  = new THREE.MeshStandardMaterial({ color: 0xf2c66a, roughness: 0.34, metalness: 0.55 });
  const bridgeMat = new THREE.MeshStandardMaterial({ color: 0x8a572a, roughness: 0.82 });

  const shellRadius = 11.8, shellHeight = 24.5, floorRadius = 11.2;
  const stairRadius = INTERIOR_STAIR_RADIUS;
  const stairSteps  = INTERIOR_STAIR_STEPS;
  const stairRise   = INTERIOR_STAIR_RISE;

  const wall = new THREE.Mesh(new THREE.CylinderGeometry(shellRadius, shellRadius+0.35, shellHeight, 56, 1, true), shellMat);
  wall.position.set(LIGHTHOUSE_INTERIOR_BASE.x, shellHeight*0.5-0.12, LIGHTHOUSE_INTERIOR_BASE.z);
  wall.receiveShadow = true; interior.add(wall);

  const floorBase = new THREE.Mesh(new THREE.CircleGeometry(floorRadius, 56), stoneMat);
  floorBase.rotation.x = -Math.PI/2; floorBase.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.34, LIGHTHOUSE_INTERIOR_BASE.z);
  floorBase.receiveShadow = true; interior.add(floorBase);

  const floorRing = new THREE.Mesh(new THREE.RingGeometry(3.1, floorRadius-0.3, 56), new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.85 }));
  floorRing.rotation.x = -Math.PI/2; floorRing.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.345, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(floorRing);

  const centerWell = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.4, shellHeight-2.2, 28), new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.82 }));
  centerWell.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.35+(shellHeight-2.2)*0.5, LIGHTHOUSE_INTERIOR_BASE.z);
  centerWell.castShadow = true; centerWell.receiveShadow = true; interior.add(centerWell);
  addWorldCollider(LIGHTHOUSE_INTERIOR_BASE.x, LIGHTHOUSE_INTERIOR_BASE.z, 2.55, 'interior-core');

  const lowerTrim = new THREE.Mesh(new THREE.TorusGeometry(floorRadius-0.05, 0.12, 8, 64), trimMat);
  lowerTrim.rotation.x = Math.PI/2; lowerTrim.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.72, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(lowerTrim);
  const upperTrim = lowerTrim.clone(); upperTrim.position.y = shellHeight-0.35; interior.add(upperTrim);

  // ---- MERGED STAIRS (126 steps + 125 bridges = 2 draw calls) ----
  const stepGeoProto   = new THREE.BoxGeometry(3.2, 0.14, 1.55);
  const bridgeGeoProto = new THREE.BoxGeometry(3.2, stairRise+0.08, 1); // width adjusted per step

  // Collect all step transforms to build merged geometry
  const stepMatrices   = [];
  const bridgeMatrices = [];
  const bridgeScales   = [];

  for (let i = 0; i < stairSteps; i++) {
    const angle  = i * INTERIOR_STAIR_ANGLE_STEP;
    const stepX  = LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(angle) * stairRadius;
    const stepY  = INTERIOR_STAIR_START_Y + i * stairRise;
    const stepZ  = LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(angle) * stairRadius;

    const sm = new THREE.Matrix4();
    sm.makeRotationY(-angle);
    sm.setPosition(stepX, stepY, stepZ);
    stepMatrices.push(sm);

    if (i < stairSteps - 1) {
      const na  = (i+1)*INTERIOR_STAIR_ANGLE_STEP;
      const nx  = LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(na)*stairRadius;
      const ny  = INTERIOR_STAIR_START_Y + (i+1)*stairRise;
      const nz  = LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(na)*stairRadius;
      const run = Math.hypot(nx-stepX, nz-stepZ);
      const bm  = new THREE.Matrix4();
      bm.makeRotationY(-((angle+na)*0.5));
      bm.setPosition((stepX+nx)*0.5, (stepY+ny)*0.5-0.01, (stepZ+nz)*0.5);
      bridgeMatrices.push(bm);
      bridgeScales.push(run + 0.62);
    }
  }

  // Instanced steps
  const stepInst = new THREE.InstancedMesh(stepGeoProto, woodMat, stairSteps);
  stepInst.castShadow = true; stepInst.receiveShadow = true;
  stepMatrices.forEach((m, i) => stepInst.setMatrixAt(i, m));
  stepInst.instanceMatrix.needsUpdate = true;
  interior.add(stepInst);

  // Instanced bridges (non-uniform Z scale, so use individual scale matrices)
  const bridgeGeo = new THREE.BoxGeometry(3.2, stairRise+0.08, 1);
  const bridgeInst = new THREE.InstancedMesh(bridgeGeo, bridgeMat, bridgeMatrices.length);
  bridgeInst.castShadow = true; bridgeInst.receiveShadow = true;
  bridgeMatrices.forEach((bm, i) => {
    const scaleM = new THREE.Matrix4().makeScale(1, 1, bridgeScales[i]);
    bridgeInst.setMatrixAt(i, bm.clone().multiply(scaleM));
  });
  bridgeInst.instanceMatrix.needsUpdate = true;
  interior.add(bridgeInst);

  // Railing posts (every 2nd step)
  const stairRailMat  = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.78 });
  const postGeo       = new THREE.CylinderGeometry(0.05, 0.05, 0.72, 8);
  const postCount     = Math.ceil(stairSteps / 2);
  const postInst      = new THREE.InstancedMesh(postGeo, stairRailMat, postCount);
  postInst.castShadow = true;
  let pi = 0;
  for (let i = 0; i < stairSteps; i += 2) {
    const angle = i * INTERIOR_STAIR_ANGLE_STEP;
    const stepY = INTERIOR_STAIR_START_Y + i * stairRise;
    _pos.set(
      LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(angle)*(stairRadius+1.52),
      stepY + 0.38,
      LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(angle)*(stairRadius+1.52)
    );
    _m4.compose(_pos, _quat.identity(), _scale.setScalar(1));
    postInst.setMatrixAt(pi++, _m4);
  }
  postInst.instanceMatrix.needsUpdate = true;
  interior.add(postInst);

  // Top balcony posts (24)
  const topPostGeo  = new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8);
  const topPostInst = new THREE.InstancedMesh(topPostGeo, trimMat, 24);
  topPostInst.castShadow = true;
  for (let i = 0; i < 24; i++) {
    const a = (i/24)*Math.PI*2;
    _pos.set(INTERIOR_TOP_POS.x + Math.cos(a)*3.45, INTERIOR_TOP_POS.y+0.18, INTERIOR_TOP_POS.z + Math.sin(a)*3.45);
    _m4.compose(_pos, _quat.identity(), _scale.setScalar(1));
    topPostInst.setMatrixAt(i, _m4);
  }
  topPostInst.instanceMatrix.needsUpdate = true;
  interior.add(topPostInst);

  const topRail = new THREE.Mesh(new THREE.TorusGeometry(3.45, 0.08, 10, 40), trimMat);
  topRail.rotation.x = Math.PI/2; topRail.position.set(INTERIOR_TOP_POS.x, INTERIOR_TOP_POS.y+0.72, INTERIOR_TOP_POS.z); interior.add(topRail);

  const topPlatform = new THREE.Mesh(new THREE.CircleGeometry(3.35, 36), new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.76 }));
  topPlatform.rotation.x = -Math.PI/2; topPlatform.position.set(INTERIOR_TOP_POS.x, INTERIOR_TOP_POS.y+0.1, INTERIOR_TOP_POS.z); interior.add(topPlatform);

  const upperDeck = new THREE.Mesh(new THREE.RingGeometry(5.0, floorRadius-0.25, 48), new THREE.MeshStandardMaterial({ color: 0x7c4f2d, roughness: 0.84 }));
  upperDeck.rotation.x = -Math.PI/2; upperDeck.position.set(LIGHTHOUSE_INTERIOR_BASE.x, INTERIOR_TOP_POS.y-0.42, LIGHTHOUSE_INTERIOR_BASE.z); upperDeck.receiveShadow = true; interior.add(upperDeck);

  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(shellRadius-0.2, 56), new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.8 }));
  ceiling.rotation.x = Math.PI/2; ceiling.position.set(LIGHTHOUSE_INTERIOR_BASE.x, shellHeight-0.22, LIGHTHOUSE_INTERIOR_BASE.z); interior.add(ceiling);

  const entryFrame = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.1, 10, 30), new THREE.MeshStandardMaterial({ color: 0x60a5fa, emissive: 0x1d4ed8, emissiveIntensity: 0.5 }));
  entryFrame.rotation.x = Math.PI/2; entryFrame.position.set(INTERIOR_ENTRY_POS.x, 1.45, INTERIOR_ENTRY_POS.z); interior.add(entryFrame);

  const mapTable = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.96, 0.72, 20), woodMat);
  mapTable.position.set(LIGHTHOUSE_INTERIOR_BASE.x-4.25, 1.72, LIGHTHOUSE_INTERIOR_BASE.z-3.4); mapTable.castShadow = true; mapTable.receiveShadow = true; interior.add(mapTable);
  const mapTop = new THREE.Mesh(new THREE.CircleGeometry(0.82, 20), new THREE.MeshStandardMaterial({ color: 0xf3ecd2, roughness: 0.96 }));
  mapTop.rotation.x = -Math.PI/2; mapTop.position.set(mapTable.position.x, 2.09, mapTable.position.z); interior.add(mapTop);

  const lantern = new THREE.PointLight(0xffe8ad, 1.65, 42, 2);
  lantern.position.set(LIGHTHOUSE_INTERIOR_BASE.x, shellHeight-2.1, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(lantern);

  // Interior exit portal
  lighthouseInteriorPortal = new THREE.Group();
  const portalDisc = new THREE.Mesh(new THREE.CylinderGeometry(1.12, 1.12, 0.16, 28), new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x0ea5e9, emissiveIntensity: 1.55, roughness: 0.24, metalness: 0.36 }));
  const portalRing = new THREE.Mesh(new THREE.TorusGeometry(1.38, 0.12, 12, 32), new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 1.2 }));
  portalRing.rotation.x = Math.PI/2; portalRing.position.y = 0.06;
  const portalCap = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), brassMat);
  portalCap.position.y = 0.36;
  const portalBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.44, 2.25, 18, 1, true), new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.42, side: THREE.DoubleSide }));
  portalBeam.position.y = 1.1;
  lighthouseInteriorPortal.add(portalDisc, portalRing, portalCap, portalBeam);
  lighthouseInteriorPortal.position.copy(INTERIOR_EXIT_PORTAL_POS);
  const portalGlow = new THREE.PointLight(0x7dd3fc, 1.25, 12, 2);
  portalGlow.position.y = 0.7;
  lighthouseInteriorPortal.add(portalGlow);
  interior.add(lighthouseInteriorPortal);

  interior.visible = false;
  lighthouseInteriorGroup = interior;
  scene.add(interior);
}

// ---------------------------------------------------------------------------
// Boat
// ---------------------------------------------------------------------------
function addBoat() {
  const boat = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.86 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.9 });
  const hullCore = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.72, 3.35, 14, 1), hullMat);
  hullCore.rotation.x = Math.PI/2; hullCore.position.y = 0.25; hullCore.scale.set(1, 0.55, 1); hullCore.castShadow = true;
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.64, 0.88, 14), hullMat);
  bow.rotation.x = Math.PI/2; bow.position.set(0, 0.24, 1.92); bow.castShadow = true;
  const stern = new THREE.Mesh(new THREE.ConeGeometry(0.6, 0.72, 14), hullMat);
  stern.rotation.x = -Math.PI/2; stern.position.set(0, 0.24, -1.88); stern.castShadow = true;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.1, 2.28), new THREE.MeshStandardMaterial({ color: 0xbf7a31, roughness: 0.78 }));
  deck.position.y = 0.56; deck.castShadow = true;
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.16, 0.54), trimMat);
  bench.position.set(0, 0.72, -0.2); bench.castShadow = true;
  const gunwaleL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 3.2), trimMat);
  gunwaleL.position.set(-0.67, 0.52, 0);
  const gunwaleR = gunwaleL.clone(); gunwaleR.position.x = 0.67;
  const sideFillFL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.26, 0.66), trimMat);
  sideFillFL.position.set(-0.56, 0.24, 1.34);
  const sideFillFR = sideFillFL.clone(); sideFillFR.position.x = 0.56;
  const sideFillBL = sideFillFL.clone(); sideFillBL.position.set(-0.56, 0.24, -1.34);
  const sideFillBR = sideFillBL.clone(); sideFillBR.position.x = 0.56;
  const centerFill = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.18, 2.78), new THREE.MeshStandardMaterial({ color: 0xa1622b, roughness: 0.82 }));
  centerFill.position.y = 0.43;
  boat.add(hullCore, bow, stern, centerFill, deck, bench, gunwaleL, gunwaleR, sideFillFL, sideFillFR, sideFillBL, sideFillBR);

  const paddleMat = new THREE.MeshStandardMaterial({ color: 0x6b3d1f, roughness: 0.84 });
  function createPaddle(side = 1) {
    const pivot = new THREE.Group();
    pivot.position.set(0.78*side, 0.66, -0.08);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.35, 8), paddleMat);
    shaft.rotation.z = Math.PI/2; shaft.position.x = 0.46*side; shaft.castShadow = true;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.24), paddleMat);
    blade.position.x = 1.04*side; blade.castShadow = true;
    pivot.add(shaft, blade);
    return pivot;
  }
  const paddleLeftPivot  = createPaddle(-1);
  const paddleRightPivot = createPaddle(1);
  boat.add(paddleLeftPivot, paddleRightPivot);
  boat.position.set(boatState.x, boatState.y, boatState.z);
  scene.add(boat);
  boatState.mesh = boat;
  boatState.paddleLeftPivot  = paddleLeftPivot;
  boatState.paddleRightPivot = paddleRightPivot;
}

function addDecorBoat(x, z, yaw = 0, scale = 1.9, y = 1.06) {
  const boat    = new THREE.Group();
  boat.position.set(x, y, z); boat.rotation.y = yaw;
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x744521, roughness: 0.87 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.9 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.3*scale, 0.82*scale, 7.4*scale), hullMat);
  hull.castShadow = true; hull.receiveShadow = true; boat.add(hull);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(1.15*scale, 2.1*scale, 14), hullMat);
  bow.rotation.x = Math.PI/2; bow.position.z = 4.15*scale; bow.castShadow = true; boat.add(bow);
  const stern = new THREE.Mesh(new THREE.BoxGeometry(2.1*scale, 0.58*scale, 1.5*scale), trimMat);
  stern.position.set(0, 0.12*scale, -3.7*scale); stern.castShadow = true; boat.add(stern);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09*scale, 0.11*scale, 2.9*scale, 8), trimMat);
  mast.position.y = 1.95*scale; mast.castShadow = true; boat.add(mast);
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.7*scale, 1.25*scale), new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.85, side: THREE.DoubleSide }));
  sail.position.set(0.86*scale, 2.0*scale, 0); sail.rotation.y = Math.PI/2; boat.add(sail);
  scene.add(boat);
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------
function addWoodHouse(x, z, yaw = 0) {
  const house = new THREE.Group();
  house.position.set(x, GROUND_Y, z); house.rotation.y = yaw;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x7b4f2d, roughness: 0.88 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x5b3a24, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4e3423, roughness: 0.9 });

  const floor = new THREE.Mesh(new THREE.BoxGeometry(7.1, 0.2, 6.2), wallMat); floor.position.y = 0.08; floor.receiveShadow = true; house.add(floor);
  const back  = new THREE.Mesh(new THREE.BoxGeometry(7.1, 2.7, 0.22), wallMat); back.position.set(0, 1.46, -3.0); house.add(back);
  const left  = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.7, 6.2), wallMat); left.position.set(-3.45, 1.46, 0); house.add(left);
  const right = left.clone(); right.position.x = 3.45; house.add(right);
  const front = new THREE.Mesh(new THREE.BoxGeometry(7.1, 2.7, 0.22), wallMat); front.position.set(0, 1.46, 3.0); house.add(front);
  const door  = new THREE.Mesh(new THREE.BoxGeometry(1.24, 2.1, 0.08), trimMat); door.position.set(0, 1.16, 2.9); door.castShadow = true; door.receiveShadow = true; house.add(door);
  const knob  = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.3, metalness: 0.4 })); knob.position.set(0.4, 1.13, 2.95); house.add(knob);
  [new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.12, 0.12), trimMat), new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.12), trimMat), new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.12), trimMat)].forEach((m, i) => {
    m.position.set(i===0?0:i===1?-0.67:0.67, i===0?2.22:1.15, 2.95); house.add(m);
  });
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.55, 1.95, 4), roofMat); roof.position.set(0, 3.2, 0); roof.castShadow = true; roof.receiveShadow = true; house.add(roof);
  house.children.forEach(m => { m.castShadow = true; m.receiveShadow = true; });
  scene.add(house);
  addWorldCollider(x, z, 3.1, 'house');
}

function addCliffAndWaterfall(x, z) {
  const cliff  = new THREE.Group(); cliff.position.set(x, 0, z);
  const rockMat= new THREE.MeshStandardMaterial({ color: 0x586069, roughness: 0.93 });
  for (let i = 0; i < 7; i++) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.8 + Math.random()*0.9, 0), rockMat);
    rock.position.set((Math.random()-0.5)*6.8, 1.7+Math.random()*1.3, (Math.random()-0.5)*3.2);
    rock.scale.set(1.6, 1+Math.random()*0.6, 1.3); rock.castShadow = true; rock.receiveShadow = true; cliff.add(rock);
  }
  const waterFall = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.8), new THREE.MeshStandardMaterial({ color: 0x8ed7ff, emissive: 0x0b6aa8, emissiveIntensity: 0.28, transparent: true, opacity: 0.82, side: THREE.DoubleSide }));
  waterFall.position.set(0.2, 2.1, 0.95); waterFall.rotation.y = Math.PI*0.02; cliff.add(waterFall);
  const foam = new THREE.Mesh(new THREE.CircleGeometry(1.35, 18), new THREE.MeshStandardMaterial({ color: 0xe2f3ff, roughness: 0.7, transparent: true, opacity: 0.7 }));
  foam.rotation.x = -Math.PI/2; foam.position.set(0.2, -0.28, 1.05); cliff.add(foam);
  scene.add(cliff);
  addWorldCollider(x, z, 2.35, 'cliff');
}

// ---------------------------------------------------------------------------
// Nature population (uses InstancedMesh helpers above)
// ---------------------------------------------------------------------------
function populateMainIslandNature() {
  const palmSpots = [
    [worldLimit*0.62,  worldLimit*0.2,  1.06],
    [worldLimit*0.34, -worldLimit*0.42, 0.96],
    [-worldLimit*0.72, worldLimit*0.3,  1.1],
    [-worldLimit*0.16,-worldLimit*0.56, 0.92],
    [worldLimit*0.04,  worldLimit*0.61, 0.87]
  ];
  palmSpots.forEach(([x, z, s]) => addPalm(x, z, s));
  addBush(worldLimit*0.44,  worldLimit*0.28, 0.74);
  addBush(-worldLimit*0.26, worldLimit*0.44, 0.72);
  addBush(worldLimit*0.14, -worldLimit*0.36, 0.70);

  for (let i = 0; i < 48; i++) {
    const angle  = (i/48)*Math.PI*2;
    const radius = worldLimit*(0.18 + Math.random()*0.63);
    const x = Math.cos(angle)*radius + (Math.random()-0.5)*1.9;
    const z = Math.sin(angle)*radius + (Math.random()-0.5)*1.9;
    addGrassTuft(x, z, 0.8+Math.random()*0.45, i % 3 ? 1 : 0);
  }
  addFlowerPatch(worldLimit*0.22,  worldLimit*0.38, 14, 4.8);
  addFlowerPatch(-worldLimit*0.33, worldLimit*0.12, 12, 4.2);
}

function addLandmarks() {
  addDock(ISLAND_DOCK_POS,     ISLAND_DOCK_YAW,     { segments: 17, plankLength: 3.2, plankWidth: 3.2, spacing: 1.2 });
  addLighthouseIsland();
  addDock(LIGHTHOUSE_DOCK_POS, LIGHTHOUSE_DOCK_YAW, { segments: 12, plankLength: 2.8, plankWidth: 2.2, spacing: 1.1 });
  addLighthouseInterior();
  populateMainIslandNature();
  addWoodHouse(-worldLimit*0.33, worldLimit*0.12, 0);
  const cliffAngle = Math.atan2(-ISLAND_DOCK_POS.z, -ISLAND_DOCK_POS.x);
  addCliffAndWaterfall(Math.cos(cliffAngle)*worldLimit*0.7, Math.sin(cliffAngle)*worldLimit*0.7);
  const decorPos = findWaterSideSlot(ISLAND_DOCK_POS, ISLAND_DOCK_YAW, -1, 6.0, 3.2);
  addDecorBoat(decorPos.x, decorPos.z, ISLAND_DOCK_YAW - Math.PI*0.18, 0.58, 1.08);
  addBoat();
}
addLandmarks();

// ---------------------------------------------------------------------------
// Beacon
// ---------------------------------------------------------------------------
const beaconGroup    = new THREE.Group();
const beaconPedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 1.0, 18), new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.7 }));
beaconPedestal.position.y = 1.85; beaconPedestal.castShadow = true; beaconPedestal.receiveShadow = true;
const beaconCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0c4a6e, emissiveIntensity: 0.4, roughness: 0.15, metalness: 0.25 }));
beaconCore.position.y = 3.0; beaconCore.castShadow = true;
beaconGroup.add(beaconPedestal, beaconCore); scene.add(beaconGroup);

// ---------------------------------------------------------------------------
// Rain
// ---------------------------------------------------------------------------
const rainCount = 700;
const rainPositions = new Float32Array(rainCount * 3);
for (let i = 0; i < rainCount; i++) {
  rainPositions[i*3]   = (Math.random()-0.5)*180;
  rainPositions[i*3+1] = Math.random()*35 + 4;
  rainPositions[i*3+2] = (Math.random()-0.5)*180;
}
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
const rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({ color: 0xb9e6ff, size: 0.14, transparent: true, opacity: 0.65 }));
rain.visible = false;
scene.add(rain);

// ---------------------------------------------------------------------------
// Teleport overlay
// ---------------------------------------------------------------------------
const teleportOverlay = document.createElement('div');
Object.assign(teleportOverlay.style, {
  position:'fixed', inset:'0', pointerEvents:'none', opacity:'0',
  transition:'opacity 240ms ease', zIndex:'60', display:'flex',
  alignItems:'center', justifyContent:'center',
  background:'radial-gradient(circle at 50% 42%, rgba(56,189,248,0.28) 0%, rgba(2,8,20,0.94) 70%)'
});
document.body.appendChild(teleportOverlay);

const teleportCard = document.createElement('div');
Object.assign(teleportCard.style, {
  minWidth:'300px', maxWidth:'min(84vw, 460px)',
  border:'1px solid rgba(148,163,184,0.38)', borderRadius:'16px',
  background:'linear-gradient(140deg, rgba(15,23,42,0.95), rgba(30,41,59,0.92))',
  padding:'18px 20px 16px', boxShadow:'0 26px 60px rgba(2,6,23,0.5)',
  opacity:'0', transform:'translateY(14px) scale(0.96)',
  transition:'opacity 220ms ease, transform 220ms ease', backdropFilter:'blur(8px)'
});
teleportOverlay.appendChild(teleportCard);

const teleportTitle = document.createElement('div');
Object.assign(teleportTitle.style, { color:'#f8fafc', fontSize:'26px', fontWeight:'800', letterSpacing:'0.02em' });
teleportCard.appendChild(teleportTitle);

const teleportSubtitle = document.createElement('div');
Object.assign(teleportSubtitle.style, { color:'rgba(191,219,254,0.94)', fontSize:'14px', marginTop:'6px', letterSpacing:'0.02em' });
teleportCard.appendChild(teleportSubtitle);

const teleportSweep = document.createElement('div');
Object.assign(teleportSweep.style, {
  height:'3px', width:'100%', marginTop:'14px', borderRadius:'99px',
  background:'linear-gradient(90deg, transparent 0%, rgba(125,211,252,0.95) 45%, transparent 100%)',
  backgroundSize:'220% 100%', animation:'teleportSweep 720ms linear infinite'
});
teleportCard.appendChild(teleportSweep);
document.head.appendChild(Object.assign(document.createElement('style'), {
  textContent:'@keyframes teleportSweep{0%{background-position:130% 0}100%{background-position:-130% 0}}'
}));

function setTeleportTheme(type) {
  if (type === 'enter-lighthouse') {
    teleportOverlay.style.background = 'radial-gradient(circle at 50% 35%, rgba(125,211,252,0.34) 0%, rgba(2,8,20,0.95) 70%)';
    teleportTitle.textContent    = 'Entering Lighthouse';
    teleportSubtitle.textContent = 'Stepping through the doorway…';
    teleportSweep.style.filter   = 'hue-rotate(0deg)';
  } else if (type === 'exit-lighthouse') {
    teleportOverlay.style.background = 'radial-gradient(circle at 50% 35%, rgba(250,204,21,0.26) 0%, rgba(2,8,20,0.95) 74%)';
    teleportTitle.textContent    = 'Climbing To Lantern Deck';
    teleportSubtitle.textContent = 'Wind and ocean coming into view…';
    teleportSweep.style.filter   = 'hue-rotate(58deg)';
  } else {
    teleportOverlay.style.background = 'radial-gradient(circle at 50% 42%, rgba(56,189,248,0.28) 0%, rgba(2,8,20,0.94) 70%)';
    teleportTitle.textContent    = 'Teleporting';
    teleportSubtitle.textContent = 'Please wait…';
    teleportSweep.style.filter   = 'hue-rotate(0deg)';
  }
}

function runTeleportTransition(type, callback) {
  if (isTeleporting) return;
  isTeleporting = true;
  setTeleportTheme(type);
  renderer.domElement.style.cssText += ';transition:filter 240ms ease,transform 240ms ease;filter:blur(2px) saturate(1.15) brightness(1.08);transform:' + (type==='exit-lighthouse'?'scale(0.985)':'scale(1.02)');
  teleportOverlay.style.opacity = '1';
  teleportCard.style.opacity    = '1';
  teleportCard.style.transform  = 'translateY(0) scale(1)';
  setTimeout(() => {
    callback();
    teleportSubtitle.textContent = type==='exit-lighthouse' ? 'You made it to the top.' : 'Welcome inside.';
    teleportOverlay.style.opacity = '0';
    teleportCard.style.opacity    = '0';
    teleportCard.style.transform  = 'translateY(16px) scale(0.95)';
    renderer.domElement.style.filter    = 'none';
    renderer.domElement.style.transform = 'scale(1)';
    setTimeout(() => { isTeleporting = false; }, 240);
  }, 280);
}

// ---------------------------------------------------------------------------
// Appearance / player mesh helpers
// ---------------------------------------------------------------------------
function defaultAppearance() {
  return { skin:'#f3cfb3', shirt:'#5a8ef2', pants:'#334155', shoes:'#111827', hairStyle:'short', hairColor:'#2b211c', faceStyle:'smile', accessories:[] };
}

function normalizeAppearance(value, fallback = defaultAppearance()) {
  const src = value && typeof value === 'object' ? value : {};
  const hairStyles = ['none','short','sidepart','spiky','long','ponytail','bob','wavy'];
  const faceStyles = ['smile','serious','grin','wink','lashessmile','soft'];
  const accessList = ['hat','glasses','backpack'];
  const toColor = (v, base) => HEX6.test(v||'') ? v : base;
  return {
    skin:      toColor(src.skin, fallback.skin),
    shirt:     toColor(src.shirt ?? src.color, fallback.shirt),
    pants:     toColor(src.pants, fallback.pants),
    shoes:     toColor(src.shoes, fallback.shoes),
    hairStyle: hairStyles.includes(src.hairStyle) ? src.hairStyle : fallback.hairStyle,
    hairColor: toColor(src.hairColor, fallback.hairColor),
    faceStyle: faceStyles.includes(src.faceStyle) ? src.faceStyle : fallback.faceStyle,
    accessories: [...new Set((Array.isArray(src.accessories)?src.accessories:fallback.accessories||[]).filter(a=>accessList.includes(a)))]
  };
}

function hexToInt(hex) { return parseInt(hex.replace('#',''), 16); }

function buildPlayerMesh(appearance) {
  const app = normalizeAppearance(appearance);
  const group = new THREE.Group();

  const mat = (color) => new THREE.MeshStandardMaterial({ color: hexToInt(color), roughness: 0.82 });

  // Body parts
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.82, 0.38), mat(app.shirt));
  torso.position.y = 0.82; torso.castShadow = true; group.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.58, 0.54), mat(app.skin));
  head.position.y = 1.56; head.castShadow = true; group.add(head);
  group._head = head;

  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.68, 0.3), mat(app.pants));
  legL.position.set(-0.2, 0.36, 0); legL.castShadow = true; group.add(legL);
  const legR = legL.clone(); legR.position.x = 0.2; group.add(legR);
  group._legL = legL; group._legR = legR;

  const footL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.36), mat(app.shoes));
  footL.position.set(-0.2, 0.04, 0.04); group.add(footL);
  const footR = footL.clone(); footR.position.x = 0.2; group.add(footR);

  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.62, 0.24), mat(app.skin));
  armL.position.set(-0.5, 0.8, 0); armL.castShadow = true; group.add(armL);
  const armR = armL.clone(); armR.position.x = 0.5; group.add(armR);
  group._armL = armL; group._armR = armR;

  // Hair
  if (app.hairStyle !== 'none') {
    const hairMat = new THREE.MeshStandardMaterial({ color: hexToInt(app.hairColor), roughness: 0.88 });
    const hairMesh = buildHairMesh(app.hairStyle, hairMat);
    if (hairMesh) { hairMesh.position.y = 1.56; group.add(hairMesh); }
  }

  // Face marker (emissive spot for eyes)
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.5 });
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), eyeMat);
  eyeL.position.set(-0.12, 1.6, 0.27); group.add(eyeL);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.12; group.add(eyeR);

  // Accessories
  if (app.accessories.includes('hat')) {
    const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 }));
    hatBrim.position.y = 1.84; group.add(hatBrim);
    const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.32, 16), new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 }));
    hatTop.position.y = 2.0; group.add(hatTop);
  }
  if (app.accessories.includes('glasses')) {
    const glassMat  = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.3, metalness: 0.5 });
    const bridgeMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.6 });
    const lensL = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.016, 8, 16), glassMat);
    lensL.position.set(-0.115, 1.595, 0.285); group.add(lensL);
    const lensR = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.016, 8, 16), glassMat);
    lensR.position.set( 0.115, 1.595, 0.285); group.add(lensR);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.086, 0.014, 0.014), bridgeMat);
    bridge.position.set(0, 1.595, 0.285); group.add(bridge);
  }
  if (app.accessories.includes('backpack')) {
    const packMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.82 });
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.54, 0.2), packMat);
    pack.position.set(0, 0.88, -0.28); group.add(pack);
  }

  group.castShadow = true;
  return group;
}

function buildHairMesh(style, mat) {
  switch (style) {
    case 'short':    return new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.56), mat);
    case 'sidepart': { const g = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.56), mat); g.position.x = -0.04; return g; }
    case 'spiky':    return new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.42, 6), mat);
    case 'long': {
      const g = new THREE.Group();
      g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.56), mat)));
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.58, 0.12), mat); back.position.set(0, -0.22, -0.2); g.add(back);
      return g;
    }
    case 'ponytail': {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.56), mat));
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.42, 8), mat); tail.position.set(0, -0.28, -0.22); tail.rotation.x = 0.3; g.add(tail);
      return g;
    }
    case 'bob': { const g = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.26, 0.58), mat); return g; }
    case 'wavy': { const g = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), mat); g.scale.set(1, 0.55, 0.9); return g; }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Player management + disposal (fixes memory leak from original)
// ---------------------------------------------------------------------------
function createPlayerEntry(id, data) {
  const app  = normalizeAppearance(data.appearance);
  const mesh = buildPlayerMesh(app);
  mesh.position.set(data.x || 0, data.y || GROUND_Y, data.z || 0);
  scene.add(mesh);

  const label = document.createElement('div');
  label.className = 'player-tag';
  label.textContent = data.name || id;
  nameTagsEl.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.style.display = 'none';
  nameTagsEl.appendChild(bubble);

  return {
    id, mesh, label, bubble, bubbleUntil: 0,
    x: data.x || 0, y: data.y || GROUND_Y, z: data.z || 0,
    vy: 0, yaw: 0, name: data.name || id,
    appearance: app, isSwimming: false,
    stamina: 1, isSprinting: false, isSliding: false, slideTimer: 0,
    emote: null, emoteTimer: 0, emotePhase: 0,
    onboard: false
  };
}

function removePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  // Dispose all geometry and materials (prevents GPU memory leak)
  p.mesh.traverse(obj => {
    if (obj.isMesh) {
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material?.dispose();
    }
  });
  scene.remove(p.mesh);
  p.label?.remove();
  p.bubble?.remove();
  players.delete(id);
}

// ---------------------------------------------------------------------------
// Physics helpers
// ---------------------------------------------------------------------------
function distance2D(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

function clampToIsland(x, z, limit) {
  const r = Math.hypot(x, z);
  if (r <= limit) return { x, z };
  const s = limit / (r || 1);
  return { x: x*s, z: z*s };
}

function clampToRing(x, z, minR, maxR) {
  const r = Math.hypot(x, z) || 1;
  if (r >= minR && r <= maxR) return { x, z };
  const t = r < minR ? minR : maxR;
  return { x: x*(t/r), z: z*(t/r) };
}

function isSwimZone(x, z) {
  const r = Math.hypot(x, z);
  return r >= SWIM_MIN_R && r <= SWIM_MAX_R;
}

function groundHeightAt(x, z, currentY) {
  const stairY = sampleInteriorStairHeight(x, z, currentY);
  return Number.isFinite(stairY) ? stairY : GROUND_Y;
}

function shouldSwimAt(x, z, y) {
  return isWaterAt(x, z) && y <= GROUND_Y + 0.16 && !inLighthouseInterior;
}

function swimAnimationLevel(nowMs) {
  return SWIM_SURFACE_Y + Math.sin(nowMs * 0.0042) * 0.06;
}

function getSwimVerticalIntent() {
  const up   = keys.has(' ') || keys.has('w') || keys.has('arrowup');
  const down  = keys.has('c') || keys.has('s') || keys.has('arrowdown');
  if (up && !down) return 1;
  if (down && !up) return -1;
  return 0;
}

function applySwimVertical(local, delta, nowMs) {
  const intent  = getSwimVerticalIntent();
  const bobBase = swimAnimationLevel(nowMs);
  const target  = bobBase + intent * 0.45;
  const follow  = intent === 0 ? 3.6 : 5.4;
  local.y += (target - local.y) * Math.min(1, delta * follow);
  local.y  = THREE.MathUtils.clamp(local.y, SWIM_SINK_Y, SWIM_SURFACE_Y + 0.6);
  local.vy = 0;
}

function applyGroundVertical(local, delta, floorY) {
  if (pendingJump && local.y <= floorY + 0.05) local.vy = JUMP_VELOCITY;
  pendingJump = false;
  local.vy -= GRAVITY * delta;
  local.y  += local.vy * delta;
  if (local.y <= floorY) { local.y = floorY; local.vy = 0; }
}

function sampleInteriorStairHeight(x, z, currentY) {
  if (!inLighthouseInterior) return null;
  const dx = x - LIGHTHOUSE_INTERIOR_BASE.x;
  const dz = z - LIGHTHOUSE_INTERIOR_BASE.z;
  const radius = Math.hypot(dx, dz);
  if (radius <= 4.6 && currentY >= INTERIOR_TOP_POS.y - 3.0) return INTERIOR_TOP_POS.y + 0.1;
  if (radius >= 5.0 && radius <= INTERIOR_PLAY_RADIUS - 0.2 && currentY >= INTERIOR_TOP_POS.y - 2.2) return INTERIOR_TOP_POS.y - 0.42;
  if (radius < INTERIOR_STAIR_RADIUS - 1.15 || radius > INTERIOR_STAIR_RADIUS + 1.9) return null;

  let angle = Math.atan2(dz, dx);
  if (angle < 0) angle += Math.PI * 2;
  const risePerRadian = INTERIOR_STAIR_RISE / INTERIOR_STAIR_ANGLE_STEP;
  const maxAngle = (INTERIOR_STAIR_STEPS - 1) * INTERIOR_STAIR_ANGLE_STEP;
  let bestY = null, bestDist = Infinity;
  for (let turns = 0; turns <= 5; turns++) {
    const sa = angle + turns * Math.PI * 2;
    if (sa < 0 || sa > maxAngle + 0.5) continue;
    const y = INTERIOR_STAIR_START_Y + sa * risePerRadian + 0.07;
    const d = Math.abs(y - currentY);
    if (d < bestDist) { bestDist = d; bestY = y; }
  }
  if (!Number.isFinite(bestY)) return null;
  return THREE.MathUtils.clamp(bestY, GROUND_Y, INTERIOR_TOP_POS.y + 0.12);
}

function clampToPlayableGround(x, z) {
  const MAIN_R  = worldLimit * 1.14;
  const LH_R    = 10.9;
  const INT_R   = INTERIOR_PLAY_RADIUS;
  if (Math.hypot(x, z) <= MAIN_R) return { x, z };
  if (Math.hypot(x-LIGHTHOUSE_POS.x, z-LIGHTHOUSE_POS.z) <= LH_R) return { x, z };
  if (Math.hypot(x-LIGHTHOUSE_INTERIOR_BASE.x, z-LIGHTHOUSE_INTERIOR_BASE.z) <= INT_R) return { x, z };
  if (isSwimZone(x, z)) return { x, z };

  const toMain  = clampToIsland(x, z, MAIN_R);
  const dxL = x-LIGHTHOUSE_POS.x, dzL = z-LIGHTHOUSE_POS.z, lenL = Math.hypot(dxL,dzL)||1;
  const toLight = { x: LIGHTHOUSE_POS.x + (dxL/lenL)*LH_R, z: LIGHTHOUSE_POS.z + (dzL/lenL)*LH_R };
  const dxI = x-LIGHTHOUSE_INTERIOR_BASE.x, dzI = z-LIGHTHOUSE_INTERIOR_BASE.z, lenI = Math.hypot(dxI,dzI)||1;
  const toInt   = { x: LIGHTHOUSE_INTERIOR_BASE.x + (dxI/lenI)*INT_R, z: LIGHTHOUSE_INTERIOR_BASE.z + (dzI/lenI)*INT_R };
  const toSwim  = clampToRing(x, z, SWIM_MIN_R, SWIM_MAX_R);

  const dMain  = Math.hypot(x-toMain.x,  z-toMain.z);
  const dLight = Math.hypot(x-toLight.x, z-toLight.z);
  const dInt   = Math.hypot(x-toInt.x,   z-toInt.z);
  const dSwim  = Math.hypot(x-toSwim.x,  z-toSwim.z);

  if (dMain <= dLight && dMain <= dInt && dMain <= dSwim) return toMain;
  if (dLight <= dInt  && dLight <= dSwim)                 return toLight;
  if (dInt   <= dSwim)                                    return toInt;
  return toSwim;
}

function applyLocalSurfaceState(local) {
  const inWater = isWaterAt(local.x, local.z);
  if (inWater && !inLighthouseInterior) {
    if (!local.isSwimming && local.y <= SWIM_SURFACE_Y + 0.58) local.isSwimming = true;
    if (local.isSwimming  && local.y >  SWIM_SURFACE_Y + 0.82) local.isSwimming = false;
  } else {
    local.isSwimming = false;
  }
}

function surfaceHintOverride(local) {
  if (!local) return null;
  if (local.isSwimming) return 'Swimming – Space/W to surface, S/C to dive, WASD to move';
  if (isSwimZone(local.x, local.z)) return 'You are floating – move back to island or lighthouse';
  return null;
}

function resolveBoatShoreCollision(x, z) {
  let nx = x, nz = z, collided = false;
  for (const c of [{ cx:0, cz:0, radius:BOAT_CLEARANCE_MAIN }, { cx:LIGHTHOUSE_POS.x, cz:LIGHTHOUSE_POS.z, radius:BOAT_CLEARANCE_LIGHTHOUSE }]) {
    const dx = nx-c.cx, dz = nz-c.cz, dist = Math.hypot(dx, dz);
    if (dist < c.radius) { const s = c.radius/(dist||1); nx = c.cx+dx*s; nz = c.cz+dz*s; collided = true; }
  }
  return { x: nx, z: nz, collided };
}

// ---------------------------------------------------------------------------
// Day/weather cycle
// ---------------------------------------------------------------------------
const DAY_PALETTES = [
  { sky: 0xb7d7e6, fog: 0xb7d7e6, sunI: 1.12, hemiI: 1.1, label: 'Morning' },
  { sky: 0x87ceeb, fog: 0x9ec8db, sunI: 1.4,  hemiI: 1.3, label: 'Day' },
  { sky: 0xf4a460, fog: 0xe8a87c, sunI: 0.9,  hemiI: 0.8, label: 'Sunset' },
  { sky: 0x1c2a4a, fog: 0x1c2a4a, sunI: 0.15, hemiI: 0.2, label: 'Night' }
];
let dayPhase = 0, dayTimer = 0;
const DAY_PHASE_DURATION = 120;

const WEATHER_STATES = ['Clear', 'Cloudy', 'Rainy', 'Stormy'];
let weatherIdx = 0, weatherTimer = 0;
const WEATHER_DURATION = 90;

function updateDayAndWeather(delta, nowSeconds) {
  dayTimer += delta;
  if (dayTimer >= DAY_PHASE_DURATION) { dayTimer = 0; dayPhase = (dayPhase + 1) % DAY_PALETTES.length; }
  const pal = DAY_PALETTES[dayPhase];
  scene.background = new THREE.Color(pal.sky);
  scene.fog.color.setHex(pal.fog);
  sun.intensity  = pal.sunI;
  hemi.intensity = pal.hemiI;
  if (timeLabelEl) timeLabelEl.textContent = pal.label;

  weatherTimer += delta;
  if (weatherTimer >= WEATHER_DURATION) { weatherTimer = 0; weatherIdx = (weatherIdx + 1) % WEATHER_STATES.length; }
  const weather = WEATHER_STATES[weatherIdx];
  rain.visible = weather === 'Rainy' || weather === 'Stormy';
  if (weatherLabelEl) weatherLabelEl.textContent = weather;
  if (rain.visible) {
    const pos = rainGeo.attributes.position.array;
    for (let i = 0; i < rainCount; i++) {
      pos[i*3+1] -= (weather === 'Stormy' ? 28 : 18) * delta;
      if (pos[i*3+1] < 0) pos[i*3+1] = 35 + Math.random()*5;
    }
    rainGeo.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Local player movement
// ---------------------------------------------------------------------------
let joystickDX = 0, joystickDZ = 0;

function getMovementVector(local) {
  let fx = 0, fz = 0;
  // Keyboard
  if (keys.has('w') || keys.has('arrowup'))    fz -= 1;
  if (keys.has('s') || keys.has('arrowdown'))  fz += 1;
  if (keys.has('a') || keys.has('arrowleft'))  fx -= 1;
  if (keys.has('d') || keys.has('arrowright')) fx += 1;
  // Joystick override
  if (joystickDX !== 0 || joystickDZ !== 0) { fx = joystickDX; fz = joystickDZ; }
  if (fx === 0 && fz === 0) return null;
  // Rotate by camera yaw
  const sin = Math.sin(cameraYaw), cos = Math.cos(cameraYaw);
  return { x: fx*cos - fz*sin, z: fx*sin + fz*cos };
}

function updateLocalPlayer(delta, nowMs) {
  const local = players.get(localPlayerId);
  if (!local) return;
  if (menuOpen || !isAuthenticated) return;

  if (boatState.onboard) { updateBoatMovement(local, delta); return; }

  const move = getMovementVector(local);
  const sprinting = keys.has('shift') && move && !local.isSwimming;
  const sliding   = local.isSliding;

  // Stamina
  if (sprinting && local.stamina > 0) {
    local.stamina = Math.max(0, local.stamina - STAMINA_DRAIN * delta);
  } else if (!sprinting && local.stamina < STAMINA_MAX) {
    local.stamina = Math.min(STAMINA_MAX, local.stamina + STAMINA_RECOVER * delta);
  }
  if (staminaFillEl) staminaFillEl.style.width = `${local.stamina * 100}%`;

  // Slide timer
  if (keys.has('c') && !local.isSwimming && local.y <= GROUND_Y + 0.05) {
    if (!local.isSliding) { local.isSliding = true; local.slideTimer = SLIDE_DURATION; }
  }
  if (local.isSliding) {
    local.slideTimer -= delta;
    if (local.slideTimer <= 0) local.isSliding = false;
  }

  let speed = WALK_SPEED;
  if (local.isSwimming)     speed = WALK_SPEED * 0.68;
  else if (local.isSliding) speed = SLIDE_SPEED;
  else if (sprinting && local.stamina > 0) speed = SPRINT_SPEED;

  let nx = local.x, nz = local.z;
  if (move) {
    nx += move.x * speed * delta;
    nz += move.z * speed * delta;
    local.yaw = Math.atan2(move.x, move.z);
  }

  // Ground vs swim vertical
  const floorY = groundHeightAt(nx, nz, local.y);
  if (local.isSwimming) applySwimVertical(local, delta, nowMs);
  else                  applyGroundVertical(local, delta, floorY);

  applyLocalSurfaceState(local);

  // Bounds
  if (inLighthouseInterior) {
    const dxI = nx - LIGHTHOUSE_INTERIOR_BASE.x, dzI = nz - LIGHTHOUSE_INTERIOR_BASE.z;
    const rI  = Math.hypot(dxI, dzI);
    if (rI > INTERIOR_PLAY_RADIUS - 0.5) {
      const s = (INTERIOR_PLAY_RADIUS - 0.5) / (rI || 1);
      nx = LIGHTHOUSE_INTERIOR_BASE.x + dxI*s; nz = LIGHTHOUSE_INTERIOR_BASE.z + dzI*s;
    }
  } else {
    const resolved = resolveWorldCollisions(nx, nz, local.y);
    nx = resolved.x; nz = resolved.z;
    const clamped = clampToPlayableGround(nx, nz);
    nx = clamped.x; nz = clamped.z;
  }

  local.x = nx; local.z = nz;
  local.mesh.position.set(local.x, local.y, local.z);
  local.mesh.rotation.y = local.yaw;

  // Lighthouse teleport triggers
  if (!isTeleporting) {
    if (!inLighthouseInterior && distance2D(local, LIGHTHOUSE_DOOR_POS) < 1.6 && local.y <= GROUND_Y + 0.4) {
      runTeleportTransition('enter-lighthouse', () => enterLighthouseInterior(local));
    }
    if (inLighthouseInterior && distance2D(local, INTERIOR_EXIT_PORTAL_POS) < 1.5 && local.y >= INTERIOR_TOP_POS.y - 0.5) {
      runTeleportTransition('exit-lighthouse', () => exitLighthouseInterior(local));
    }
  }

  // Animate limbs
  animatePlayerLimbs(local, move ? speed : 0, delta, nowMs);

  // Emit to server (throttled at 20hz by server side anyway)
  socket.emit('move', { x: local.x, y: local.y, z: local.z, yaw: local.yaw, isSwimming: local.isSwimming });
}

function animatePlayerLimbs(player, speed, delta, nowMs) {
  if (!player.mesh._legL) return;
  const moving = speed > 0.1;
  const freq   = player.isSwimming ? 2.8 : (player.isSliding ? 0 : (speed > WALK_SPEED + 1 ? 4.2 : 2.4));
  const phase  = nowMs * 0.001 * freq;
  const swing  = moving ? 0.38 : 0;

  player.mesh._legL.rotation.x =  Math.sin(phase) * swing;
  player.mesh._legR.rotation.x = -Math.sin(phase) * swing;
  player.mesh._armL.rotation.x = -Math.sin(phase) * swing * 0.7;
  player.mesh._armR.rotation.x =  Math.sin(phase) * swing * 0.7;

  if (player.isSliding && player.mesh._head) {
    player.mesh._head.rotation.x += (0.4 - player.mesh._head.rotation.x) * Math.min(1, delta * 8);
  } else if (player.mesh._head) {
    player.mesh._head.rotation.x += (0 - player.mesh._head.rotation.x) * Math.min(1, delta * 8);
  }
}

// ---------------------------------------------------------------------------
// Boat movement
// ---------------------------------------------------------------------------
const BOAT_SPEED_MAX     = 8.5;
const BOAT_ACCEL         = 3.8;
const BOAT_DECEL         = 5.2;
const BOAT_TURN_SPEED    = 1.85;

function updateBoatMovement(local, delta) {
  const fwd  = keys.has('w') || keys.has('arrowup');
  const back  = keys.has('s') || keys.has('arrowdown');
  const left  = keys.has('a') || keys.has('arrowleft');
  const right = keys.has('d') || keys.has('arrowright');

  if (fwd)       boatState.speed = Math.min(BOAT_SPEED_MAX, boatState.speed + BOAT_ACCEL * delta);
  else if (back)  boatState.speed = Math.max(-BOAT_SPEED_MAX*0.5, boatState.speed - BOAT_ACCEL * delta);
  else            boatState.speed += (0 - boatState.speed) * Math.min(1, BOAT_DECEL * delta);

  if (left)  boatState.yaw += BOAT_TURN_SPEED * delta;
  if (right) boatState.yaw -= BOAT_TURN_SPEED * delta;

  const nx = boatState.x + Math.sin(boatState.yaw) * boatState.speed * delta;
  const nz = boatState.z + Math.cos(boatState.yaw) * boatState.speed * delta;
  const resolved = resolveBoatShoreCollision(nx, nz);
  boatState.x = resolved.x; boatState.z = resolved.z;
  if (resolved.collided) boatState.speed *= 0.4;

  // Bob
  boatState.y = 1.05 + Math.sin(Date.now() * 0.0018) * 0.06;

  if (boatState.mesh) {
    boatState.mesh.position.set(boatState.x, boatState.y, boatState.z);
    boatState.mesh.rotation.y = boatState.yaw;
    // Paddle animation
    boatState.paddlePhase += delta * Math.abs(boatState.speed) * 1.4;
    if (boatState.paddleLeftPivot)  boatState.paddleLeftPivot.rotation.z  =  Math.sin(boatState.paddlePhase) * 0.7;
    if (boatState.paddleRightPivot) boatState.paddleRightPivot.rotation.z = -Math.sin(boatState.paddlePhase) * 0.7;
  }

  local.x = boatState.x; local.y = boatState.y + 0.55; local.z = boatState.z;
  local.mesh.position.set(local.x, local.y, local.z);
  local.mesh.rotation.y = boatState.yaw;
  socket.emit('move', { x: local.x, y: local.y, z: local.z, yaw: local.yaw, isSwimming: false });
}

// ---------------------------------------------------------------------------
// Remote player updates
// ---------------------------------------------------------------------------
function updateRemotePlayers(delta) {
  players.forEach((player, id) => {
    if (id === localPlayerId) return;
    // Smooth interpolation
    if (player._targetX !== undefined) {
      player.x += (player._targetX - player.x) * Math.min(1, delta * 12);
      player.y += (player._targetY - player.y) * Math.min(1, delta * 12);
      player.z += (player._targetZ - player.z) * Math.min(1, delta * 12);
    }
    player.mesh.position.set(player.x, player.y, player.z);
    player.mesh.rotation.y = player.yaw || 0;
    // Remote swim state approximation
    const inW = isWaterAt(player.x, player.z);
    if (!inW) player.isSwimming = false;
    else if (!player.isSwimming && player.y <= SWIM_SURFACE_Y + 0.58) player.isSwimming = true;
    else if (player.isSwimming  && player.y >  SWIM_SURFACE_Y + 0.82) player.isSwimming = false;
  });
}

// ---------------------------------------------------------------------------
// Emotes
// ---------------------------------------------------------------------------
const EMOTE_DEFS = {
  wave:  { duration: 1.8, color: 0xffd166 },
  dance: { duration: 3.0, color: 0xa78bfa },
  cheer: { duration: 2.0, color: 0x34d399 }
};

function triggerEmote(emote) {
  const local = players.get(localPlayerId);
  if (!local) return;
  const now = Date.now();
  if (now - lastEmoteAt < 2000) return;
  lastEmoteAt = now;
  local.emote      = emote;
  local.emoteTimer = EMOTE_DEFS[emote]?.duration || 2;
  local.emotePhase = 0;
  socket.emit('emote', { emote });
}

function updatePlayerEmotes(nowMs, delta) {
  players.forEach(player => {
    if (!player.emote) return;
    player.emoteTimer -= delta;
    player.emotePhase += delta;
    if (player.emoteTimer <= 0) { player.emote = null; return; }
    if (!player.mesh._armL) return;
    const t = player.emotePhase;
    switch (player.emote) {
      case 'wave':
        player.mesh._armR.rotation.z = -0.7 + Math.sin(t*8)*0.55;
        break;
      case 'dance':
        player.mesh._armL.rotation.z =  Math.sin(t*6)*0.9;
        player.mesh._armR.rotation.z = -Math.sin(t*6)*0.9;
        player.mesh.position.y = player.y + Math.abs(Math.sin(t*6))*0.08;
        break;
      case 'cheer':
        player.mesh._armL.rotation.z =  Math.PI*0.6 + Math.sin(t*10)*0.25;
        player.mesh._armR.rotation.z = -Math.PI*0.6 - Math.sin(t*10)*0.25;
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Voice chat (WebRTC)
// ---------------------------------------------------------------------------
function updateVoiceVolumes() {
  const local = players.get(localPlayerId);
  if (!local || !voiceEnabled) return;
  voiceAudioEls.forEach((audioEl, peerId) => {
    const peer = players.get(peerId);
    if (!peer) { audioEl.volume = 0; return; }
    const dist = distance2D(local, peer);
    audioEl.volume = Math.max(0, 1 - dist / VOICE_RADIUS);
  });
}

async function enableVoice() {
  if (voiceEnabled) return;
  try {
    localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceEnabled = true;
    if (voiceToggleEl) voiceToggleEl.textContent = 'Voice ON';
    socket.emit('voice:join');
  } catch (e) {
    console.warn('Microphone not available:', e);
  }
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
socket.on('connect',    () => { if (statusEl) statusEl.textContent = 'Connected'; });
socket.on('disconnect', () => { if (statusEl) statusEl.textContent = 'Disconnected'; clearSessionWorld(); setAuthModalOpen(true, 'Disconnected. Please login again.'); });

socket.on('init', (data) => {
  localPlayerId = data.id;
  setAuthModalOpen(false);

  // World state from server
  if (data.interactables) {
    data.interactables.forEach(item => interactables.set(item.id, { ...item }));
    const beacon = interactables.get('beacon');
    if (beacon) beaconGroup.position.set(beacon.x, 0, beacon.z);
  }

  // Existing players
  (data.players || []).forEach(p => {
    if (p.id === localPlayerId) return;
    const entry = createPlayerEntry(p.id, p);
    players.set(p.id, entry);
  });

  // Local player
  const localData = data.playerData || {};
  const localEntry = createPlayerEntry(localPlayerId, localData);
  players.set(localPlayerId, localEntry);

  if (playerCountEl) playerCountEl.textContent = players.size;
});

socket.on('player:join', (p) => {
  if (players.has(p.id)) return;
  const entry = createPlayerEntry(p.id, p);
  players.set(p.id, entry);
  if (playerCountEl) playerCountEl.textContent = players.size;
  addChatMessage(null, `${p.name || p.id} joined.`);
});

socket.on('player:leave', (data) => {
  const p = players.get(data.id);
  if (p) addChatMessage(null, `${p.name || data.id} left.`);
  removePlayer(data.id);
  if (playerCountEl) playerCountEl.textContent = players.size;
});

socket.on('player:move', (data) => {
  const p = players.get(data.id);
  if (!p || data.id === localPlayerId) return;
  p._targetX  = data.x; p._targetY = data.y; p._targetZ = data.z;
  p.yaw       = data.yaw || 0;
  p.isSwimming= !!data.isSwimming;
});

socket.on('player:appearance', (data) => {
  const p = players.get(data.id);
  if (!p) return;
  const newApp = normalizeAppearance(data.appearance);
  p.appearance = newApp;
  scene.remove(p.mesh);
  p.mesh.traverse(obj => { if (obj.isMesh) { obj.geometry?.dispose(); obj.material?.dispose(); } });
  p.mesh = buildPlayerMesh(newApp);
  p.mesh.position.set(p.x, p.y, p.z);
  p.mesh.rotation.y = p.yaw;
  scene.add(p.mesh);
});

socket.on('player:emote', (data) => {
  const p = players.get(data.id);
  if (!p) return;
  p.emote = data.emote; p.emoteTimer = EMOTE_DEFS[data.emote]?.duration || 2; p.emotePhase = 0;
});

socket.on('chat', (data) => {
  addChatMessage(data.name, data.msg);
  const p = players.get(data.id);
  if (p) { p.bubble.textContent = data.msg; p.bubbleUntil = Date.now() + CHAT_BUBBLE_MS; }
});

socket.on('interactable:update', (data) => {
  const item = interactables.get(data.id);
  if (item) Object.assign(item, data);
  else interactables.set(data.id, { ...data });
});

socket.on('world:dayPhase',  (data) => { dayPhase = data.phase || 0; dayTimer = 0; });
socket.on('world:weather',   (data) => { weatherIdx = WEATHER_STATES.indexOf(data.weather); if (weatherIdx < 0) weatherIdx = 0; weatherTimer = 0; });

// Voice signalling
socket.on('voice:offer',     async (data) => { await handleVoiceOffer(data); });
socket.on('voice:answer',    async (data) => { const pc = voicePeers.get(data.from); if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer)); });
socket.on('voice:ice',       async (data) => { const pc = voicePeers.get(data.from); if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(()=>{}); });
socket.on('voice:peer:join', (data) => { initiateVoiceConnection(data.id); });
socket.on('voice:peer:leave',(data) => { cleanupVoicePeer(data.id); });

async function initiateVoiceConnection(peerId) {
  if (!localVoiceStream) return;
  const pc = new RTCPeerConnection();
  voicePeers.set(peerId, pc);
  localVoiceStream.getTracks().forEach(t => pc.addTrack(t, localVoiceStream));
  pc.ontrack = e => setupVoiceAudio(peerId, e.streams[0]);
  pc.onicecandidate = e => { if (e.candidate) socket.emit('voice:ice', { to: peerId, candidate: e.candidate }); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice:offer', { to: peerId, offer });
}

async function handleVoiceOffer(data) {
  if (!localVoiceStream) return;
  const pc = new RTCPeerConnection();
  voicePeers.set(data.from, pc);
  localVoiceStream.getTracks().forEach(t => pc.addTrack(t, localVoiceStream));
  pc.ontrack = e => setupVoiceAudio(data.from, e.streams[0]);
  pc.onicecandidate = e => { if (e.candidate) socket.emit('voice:ice', { to: data.from, candidate: e.candidate }); };
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('voice:answer', { to: data.from, answer });
}

function setupVoiceAudio(peerId, stream) {
  let el = voiceAudioEls.get(peerId);
  if (!el) { el = document.createElement('audio'); el.autoplay = true; document.body.appendChild(el); voiceAudioEls.set(peerId, el); }
  el.srcObject = stream;
}

function cleanupVoicePeer(peerId) {
  const pc = voicePeers.get(peerId);
  if (pc) { pc.close(); voicePeers.delete(peerId); }
  const el = voiceAudioEls.get(peerId);
  if (el) { el.remove(); voiceAudioEls.delete(peerId); }
}

// ---------------------------------------------------------------------------
// Interact (E key / button)
// ---------------------------------------------------------------------------
function handleInteract() {
  const local = players.get(localPlayerId);
  if (!local || !isAuthenticated) return;
  const now = Date.now();
  if (now - lastInteractAt < 400) return;
  lastInteractAt = now;

  // Get off boat
  if (boatState.onboard) {
    boatState.onboard = false;
    local.onboard = false;
    socket.emit('boat:leave');
    return;
  }

  // Board boat
  if (distance2D(local, ISLAND_DOCK_POS) < 6 || distance2D(local, LIGHTHOUSE_DOCK_POS) < 6) {
    if (distance2D(local, { x: boatState.x, z: boatState.z }) < 5.5) {
      boatState.onboard = true; local.onboard = true;
      socket.emit('boat:board');
      return;
    }
  }

  // Lighthouse top portal → back inside
  if (!inLighthouseInterior && distance2D(local, LIGHTHOUSE_TOP_POS) < 3 && local.y > 11.6) {
    runTeleportTransition('enter-lighthouse', () => enterLighthouseInterior(local));
    return;
  }

  // Interior exit portal
  if (inLighthouseInterior && distance2D(local, INTERIOR_EXIT_PORTAL_POS) < 3.1) {
    runTeleportTransition('exit-lighthouse', () => exitLighthouseInterior(local));
    return;
  }

  // Enter lighthouse door
  if (!inLighthouseInterior && (distance2D(local, LIGHTHOUSE_DOOR_POS) < 5.2 || distance2D(local, LIGHTHOUSE_POS) < 8.6)) {
    runTeleportTransition('enter-lighthouse', () => enterLighthouseInterior(local));
    return;
  }

  // Beacon
  const beacon = interactables.get('beacon');
  if (beacon && Math.hypot(local.x - beacon.x, local.z - beacon.z) <= 4.2) {
    socket.emit('interact', { id: 'beacon' });
  }
}

function enterLighthouseInterior(local) {
  inLighthouseInterior = true;
  if (lighthouseInteriorGroup) lighthouseInteriorGroup.visible = true;
  local.x = INTERIOR_ENTRY_POS.x; local.y = INTERIOR_ENTRY_POS.y; local.z = INTERIOR_ENTRY_POS.z;
  local.vy = 0;
  cameraDistanceTarget = 9;
}

function exitLighthouseInterior(local) {
  inLighthouseInterior = false;
  if (lighthouseInteriorGroup) lighthouseInteriorGroup.visible = false;
  local.x = LIGHTHOUSE_TOP_POS.x; local.y = LIGHTHOUSE_TOP_POS.y + 0.2; local.z = LIGHTHOUSE_TOP_POS.z;
  local.vy = 0;
  cameraDistanceTarget = 14;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function addChatMessage(name, msg) {
  const li = document.createElement('li');
  if (name) {
    const meta = document.createElement('span');
    meta.className = 'meta'; meta.textContent = name + ':';
    li.appendChild(meta);
  }
  li.appendChild(document.createTextNode(msg));
  chatLogEl.appendChild(li);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  while (chatLogEl.children.length > 60) chatLogEl.removeChild(chatLogEl.firstChild);
}

// ---------------------------------------------------------------------------
// Customize modal
// ---------------------------------------------------------------------------
let previewCtx = customizePreviewEl ? customizePreviewEl.getContext('2d') : null;

function setCustomizeModal(open) {
  if (!customizeModalEl) return;
  customizeModalEl.classList.toggle('hidden', !open);
  if (open) renderPreview();
}

function getFormAppearance() {
  return normalizeAppearance({
    skin:      skinInputEl?.value,
    shirt:     colorInputEl?.value,
    pants:     pantsColorInputEl?.value,
    shoes:     shoesColorInputEl?.value,
    hairStyle: hairStyleInputEl?.value,
    hairColor: hairColorInputEl?.value,
    faceStyle: faceStyleInputEl?.value,
    accessories: [...selectedAccessories]
  });
}

function renderPreview() {
  if (!previewCtx || customizeModalEl?.classList.contains('hidden')) return;
  const app = getFormAppearance();
  const W = customizePreviewEl.width, H = customizePreviewEl.height;
  previewCtx.clearRect(0, 0, W, H);
  previewCtx.fillStyle = 'radial-gradient(circle at 50% 30%, #2f3a4b, #0f172a)';
  previewCtx.fillRect(0, 0, W, H);

  // Simple 2D avatar preview
  const cx = W/2, cy = H*0.42, s = W*0.38;
  // Body
  previewCtx.fillStyle = app.shirt; previewCtx.fillRect(cx-s*0.38, cy-s*0.38, s*0.76, s*0.7);
  // Head
  previewCtx.fillStyle = app.skin; previewCtx.fillRect(cx-s*0.3, cy-s*0.95, s*0.6, s*0.52);
  // Pants
  previewCtx.fillStyle = app.pants; previewCtx.fillRect(cx-s*0.36, cy+s*0.3, s*0.32, s*0.45); previewCtx.fillRect(cx+s*0.04, cy+s*0.3, s*0.32, s*0.45);
  // Shoes
  previewCtx.fillStyle = app.shoes; previewCtx.fillRect(cx-s*0.38, cy+s*0.72, s*0.34, s*0.14); previewCtx.fillRect(cx+s*0.02, cy+s*0.72, s*0.34, s*0.14);
  // Hair
  if (app.hairStyle !== 'none') { previewCtx.fillStyle = app.hairColor; previewCtx.fillRect(cx-s*0.32, cy-s*0.97, s*0.64, s*0.2); }
  // Eyes
  previewCtx.fillStyle = '#1a1a2e';
  previewCtx.beginPath(); previewCtx.arc(cx-s*0.12, cy-s*0.65, s*0.05, 0, Math.PI*2); previewCtx.fill();
  previewCtx.beginPath(); previewCtx.arc(cx+s*0.12, cy-s*0.65, s*0.05, 0, Math.PI*2); previewCtx.fill();
}

// ---------------------------------------------------------------------------
// HUD / minimap / compass (throttled)
// ---------------------------------------------------------------------------
function updateHud() {
  // Called once; dynamic parts updated in animate loop
}

function drawMinimap(nowMs) {
  if (nowMs - _lastMinimapDraw < 100) return;
  _lastMinimapDraw = nowMs;

  const size   = minimapEl.width;
  const center = size/2;
  const radius = center-8;
  minimapCtx.clearRect(0, 0, size, size);

  minimapCtx.fillStyle = '#1f4564';
  minimapCtx.beginPath(); minimapCtx.arc(center, center, radius+2, 0, Math.PI*2); minimapCtx.fill();

  minimapCtx.fillStyle = '#638852';
  minimapCtx.beginPath(); minimapCtx.arc(center, center, radius*0.72, 0, Math.PI*2); minimapCtx.fill();

  minimapCtx.strokeStyle = 'rgba(255,255,255,0.35)'; minimapCtx.lineWidth = 1;
  minimapCtx.beginPath(); minimapCtx.arc(center, center, radius*0.72, 0, Math.PI*2); minimapCtx.stroke();

  const scale = (radius*0.72)/worldLimit;
  const beacon = interactables.get('beacon');
  if (beacon) {
    minimapCtx.fillStyle = beacon.active ? '#fbbf24' : '#38bdf8';
    minimapCtx.beginPath(); minimapCtx.arc(center+beacon.x*scale, center+beacon.z*scale, 4, 0, Math.PI*2); minimapCtx.fill();
  }

  minimapCtx.fillStyle = '#f97316';
  minimapCtx.beginPath(); minimapCtx.arc(center+ISLAND_DOCK_POS.x*scale, center+ISLAND_DOCK_POS.z*scale, 3, 0, Math.PI*2); minimapCtx.fill();
  minimapCtx.beginPath(); minimapCtx.arc(center+LIGHTHOUSE_DOCK_POS.x*scale, center+LIGHTHOUSE_DOCK_POS.z*scale, 3, 0, Math.PI*2); minimapCtx.fill();

  minimapCtx.fillStyle = '#f8fafc';
  minimapCtx.beginPath(); minimapCtx.arc(center+LIGHTHOUSE_POS.x*scale, center+LIGHTHOUSE_POS.z*scale, 4, 0, Math.PI*2); minimapCtx.fill();

  if (boatState.mesh) {
    minimapCtx.fillStyle = '#a16207';
    minimapCtx.beginPath(); minimapCtx.arc(center+boatState.x*scale, center+boatState.z*scale, 3, 0, Math.PI*2); minimapCtx.fill();
  }

  players.forEach((p, id) => {
    minimapCtx.fillStyle = id === localPlayerId ? '#ffd166' : '#f8fafc';
    minimapCtx.beginPath(); minimapCtx.arc(center+p.x*scale, center+p.z*scale, id===localPlayerId?4:3, 0, Math.PI*2); minimapCtx.fill();
  });

  const deg = ((THREE.MathUtils.radToDeg(cameraYaw) % 360) + 360) % 360;
  const labels = ['N','NE','E','SE','S','SW','W','NW'];
  compassEl.textContent = `Heading: ${labels[Math.round(deg/45)%8]} (${Math.round(deg)}°)`;
}

// ---------------------------------------------------------------------------
// Name tags (throttled)
// ---------------------------------------------------------------------------
const _ndc = new THREE.Vector3();
function updateNameTags(nowMs) {
  if (nowMs - _lastNameTagUpdate < 50) return;
  _lastNameTagUpdate = nowMs;

  const vW = window.innerWidth/2, vH = window.innerHeight/2;
  const BUBBLE_GAP = BUBBLE_PIXEL_GAP;
  const now = nowMs;

  players.forEach(player => {
    if (!player.label) return;
    _ndc.set(player.x, player.y + 1.9, player.z).project(camera);
    if (_ndc.z > 1) { player.label.style.display = 'none'; if (player.bubble) player.bubble.style.display = 'none'; return; }
    player.label.style.display = '';
    player.label.style.left = `${_ndc.x * vW + vW}px`;
    player.label.style.top  = `${-_ndc.y * vH + vH}px`;

    if (!player.bubble) return;
    if (now > player.bubbleUntil) { player.bubble.style.display = 'none'; return; }
    const alpha = Math.max(0, Math.min(1, (player.bubbleUntil - now) / CHAT_BUBBLE_MS));
    player.bubble.style.display  = 'block';
    player.bubble.style.opacity  = `${alpha}`;
    player.bubble.style.left     = `${_ndc.x * vW + vW}px`;
    player.bubble.style.top      = `${-_ndc.y * vH + vH - BUBBLE_GAP}px`;
  });
}

// ---------------------------------------------------------------------------
// Interaction hint
// ---------------------------------------------------------------------------
function updateInteractionHint() {
  const local = players.get(localPlayerId);
  if (!local) { interactHintEl.textContent = 'Explore the island'; return; }
  if (boatState.onboard) { interactHintEl.textContent = 'Boat controls: W/S move, A/D steer, E to get off'; return; }
  const swimHint = surfaceHintOverride(local);
  if (swimHint) { interactHintEl.textContent = swimHint; return; }
  if (inLighthouseInterior) {
    interactHintEl.textContent = distance2D(local, INTERIOR_EXIT_PORTAL_POS) < 3.1
      ? 'Press E on the glowing marker to go to lighthouse top'
      : 'Climb the stairs to the glowing marker at the top';
    return;
  }
  if (distance2D(local, LIGHTHOUSE_TOP_POS) < 3 && local.y > 11.6) { interactHintEl.textContent = 'Press E on portal to go back inside lighthouse'; return; }
  if (distance2D(local, LIGHTHOUSE_DOOR_POS) < 5.2 || distance2D(local, LIGHTHOUSE_POS) < 8.6) { interactHintEl.textContent = 'Press E to enter lighthouse'; return; }
  if (distance2D(local, ISLAND_DOCK_POS) < 6 || distance2D(local, LIGHTHOUSE_DOCK_POS) < 6) { interactHintEl.textContent = 'Press E to board boat'; return; }
  const beacon = interactables.get('beacon');
  if (beacon && Math.hypot(local.x - beacon.x, local.z - beacon.z) <= 4.2) { interactHintEl.textContent = 'Press E to toggle beacon'; return; }
  interactHintEl.textContent = 'Use dock boat to reach lighthouse';
}

// ---------------------------------------------------------------------------
// Input events
// ---------------------------------------------------------------------------
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === ' ' && !e.target.closest('input,textarea')) {
    e.preventDefault();
    pendingJump = true;
  }
  if (k === 'e') handleInteract();
  if (k === '1') triggerEmote('wave');
  if (k === '2') triggerEmote('dance');
  if (k === '3') triggerEmote('cheer');
  if (k === 'escape') { setMenuOpen(false); setCustomizeModal(false); }
  if (k === 'q') {
    emoteWheelOpen = !emoteWheelOpen;
    emoteWheelEl?.classList.toggle('hidden', !emoteWheelOpen);
  }
});

window.addEventListener('keyup', e => {
  keys.delete(e.key.toLowerCase());
});

// Mouse orbit
let isDragging = false, lastMouseX = 0, lastMouseY = 0;
renderer.domElement.addEventListener('mousedown', e => {
  if (e.button !== 0 && e.button !== 2) return;
  isDragging = true; lastMouseX = e.clientX; lastMouseY = e.clientY;
});
window.addEventListener('mouseup',   () => { isDragging = false; });
window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const dx = e.clientX - lastMouseX, dy = e.clientY - lastMouseY;
  lastMouseX = e.clientX; lastMouseY = e.clientY;
  cameraYaw   -= dx * 0.005;
  cameraPitch  = THREE.MathUtils.clamp(cameraPitch - dy * 0.004, 0.05, Math.PI*0.48);
});
renderer.domElement.addEventListener('wheel', e => {
  cameraDistanceTarget = THREE.MathUtils.clamp(cameraDistanceTarget + e.deltaY * 0.01, 4, 28);
}, { passive: true });
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

// Touch orbit
let touchStartX = 0, touchStartY = 0;
renderer.domElement.addEventListener('touchstart', e => {
  if (e.touches.length === 1) { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; }
}, { passive: true });
renderer.domElement.addEventListener('touchmove', e => {
  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - touchStartX, dy = e.touches[0].clientY - touchStartY;
    touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY;
    cameraYaw   -= dx * 0.005;
    cameraPitch  = THREE.MathUtils.clamp(cameraPitch - dy*0.004, 0.05, Math.PI*0.48);
  }
}, { passive: true });

// Joystick
let joystickTouchId = null;
joystickEl?.addEventListener('touchstart', e => {
  for (const t of e.changedTouches) {
    joystickTouchId = t.identifier;
    const rect = joystickEl.getBoundingClientRect();
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    const dx = t.clientX - cx, dy = t.clientY - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const norm = Math.min(1, dist / 50);
    joystickDX = (dx/dist) * norm; joystickDZ = (dy/dist) * norm;
    if (joystickStickEl) joystickStickEl.style.transform = `translate(${dx*0.6}px,${dy*0.6}px)`;
  }
}, { passive: true });
joystickEl?.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    if (t.identifier !== joystickTouchId) continue;
    const rect = joystickEl.getBoundingClientRect();
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    const dx = t.clientX - cx, dy = t.clientY - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const norm = Math.min(1, dist / 50);
    joystickDX = (dx/dist) * norm; joystickDZ = (dy/dist) * norm;
    if (joystickStickEl) joystickStickEl.style.transform = `translate(${Math.min(40,Math.max(-40,dx*0.6))}px,${Math.min(40,Math.max(-40,dy*0.6))}px)`;
  }
}, { passive: true });
joystickEl?.addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === joystickTouchId) { joystickDX = 0; joystickDZ = 0; joystickTouchId = null; if (joystickStickEl) joystickStickEl.style.transform = ''; }
  }
}, { passive: true });

// Mobile buttons
mobileJumpEl?.addEventListener('click',  () => { pendingJump = true; });
mobileUseEl?.addEventListener('click',   () => handleInteract());
mobileEmoteEl?.addEventListener('click', () => {
  emoteWheelOpen = !emoteWheelOpen;
  emoteWheelEl?.classList.toggle('hidden', !emoteWheelOpen);
});

// Emote buttons
emoteButtons.forEach(btn => btn.addEventListener('click', () => triggerEmote(btn.dataset.emote)));
wheelButtons.forEach(btn => btn.addEventListener('click', () => {
  triggerEmote(btn.dataset.wheelEmote);
  emoteWheelOpen = false;
  emoteWheelEl?.classList.add('hidden');
}));

// Auth
authLoginEl?.addEventListener('click', () => {
  const u = authUsernameEl.value.trim().toLowerCase();
  const p = authPasswordEl.value;
  if (!u || !p) { if (authStatusEl) authStatusEl.textContent = 'Enter username and password.'; return; }
  if (authStatusEl) authStatusEl.textContent = 'Logging in…';
  socket.emit('auth:login', { username: u, password: p }, r => {
    if (r?.ok) { persistAuth(u, p); if (authStatusEl) authStatusEl.textContent = `Welcome, ${u}.`; }
    else { if (authStatusEl) authStatusEl.textContent = r?.error || 'Login failed.'; }
  });
});

authRegisterEl?.addEventListener('click', () => {
  const u = authUsernameEl.value.trim().toLowerCase();
  const p = authPasswordEl.value;
  if (!u || !p) { if (authStatusEl) authStatusEl.textContent = 'Enter username and password.'; return; }
  if (authStatusEl) authStatusEl.textContent = 'Creating account…';
  socket.emit('auth:register', { username: u, password: p }, r => {
    if (r?.ok) { persistAuth(u, p); if (authStatusEl) authStatusEl.textContent = `Account created. Welcome, ${u}!`; }
    else { if (authStatusEl) authStatusEl.textContent = r?.error || 'Registration failed.'; }
  });
});

// Guest auto-auth on page load
autoAuthToGameplay();

// Menu
menuToggleEl?.addEventListener('click',  () => setMenuOpen(!menuOpen));
saveQuitEl?.addEventListener('click', () => {
  const local = players.get(localPlayerId);
  if (local) socket.emit('save', { x: local.x, y: local.y, z: local.z });
  socket.disconnect();
  setAuthModalOpen(true, 'Progress saved. You can close the tab or log in again.');
  setMenuOpen(false);
});

// Customize
customizeOpenEl?.addEventListener('click',  () => { setCustomizeModal(true); setMenuOpen(false); });
customizeCloseEl?.addEventListener('click', () => setCustomizeModal(false));

itemCards.forEach(card => {
  card.addEventListener('click', () => {
    const { type, value } = card.dataset;
    if (type === 'hair') {
      hairStyleInputEl.value = value;
      document.querySelectorAll('[data-type="hair"]').forEach(c => c.classList.remove('active'));
    } else if (type === 'face') {
      faceStyleInputEl.value = value;
      document.querySelectorAll('[data-type="face"]').forEach(c => c.classList.remove('active'));
    } else if (type === 'accessory') {
      if (selectedAccessories.has(value)) selectedAccessories.delete(value);
      else selectedAccessories.add(value);
    }
    card.classList.toggle('active', selectedAccessories.has(value) || hairStyleInputEl.value === value || faceStyleInputEl.value === value);
    renderPreview();
  });
});

customizeFormEl?.addEventListener('input', () => renderPreview());

customizeFormEl?.addEventListener('submit', e => {
  e.preventDefault();
  const app = getFormAppearance();
  const name = nameInputEl.value.trim() || undefined;
  localStorage.setItem('island_profile_name',        name || '');
  localStorage.setItem('island_profile_color',       app.shirt);
  localStorage.setItem('island_profile_skin',        app.skin);
  localStorage.setItem('island_profile_hair_style',  app.hairStyle);
  localStorage.setItem('island_profile_hair_color',  app.hairColor);
  localStorage.setItem('island_profile_face_style',  app.faceStyle);
  localStorage.setItem('island_profile_pants_color', app.pants);
  localStorage.setItem('island_profile_shoes_color', app.shoes);
  localStorage.setItem('island_profile_accessories', [...selectedAccessories].join(','));
  socket.emit('customize', { name, appearance: app });
  if (customizeStatusEl) customizeStatusEl.textContent = 'Saved!';
  clearTimeout(customizeTimer);
  customizeTimer = setTimeout(() => { if (customizeStatusEl) customizeStatusEl.textContent = 'No changes yet.'; }, 2500);
});

outfitSaveButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const slot = btn.dataset.outfitSave;
    const data = { appearance: getFormAppearance(), name: nameInputEl.value.trim() };
    localStorage.setItem(`island_outfit_${slot}`, JSON.stringify(data));
    if (customizeStatusEl) customizeStatusEl.textContent = `Outfit ${slot} saved.`;
  });
});

outfitLoadButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const slot = btn.dataset.outfitLoad;
    const raw  = localStorage.getItem(`island_outfit_${slot}`);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const app  = normalizeAppearance(data.appearance);
      if (data.name) nameInputEl.value        = data.name;
      colorInputEl.value        = app.shirt;
      skinInputEl.value         = app.skin;
      hairStyleInputEl.value    = app.hairStyle;
      hairColorInputEl.value    = app.hairColor;
      faceStyleInputEl.value    = app.faceStyle;
      pantsColorInputEl.value   = app.pants;
      shoesColorInputEl.value   = app.shoes;
      selectedAccessories.clear();
      app.accessories.forEach(a => selectedAccessories.add(a));
      renderPreview();
    } catch {}
  });
});

voiceToggleEl?.addEventListener('click', enableVoice);

// ---------------------------------------------------------------------------
// Main animation loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate(nowMs) {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  updateDayAndWeather(delta, nowMs/1000);
  beaconCore.rotation.y += delta * 1.2;

  const beacon = interactables.get('beacon');
  if (beacon?.active) beaconCore.position.y = 3.0 + Math.sin(nowMs*0.004)*0.12;
  else beaconCore.position.y += (3.0 - beaconCore.position.y) * Math.min(1, delta*8);

  if (lighthouseInteriorPortal) {
    lighthouseInteriorPortal.rotation.y += delta * 0.7;
    lighthouseInteriorPortal.position.y  = INTERIOR_EXIT_PORTAL_POS.y + Math.sin(nowMs*0.0042)*0.08;
  }
  if (lighthouseTopPortal) {
    lighthouseTopPortal.rotation.y += delta * 0.9;
    lighthouseTopPortal.position.y  = 13.23 + Math.sin(nowMs*0.005)*0.06;
  }

  updateLocalPlayer(delta, nowMs);
  updateRemotePlayers(delta);
  updateInteractionHint();
  updatePlayerEmotes(nowMs, delta);
  updateVoiceVolumes();

  const local = players.get(localPlayerId);
  if (local) {
    const activeCamDist = inLighthouseInterior ? Math.min(cameraDistanceTarget, 10.5) : cameraDistanceTarget;
    cameraDistance += (activeCamDist - cameraDistance) * Math.min(1, delta*10);
    if (inLighthouseInterior) cameraDistance = Math.min(cameraDistance, 10.5);

    const horiz   = Math.cos(cameraPitch) * cameraDistance;
    const offsetX = Math.sin(cameraYaw)   * horiz;
    const offsetY = Math.sin(cameraPitch) * cameraDistance;
    const offsetZ = Math.cos(cameraYaw)   * horiz;
    let desiredX  = local.x + offsetX;
    let desiredZ  = local.z + offsetZ;
    const headY   = local.y + (local.isSwimming ? 1.15 : 1.78);
    const desiredY= headY + offsetY;

    if (inLighthouseInterior) {
      const camR = INTERIOR_PLAY_RADIUS - 1.35;
      const cdx  = desiredX - LIGHTHOUSE_INTERIOR_BASE.x, cdz = desiredZ - LIGHTHOUSE_INTERIOR_BASE.z;
      const clen = Math.hypot(cdx, cdz);
      if (clen > camR) { const s = camR/(clen||1); desiredX = LIGHTHOUSE_INTERIOR_BASE.x+cdx*s; desiredZ = LIGHTHOUSE_INTERIOR_BASE.z+cdz*s; }
    }

    camera.position.x += (desiredX - camera.position.x) * Math.min(1, delta*10);
    camera.position.y += (desiredY - camera.position.y) * Math.min(1, delta*10);
    camera.position.z += (desiredZ - camera.position.z) * Math.min(1, delta*10);
    camera.lookAt(local.x, headY - (local.isSwimming ? 0.2 : 0.05), local.z);
  }

  updateNameTags(nowMs);
  drawMinimap(nowMs);
  renderer.render(scene, camera);
  renderPreview();
}

updateHud();
requestAnimationFrame(animate);
