import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

const socket = io();
const players = new Map();
const interactables = new Map();
const keys = new Set();

let worldLimit = 40;
let localPlayerId = null;
let customizeTimer = null;
let lastInteractAt = 0;
let lastEmoteAt = 0;
let pendingJump = false;
let emoteWheelOpen = false;
let menuOpen = false;
let isAuthenticated = false;
const CHAT_BUBBLE_MS = 4500;

const statusEl = document.getElementById('status');
const playerCountEl = document.getElementById('player-count');
const interactHintEl = document.getElementById('interact-hint');
const timeLabelEl = document.getElementById('time-label');
const weatherLabelEl = document.getElementById('weather-label');
const compassEl = document.getElementById('compass');
const miniPanelEl = document.getElementById('mini-panel');
const minimapEl = document.getElementById('mini-map');
const minimapCtx = minimapEl.getContext('2d');
const minimapToggleEl = document.getElementById('minimap-toggle');
const chatLogEl = document.getElementById('chat-log');
const chatFormEl = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');
const chatPanelEl = document.getElementById('chat-panel');
const customizeFormEl = document.getElementById('customize-form');
const nameInputEl = document.getElementById('name-input');
const skinInputEl = document.getElementById('skin-input');
const hairStyleInputEl = document.getElementById('hair-style-input');
const hairColorInputEl = document.getElementById('hair-color-input');
const faceStyleInputEl = document.getElementById('face-style-input');
const colorInputEl = document.getElementById('color-input');
const pantsColorInputEl = document.getElementById('pants-color-input');
const shoesColorInputEl = document.getElementById('shoes-color-input');
const customizeStatusEl = document.getElementById('customize-status');
const customizeOpenEl = document.getElementById('customize-open');
const customizeCloseEl = document.getElementById('customize-close');
const customizeModalEl = document.getElementById('customize-modal');
const customizePreviewEl = document.getElementById('customize-preview');
const itemCards = Array.from(document.querySelectorAll('.item-card'));
const outfitSaveButtons = Array.from(document.querySelectorAll('[data-outfit-save]'));
const outfitLoadButtons = Array.from(document.querySelectorAll('[data-outfit-load]'));
const staminaFillEl = document.getElementById('stamina-fill');
const voiceToggleEl = document.getElementById('voice-toggle');
const menuToggleEl = document.getElementById('menu-toggle');
const chatToggleEl = document.getElementById('chat-toggle');
const voiceQuickToggleEl = document.getElementById('voice-quick-toggle');
const fullscreenToggleEl = document.getElementById('fullscreen-toggle');
const menuOverlayEl = document.getElementById('menu-overlay');
const saveQuitEl = document.getElementById('save-quit');
const authModalEl = document.getElementById('auth-modal');
const authUsernameEl = document.getElementById('auth-username');
const authPasswordEl = document.getElementById('auth-password');
const authLoginEl = document.getElementById('auth-login');
const authRegisterEl = document.getElementById('auth-register');
const authStatusEl = document.getElementById('auth-status');
const emoteWheelEl = document.getElementById('emote-wheel');
const wheelButtons = Array.from(document.querySelectorAll('[data-wheel-emote]'));
const nameTagsEl = document.getElementById('name-tags');
const emoteButtons = Array.from(document.querySelectorAll('[data-emote]'));
const gameplayPanels = ['hud', 'mini-panel', 'chat-panel', 'world-state', 'top-left-toolbar']
  .map((id) => document.getElementById(id))
  .filter(Boolean);

const cachedAuthUsername = localStorage.getItem('island_auth_username') || '';
const cachedAuthPassword = localStorage.getItem('island_auth_password') || '';
if (authUsernameEl) authUsernameEl.value = cachedAuthUsername;
if (authPasswordEl) authPasswordEl.value = cachedAuthPassword;

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
  const initialUsername = (authUsernameEl?.value || '').trim().toLowerCase();
  const initialPassword = authPasswordEl?.value || '';
  const creds = initialUsername && initialPassword ? { username: initialUsername, password: initialPassword } : makeGuestCredentials();

  const tryGuestFallback = () => {
    const guest = makeGuestCredentials();
    if (authStatusEl) authStatusEl.textContent = 'Creating guest session...';
    socket.emit('auth:register', guest, (registerGuest) => {
      if (!registerGuest?.ok) {
        if (authStatusEl) authStatusEl.textContent = registerGuest?.error || 'Login failed. Click Login.';
        return;
      }
      persistAuth(guest.username, guest.password);
      if (authStatusEl) authStatusEl.textContent = `Welcome, ${guest.username}.`;
    });
  };

  if (authStatusEl) authStatusEl.textContent = 'Signing in...';
  socket.emit('auth:login', creds, (loginResp) => {
    if (loginResp?.ok) {
      persistAuth(creds.username, creds.password);
      if (authStatusEl) authStatusEl.textContent = `Welcome, ${creds.username}.`;
      return;
    }
    socket.emit('auth:register', creds, (registerResp) => {
      if (registerResp?.ok) {
        persistAuth(creds.username, creds.password);
        if (authStatusEl) authStatusEl.textContent = `Welcome, ${creds.username}.`;
        return;
      }
      tryGuestFallback();
    });
  });
}

const cachedName = localStorage.getItem('island_profile_name');
const cachedShirt = localStorage.getItem('island_profile_color');
const cachedSkin = localStorage.getItem('island_profile_skin');
const cachedHairStyle = localStorage.getItem('island_profile_hair_style');
const cachedHairColor = localStorage.getItem('island_profile_hair_color');
const cachedFaceStyle = localStorage.getItem('island_profile_face_style');
const cachedPants = localStorage.getItem('island_profile_pants_color');
const cachedShoes = localStorage.getItem('island_profile_shoes_color');
const cachedAccessories = localStorage.getItem('island_profile_accessories');
if (cachedName) nameInputEl.value = cachedName;
if (/^#[0-9a-fA-F]{6}$/.test(cachedShirt || '')) colorInputEl.value = cachedShirt;
if (/^#[0-9a-fA-F]{6}$/.test(cachedSkin || '')) skinInputEl.value = cachedSkin;
if (['none', 'short', 'sidepart', 'spiky', 'long', 'ponytail', 'bob', 'wavy'].includes(cachedHairStyle || '')) hairStyleInputEl.value = cachedHairStyle;
if (/^#[0-9a-fA-F]{6}$/.test(cachedHairColor || '')) hairColorInputEl.value = cachedHairColor;
if (['smile', 'serious', 'grin', 'wink', 'lashessmile', 'soft'].includes(cachedFaceStyle || '')) faceStyleInputEl.value = cachedFaceStyle;
if (/^#[0-9a-fA-F]{6}$/.test(cachedPants || '')) pantsColorInputEl.value = cachedPants;
if (/^#[0-9a-fA-F]{6}$/.test(cachedShoes || '')) shoesColorInputEl.value = cachedShoes;

const selectedAccessories = new Set(
  (cachedAccessories || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => ['hat', 'glasses', 'backpack'].includes(item))
);

function setGameplayVisible(visible) {
  gameplayPanels.forEach((panel) => {
    panel.style.display = visible ? '' : 'none';
  });
}

let voiceEnabled = false;
let voiceMuted = false;
const cachedChatOpen = localStorage.getItem('island_chat_open');
let chatPanelOpen = cachedChatOpen === null ? true : cachedChatOpen === '1';
let pointerLocked = false;
let minimapExpanded = false;
let minimapEnabled = localStorage.getItem('island_minimap_enabled') !== '0';

function setMinimapCanvasSize(expanded) {
  const size = expanded ? 296 : 176;
  if (minimapEl.width === size && minimapEl.height === size) return;
  minimapEl.width = size;
  minimapEl.height = size;
}

function updateMinimapToggleLabel() {
  if (!minimapToggleEl) return;
  minimapToggleEl.textContent = minimapEnabled ? 'Minimap: On' : 'Minimap: Off';
}

function setMinimapExpanded(expanded) {
  if (!minimapEnabled) expanded = false;
  minimapExpanded = Boolean(expanded);
  miniPanelEl?.classList.toggle('expanded', minimapExpanded);
  setMinimapCanvasSize(minimapExpanded);
}

function setMinimapEnabled(enabled) {
  minimapEnabled = Boolean(enabled);
  localStorage.setItem('island_minimap_enabled', minimapEnabled ? '1' : '0');
  if (!minimapEnabled) minimapExpanded = false;
  miniPanelEl?.classList.toggle('hidden', !minimapEnabled);
  miniPanelEl?.classList.toggle('expanded', minimapEnabled && minimapExpanded);
  setMinimapCanvasSize(minimapEnabled && minimapExpanded);
  updateMinimapToggleLabel();
}

function setChatPanelOpen(open) {
  chatPanelOpen = Boolean(open);
  localStorage.setItem('island_chat_open', chatPanelOpen ? '1' : '0');
  chatPanelEl?.classList.toggle('hidden', !chatPanelOpen);
  if (chatToggleEl) {
    chatToggleEl.style.filter = chatPanelOpen ? 'none' : 'grayscale(0.95) brightness(0.75)';
    chatToggleEl.title = chatPanelOpen ? 'Hide chat' : 'Open chat';
  }
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 900px), (max-height: 700px), (pointer: coarse)').matches;
}

function applyResponsiveLayout() {
  const mobile = isMobileLayout();
  document.body.classList.toggle('mobile-ui', mobile);
  if (cachedChatOpen === null) {
    setChatPanelOpen(!mobile);
  }
}

function updateVoiceButtonLabels() {
  if (voiceQuickToggleEl) {
    if (!voiceEnabled) {
      voiceQuickToggleEl.textContent = '🎙️';
      voiceQuickToggleEl.title = 'Enable voice chat';
      voiceQuickToggleEl.style.filter = 'grayscale(0.95) brightness(0.75)';
    } else if (voiceMuted) {
      voiceQuickToggleEl.textContent = '🔇';
      voiceQuickToggleEl.title = 'Unmute microphone';
      voiceQuickToggleEl.style.filter = 'none';
    } else {
      voiceQuickToggleEl.textContent = '🎙️';
      voiceQuickToggleEl.title = 'Mute microphone';
      voiceQuickToggleEl.style.filter = 'none';
    }
  }
  if (voiceToggleEl) {
    if (!voiceEnabled) {
      voiceToggleEl.textContent = 'Enable Proximity Voice';
    } else if (voiceMuted) {
      voiceToggleEl.textContent = 'Unmute Mic (Voice On)';
    } else {
      voiceToggleEl.textContent = 'Mute Mic (Voice On)';
    }
  }
}

async function setVoiceMuted(muted) {
  voiceMuted = Boolean(muted);
  if (voiceMuted) {
    if (localVoiceStream) {
      localVoiceStream.getTracks().forEach((track) => track.stop());
      localVoiceStream = null;
    }
    voicePeers.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track?.kind === 'audio' || sender.track === null) {
          sender.replaceTrack(null).catch(() => {});
        }
      });
    });
    updateVoiceButtonLabels();
    return;
  }

  if (!voiceEnabled) {
    updateVoiceButtonLabels();
    return;
  }

  if (!localVoiceStream) {
    try {
      localVoiceStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch {
      voiceMuted = true;
      if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        if (voiceToggleEl) voiceToggleEl.textContent = 'Voice needs HTTPS';
      } else if (voiceToggleEl) {
        voiceToggleEl.textContent = 'Mic blocked';
      }
      updateVoiceButtonLabels();
      return;
    }
  }

  const track = localVoiceStream.getAudioTracks()[0];
  if (track) {
    voicePeers.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track?.kind === 'audio' || sender.track === null) {
          sender.replaceTrack(track).catch(() => {});
        }
      });
    });
  }
  updateVoiceButtonLabels();
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
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }
    keys.clear();
    pendingJump = false;
    emoteWheelOpen = false;
    emoteWheelEl?.classList.add('hidden');
    setCustomizeModal(false);
    menuOpen = false;
    menuOverlayEl?.classList.add('hidden');
  }
}

function setMenuOpen(open) {
  if (!isAuthenticated) return;
  menuOpen = open;
  if (open) {
    keys.clear();
    pendingJump = false;
    emoteWheelOpen = false;
    emoteWheelEl?.classList.add('hidden');
    setCustomizeModal(false);
  }
  menuOverlayEl?.classList.toggle('hidden', !open);
}

setAuthModalOpen(true, 'Login or create an account to continue.');
setChatPanelOpen(chatPanelOpen);
updateVoiceButtonLabels();
setMinimapEnabled(minimapEnabled);
applyResponsiveLayout();

const joystickEl = document.getElementById('joystick');
const joystickStickEl = document.getElementById('joystick-stick');
const mobileJumpEl = document.getElementById('btn-jump');
const mobileUseEl = document.getElementById('btn-use');
const mobileEmoteEl = document.getElementById('btn-emote');

let localVoiceStream = null;
const voicePeers = new Map();
const voiceAudioEls = new Map();
const pendingVoiceIce = new Map();
const VOICE_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];
const VOICE_RADIUS = 180;

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

function updateFullscreenButtonLabel() {
  if (!fullscreenToggleEl) return;
  const active = Boolean(document.fullscreenElement);
  fullscreenToggleEl.textContent = active ? '🡼' : '⛶';
  fullscreenToggleEl.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
}

async function requestPointerLockForGameplay() {
  if (!isAuthenticated || document.pointerLockElement === renderer.domElement) return;
  try {
    const result = renderer.domElement.requestPointerLock?.();
    if (result?.catch) await result;
  } catch {}
}

async function toggleFullscreenPointerLock() {
  if (!isAuthenticated) return;
  if (!document.fullscreenElement) {
    try {
      const fsResult = document.documentElement.requestFullscreen?.();
      if (fsResult?.catch) await fsResult;
    } catch {
      return;
    }
    updateFullscreenButtonLabel();
    await requestPointerLockForGameplay();
    return;
  }
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock?.();
  }
  try {
    const exitResult = document.exitFullscreen?.();
    if (exitResult?.catch) await exitResult;
  } catch {}
  updateFullscreenButtonLabel();
}

document.addEventListener('fullscreenchange', async () => {
  updateFullscreenButtonLabel();
  if (document.fullscreenElement && isAuthenticated) {
    await requestPointerLockForGameplay();
  } else if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock?.();
  }
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});

updateFullscreenButtonLabel();

const hemi = new THREE.HemisphereLight(0xd6f1ff, 0x4d3a27, 1.1);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.12);
sun.position.set(14, 32, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

const water = new THREE.Mesh(
  new THREE.CircleGeometry(170, 80),
  new THREE.MeshStandardMaterial({
    color: 0x2c7ea1,
    roughness: 0.2,
    metalness: 0.05
  })
);
water.rotation.x = -Math.PI / 2;
water.position.y = 0.38;
scene.add(water);

function mainIslandRadiusAtAngle(angle) {
  const profile = 0.86
    + Math.sin(angle * 2 + 0.6) * 0.11
    + Math.sin(angle * 5 - 0.9) * 0.06
    + Math.cos(angle * 1 + 2.1) * 0.04;
  return THREE.MathUtils.clamp(worldLimit * profile, worldLimit * 0.66, worldLimit * 1.08);
}

function radialShape(radiusOffset = 0, segments = 144) {
  const shape = new THREE.Shape();
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    const radius = Math.max(2.2, mainIslandRadiusAtAngle(t) + radiusOffset);
    const x = Math.cos(t) * radius;
    const z = Math.sin(t) * radius;
    if (i === 0) {
      shape.moveTo(x, z);
    } else {
      shape.lineTo(x, z);
    }
  }
  shape.closePath();
  return shape;
}

function addMainIslandTerrain() {
  // Original island scale restored. Only vertical alignment changed to remove the seam.
  const cliff = new THREE.Mesh(
    new THREE.CylinderGeometry(worldLimit + 4, worldLimit + 7, 4.9, 72, 1),
    new THREE.MeshStandardMaterial({ color: 0xc6b188, roughness: 0.96, metalness: 0.01 })
  );
  cliff.position.y = -1.15; // top at ~1.3, matching shoreline layers
  cliff.receiveShadow = true;
  scene.add(cliff);

  const shoreGeo = new THREE.ShapeGeometry(radialShape(2.6), 132);
  shoreGeo.rotateX(-Math.PI / 2);
  const shore = new THREE.Mesh(
    shoreGeo,
    new THREE.MeshStandardMaterial({ color: 0xbb9c6b, roughness: 0.98, metalness: 0.01 })
  );
  shore.position.y = 1.31;
  shore.receiveShadow = true;
  scene.add(shore);

  const sandGeo = new THREE.ShapeGeometry(radialShape(0.85), 132);
  sandGeo.rotateX(-Math.PI / 2);
  const sand = new THREE.Mesh(
    sandGeo,
    new THREE.MeshStandardMaterial({ color: 0xcdb180, roughness: 0.97, metalness: 0.01 })
  );
  sand.position.y = 1.34;
  sand.receiveShadow = true;
  scene.add(sand);

  const grassGeo = new THREE.ShapeGeometry(radialShape(-1.65), 132);
  grassGeo.rotateX(-Math.PI / 2);
  const grass = new THREE.Mesh(
    grassGeo,
    new THREE.MeshStandardMaterial({ color: 0x79a85d, roughness: 0.92, metalness: 0.02 })
  );
  grass.position.y = 1.36;
  grass.receiveShadow = true;
  scene.add(grass);
}

addMainIslandTerrain();

const PLAYER_COLLISION_RADIUS = 0.46;
const worldColliders = [];

function addWorldCollider(x, z, radius, tag = 'solid') {
  worldColliders.push({ x, z, radius, tag });
}

function addWallCollisionFromMesh(mesh, tag = 'house') {
  if (!mesh) return;
  mesh.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(mesh);
  const minX = box.min.x;
  const maxX = box.max.x;
  const minZ = box.min.z;
  const maxZ = box.max.z;
  const width = Math.max(0.01, maxX - minX);
  const depth = Math.max(0.01, maxZ - minZ);
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;

  if (width >= depth) {
    const radius = depth * 0.5 + 0.2;
    const count = Math.max(2, Math.ceil(width / Math.max(0.45, radius * 1.3)));
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const x = minX + t * width;
      addWorldCollider(x, cz, radius, tag);
    }
  } else {
    const radius = width * 0.5 + 0.2;
    const count = Math.max(2, Math.ceil(depth / Math.max(0.45, radius * 1.3)));
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const z = minZ + t * depth;
      addWorldCollider(cx, z, radius, tag);
    }
  }
}

function resolveWorldCollisions(x, z, y = GROUND_Y) {
  let nextX = x;
  let nextZ = z;
  const nearLighthouseDoor = Math.hypot(nextX - LIGHTHOUSE_DOOR_POS.x, nextZ - LIGHTHOUSE_DOOR_POS.z) < 2.35 && y <= GROUND_Y + 2.2;
  for (const collider of worldColliders) {
    if (collider.tag === 'lighthouse-shell' && (inLighthouseInterior || nearLighthouseDoor || y > GROUND_Y + 2.6)) {
      continue;
    }
    const dx = nextX - collider.x;
    const dz = nextZ - collider.z;
    const minDist = PLAYER_COLLISION_RADIUS + collider.radius;
    const dist = Math.hypot(dx, dz);
    if (dist >= minDist) continue;
    const scale = minDist / (dist || 1);
    nextX = collider.x + dx * scale;
    nextZ = collider.z + dz * scale;
  }
  return { x: nextX, z: nextZ };
}

function addPalm(x, z, scale = 1) {
  const trunkCurve = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2 * scale, 0.38 * scale, 4.8 * scale, 10),
    new THREE.MeshStandardMaterial({ color: 0x7b5135, roughness: 0.9 })
  );
  trunkCurve.position.set(x + 0.15 * scale, 2.5 * scale, z - 0.12 * scale);
  trunkCurve.rotation.z = 0.13;
  trunkCurve.castShadow = true;
  trunkCurve.receiveShadow = true;
  scene.add(trunkCurve);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19 * scale, 0.34 * scale, 4.2 * scale, 9),
    new THREE.MeshStandardMaterial({ color: 0x7b5135, roughness: 0.9 })
  );
  trunk.position.set(x, 3.0 * scale, z);
  trunk.rotation.z = -0.09;
  trunk.castShadow = true;
  trunk.receiveShadow = true;

  const leaves = new THREE.Group();
  for (let i = 0; i < 6; i += 1) {
    const frond = new THREE.Mesh(
      new THREE.ConeGeometry(0.22 * scale, 2.25 * scale, 6),
      new THREE.MeshStandardMaterial({ color: 0x2f7f46, roughness: 0.82 })
    );
    frond.rotation.z = Math.PI / 2.35;
    frond.rotation.y = (i / 6) * Math.PI * 2;
    frond.position.set(x, 5.45 * scale, z);
    frond.castShadow = true;
    leaves.add(frond);
  }

  scene.add(trunk);
  scene.add(leaves);
  addWorldCollider(x, z, 0.64 * scale, 'tree');
}

function addBush(x, z, scale = 1) {
  const bush = new THREE.Mesh(
    new THREE.SphereGeometry(0.78 * scale, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x3d8e4d, roughness: 0.88 })
  );
  bush.position.set(x, 1.62 + 0.2 * scale, z);
  bush.castShadow = true;
  bush.receiveShadow = true;
  scene.add(bush);
  addWorldCollider(x, z, 0.5 * scale, 'bush');
}

function addGrassTuft(x, z, scale = 1, color = 0x4f8a3f) {
  const tuft = new THREE.Group();
  for (let i = 0; i < 4; i += 1) {
    const blade = new THREE.Mesh(
      new THREE.ConeGeometry(0.08 * scale, 0.55 * scale, 5),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
    );
    blade.position.set((Math.random() - 0.5) * 0.18 * scale, 1.45 + 0.2 * scale, (Math.random() - 0.5) * 0.18 * scale);
    blade.rotation.x = (Math.random() - 0.5) * 0.24;
    blade.rotation.z = (Math.random() - 0.5) * 0.24;
    tuft.add(blade);
  }
  tuft.position.set(x, 0, z);
  scene.add(tuft);
}

function addFlowerPatch(x, z, count = 10, spread = 2.2) {
  for (let i = 0; i < count; i += 1) {
    const px = x + (Math.random() - 0.5) * spread;
    const pz = z + (Math.random() - 0.5) * spread;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, 0.36, 6),
      new THREE.MeshStandardMaterial({ color: 0x3c8a3a, roughness: 0.92 })
    );
    stem.position.set(px, 1.53, pz);
    const bloomColor = [0xfef08a, 0xfda4af, 0xbfdbfe, 0xf5d0fe][i % 4];
    const bloom = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 6),
      new THREE.MeshStandardMaterial({ color: bloomColor, roughness: 0.75 })
    );
    bloom.position.set(px, 1.76, pz);
    scene.add(stem, bloom);
  }
}

const LIGHTHOUSE_POS = new THREE.Vector3(worldLimit * 1.65, 0, -worldLimit * 1.85);
const ISLAND_DOCK_POS = new THREE.Vector3(worldLimit * 0.92, 1.42, worldLimit * 0.24);
const ISLAND_DOCK_YAW = Math.atan2(-ISLAND_DOCK_POS.z, ISLAND_DOCK_POS.x);
const toMainX = -LIGHTHOUSE_POS.x;
const toMainZ = -LIGHTHOUSE_POS.z;
const toMainLen = Math.hypot(toMainX, toMainZ) || 1;
const LIGHTHOUSE_DOCK_POS = new THREE.Vector3(
  LIGHTHOUSE_POS.x + (toMainX / toMainLen) * 10.6,
  1.36,
  LIGHTHOUSE_POS.z + (toMainZ / toMainLen) * 10.6
);
const LIGHTHOUSE_DOCK_YAW = Math.atan2(-(LIGHTHOUSE_DOCK_POS.z - LIGHTHOUSE_POS.z), LIGHTHOUSE_DOCK_POS.x - LIGHTHOUSE_POS.x);
const LIGHTHOUSE_DOOR_POS = new THREE.Vector3(LIGHTHOUSE_POS.x, 1.36, LIGHTHOUSE_POS.z + 2.8);
const LIGHTHOUSE_TOP_POS = new THREE.Vector3(LIGHTHOUSE_POS.x, 14.2, LIGHTHOUSE_POS.z);
const LIGHTHOUSE_INTERIOR_BASE = new THREE.Vector3(-130, 0, 210);
const INTERIOR_PLAY_RADIUS = 11.2;
const INTERIOR_ENTRY_POS = new THREE.Vector3(LIGHTHOUSE_INTERIOR_BASE.x, 1.36, LIGHTHOUSE_INTERIOR_BASE.z + 8.6);
const INTERIOR_TOP_POS = new THREE.Vector3(LIGHTHOUSE_INTERIOR_BASE.x, 20.8, LIGHTHOUSE_INTERIOR_BASE.z);
const INTERIOR_STAIR_RADIUS = 7.25;
const INTERIOR_STAIR_START_Y = 1.5;
const INTERIOR_STAIR_RISE = 0.155;
const INTERIOR_STAIR_ANGLE_STEP = 0.17;
const INTERIOR_STAIR_STEPS = 126;
const INTERIOR_STAIR_END_ANGLE = (INTERIOR_STAIR_STEPS - 1) * INTERIOR_STAIR_ANGLE_STEP;
const INTERIOR_EXIT_PORTAL_POS = new THREE.Vector3(
  LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(INTERIOR_STAIR_END_ANGLE) * (INTERIOR_STAIR_RADIUS + 0.45),
  INTERIOR_TOP_POS.y + 0.14,
  LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(INTERIOR_STAIR_END_ANGLE) * (INTERIOR_STAIR_RADIUS + 0.45)
);
const SWIM_MIN_RADIUS = worldLimit + 0.6;
const SWIM_MAX_RADIUS = worldLimit * 3.9;
const SWIM_SURFACE_Y = 0.38;
const SWIM_SINK_Y = -3.6;
let lighthouseInteriorGroup = null;
let lighthouseInteriorPortal = null;
let lighthouseTopPortal = null;
let inLighthouseInterior = false;
let isTeleporting = false;
const dockWalkZones = [];

const boatState = {
  mesh: null,
  ...findWaterSideSlot(ISLAND_DOCK_POS, ISLAND_DOCK_YAW, 1, 6.0, 3.2),
  y: 1.05,
  yaw: ISLAND_DOCK_YAW,
  speed: 0,
  onboard: false,
  paddleLeftPivot: null,
  paddleRightPivot: null,
  paddlePhase: 0
};
const BOAT_CLEARANCE_MAIN = worldLimit + 3.4;
const BOAT_CLEARANCE_LIGHTHOUSE = 12.6;
addWorldCollider(LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.z, 2.32, 'lighthouse-shell');

function dockOffsetPosition(dock, yaw, forward = 0, side = 0) {
  const fX = Math.sin(yaw);
  const fZ = Math.cos(yaw);
  const rX = Math.cos(yaw);
  const rZ = -Math.sin(yaw);
  return {
    x: dock.x + fX * forward + rX * side,
    z: dock.z + fZ * forward + rZ * side
  };
}

function findWaterSideSlot(dock, yaw, preferSide = 1, forward = 6.0, baseSide = 3.2) {
  for (const sideDir of [preferSide, -preferSide]) {
    for (let side = baseSide; side <= baseSide + 8; side += 0.5) {
      const pos = dockOffsetPosition(dock, yaw, forward, side * sideDir);
      if (isWaterAt(pos.x, pos.z)) return pos;
    }
  }
  return dockOffsetPosition(dock, yaw, forward, baseSide * preferSide);
}

function dockSlots() {
  return [
    { dock: ISLAND_DOCK_POS, yaw: ISLAND_DOCK_YAW },
    { dock: LIGHTHOUSE_DOCK_POS, yaw: LIGHTHOUSE_DOCK_YAW }
  ];
}

function nearestDockSlot(point, maxDistance = Infinity) {
  let best = null;
  for (const slot of dockSlots()) {
    const dist = distance2D(point, slot.dock);
    if (dist <= maxDistance && (!best || dist < best.distance)) {
      best = { ...slot, distance: dist };
    }
  }
  return best;
}

function boatPoseForDock(slot) {
  if (slot.dock === ISLAND_DOCK_POS) {
    return { ...findWaterSideSlot(slot.dock, slot.yaw, 1, 6.0, 3.2), yaw: slot.yaw };
  }
  return { ...dockOffsetPosition(slot.dock, slot.yaw, 1.8, 0.8), yaw: slot.yaw };
}

function addDock(anchor, yaw = 0, options = {}) {
  const segments = options.segments ?? 7;
  const plankLength = options.plankLength ?? 2.2;
  const plankWidth = options.plankWidth ?? 0.7;
  const spacing = options.spacing ?? 1.05;
  const addRamp = options.addRamp !== false;
  const walkable = options.walkable !== false;
  const dock = new THREE.Group();
  dock.position.copy(anchor);
  dock.rotation.y = yaw;
  const lastCenterX = (segments - 1) * spacing;
  const deckLength = lastCenterX + plankLength;
  const deckCenterX = lastCenterX * 0.5;

  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(deckLength, 0.16, plankWidth),
    new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 })
  );
  deck.position.set(deckCenterX, 0.05, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  dock.add(deck);

  if (addRamp) {
    const ramp = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.18, plankWidth + 0.34),
      new THREE.MeshStandardMaterial({ color: 0x80552f, roughness: 0.9 })
    );
    ramp.position.set(-1.45, -0.01, 0);
    ramp.rotation.z = 0.07;
    ramp.receiveShadow = true;
    dock.add(ramp);
  }

  for (let i = 0; i < segments; i += 1) {
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.165, plankWidth * 0.98),
      new THREE.MeshStandardMaterial({ color: 0x5b412c, roughness: 0.95 })
    );
    seam.position.set(i * spacing - spacing * 0.5, 0.06, 0);
    seam.castShadow = true;
    dock.add(seam);
  }

  const railOffsetZ = plankWidth * 0.5 + 0.2;
  const railHeight = options.railHeight ?? 0.5;
  for (const z of [-railOffsetZ, railOffsetZ]) {
    const topRail = new THREE.Mesh(
      new THREE.BoxGeometry(deckLength + 0.34, 0.1, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x5b412c, roughness: 0.92 })
    );
    topRail.position.set(deckCenterX, railHeight, z);
    topRail.castShadow = true;
    topRail.receiveShadow = true;
    dock.add(topRail);

    const midRail = new THREE.Mesh(
      new THREE.BoxGeometry(deckLength + 0.28, 0.08, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x60452f, roughness: 0.92 })
    );
    midRail.position.set(deckCenterX, railHeight - 0.18, z);
    midRail.castShadow = true;
    midRail.receiveShadow = true;
    dock.add(midRail);
  }

  const railPostGeo = new THREE.BoxGeometry(0.12, railHeight + 0.06, 0.12);
  const railPosts = Math.max(6, Math.floor(deckLength / 1.6));
  for (let i = 0; i <= railPosts; i += 1) {
    const t = railPosts === 0 ? 0 : i / railPosts;
    const px = -plankLength * 0.5 + t * deckLength;
    for (const z of [-railOffsetZ, railOffsetZ]) {
      const post = new THREE.Mesh(
        railPostGeo,
        new THREE.MeshStandardMaterial({ color: 0x4d3624, roughness: 0.94 })
      );
      post.position.set(px, railHeight * 0.5, z);
      post.castShadow = true;
      post.receiveShadow = true;
      dock.add(post);
    }
  }

  const pillarGeo = new THREE.CylinderGeometry(0.14, 0.18, 1.0, 10);
  const pillarRows = Math.max(5, Math.floor(segments * 0.6));
  for (let i = 0; i < pillarRows; i += 1) {
    const t = pillarRows === 1 ? 0 : i / (pillarRows - 1);
    const px = -plankLength * 0.5 + 0.25 + t * (deckLength - 0.5);
    for (const z of [-railOffsetZ + 0.08, railOffsetZ - 0.08]) {
      const pillar = new THREE.Mesh(
        pillarGeo,
        new THREE.MeshStandardMaterial({ color: 0x4b3623, roughness: 0.95 })
      );
      pillar.position.set(px, -0.4, z);
      pillar.castShadow = true;
      dock.add(pillar);
    }
  }

  if (walkable) {
    const startX = addRamp ? -2.8 : -plankLength * 0.5 - 0.2;
    const endX = lastCenterX + plankLength * 0.5 + 0.25;
    const deckMinX = -plankLength * 0.5;
    const deckMaxX = lastCenterX + plankLength * 0.5;
    dockWalkZones.push({
      x: anchor.x,
      z: anchor.z,
      yaw,
      minForward: Math.min(startX, deckMinX) - 3.2,
      maxForward: Math.max(endX, deckMaxX) + 3.2,
      halfWidth: plankWidth * 0.5 + 1.8,
      floorY: anchor.y + 0.13
    });
  }

  scene.add(dock);
}

function addLighthouseIsland() {
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(12.5, 14.5, 3.0, 36),
    new THREE.MeshStandardMaterial({ color: 0x8b6a4c, roughness: 0.95 })
  );
  base.position.set(LIGHTHOUSE_POS.x, -0.4, LIGHTHOUSE_POS.z);
  base.receiveShadow = true;
  scene.add(base);

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(10.8, 12.3, 1.3, 40),
    new THREE.MeshStandardMaterial({ color: 0x7ea35f, roughness: 0.9 })
  );
  top.position.set(LIGHTHOUSE_POS.x, 1.35, LIGHTHOUSE_POS.z);
  top.receiveShadow = true;
  scene.add(top);

  const lighthouse = new THREE.Group();
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(1.55, 2.0, 12.5, 24),
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.75 })
  );
  tower.position.y = 7.4;
  tower.castShadow = true;
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(1.88, 0.12, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.55 })
  );
  band.rotation.x = Math.PI / 2;
  band.position.y = 8.1;
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(1.95, 2.4, 24),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.55 })
  );
  roof.position.y = 14.7;
  roof.castShadow = true;
  const balcony = new THREE.Mesh(
    new THREE.CylinderGeometry(2.55, 2.55, 0.24, 24),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.72 })
  );
  balcony.position.y = 13.1;
  balcony.receiveShadow = true;
  const rail = new THREE.Mesh(
    new THREE.TorusGeometry(2.45, 0.08, 8, 32),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.72 })
  );
  rail.rotation.x = Math.PI / 2;
  rail.position.y = 13.58;
  lighthouseTopPortal = new THREE.Group();
  const topPortalDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.72, 0.1, 24),
    new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x0284c7,
      emissiveIntensity: 1.15,
      roughness: 0.28,
      metalness: 0.32
    })
  );
  const topPortalRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.08, 12, 28),
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.85,
      roughness: 0.35
    })
  );
  topPortalRing.rotation.x = Math.PI / 2;
  topPortalRing.position.y = 0.06;
  lighthouseTopPortal.position.set(0, 13.23, 0);
  lighthouseTopPortal.add(topPortalDisc, topPortalRing);
  const topPortalLight = new THREE.PointLight(0x67e8f9, 0.75, 8, 2);
  topPortalLight.position.set(0, 13.55, 0);
  lighthouseTopPortal.add(topPortalLight);
  lighthouse.add(tower, band, balcony, rail, roof);
  lighthouse.add(lighthouseTopPortal);
  lighthouse.position.set(LIGHTHOUSE_POS.x, 0, LIGHTHOUSE_POS.z);
  scene.add(lighthouse);
}

function addLighthouseInterior() {
  const interior = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.86, side: THREE.DoubleSide });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.72 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8d5a2b, roughness: 0.82 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xf2c66a, roughness: 0.34, metalness: 0.55 });
  const shellRadius = 11.8;
  const shellHeight = 24.5;
  const floorRadius = 11.2;
  const stairRadius = INTERIOR_STAIR_RADIUS;
  const stairSteps = INTERIOR_STAIR_STEPS;
  const stairRise = INTERIOR_STAIR_RISE;

  const wall = new THREE.Mesh(new THREE.CylinderGeometry(shellRadius, shellRadius + 0.35, shellHeight, 56, 1, true), shellMat);
  wall.position.set(LIGHTHOUSE_INTERIOR_BASE.x, shellHeight * 0.5 - 0.12, LIGHTHOUSE_INTERIOR_BASE.z);
  wall.receiveShadow = true;
  interior.add(wall);

  const floorBase = new THREE.Mesh(new THREE.CircleGeometry(floorRadius, 56), stoneMat);
  floorBase.rotation.x = -Math.PI / 2;
  floorBase.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.34, LIGHTHOUSE_INTERIOR_BASE.z);
  floorBase.receiveShadow = true;
  interior.add(floorBase);

  const floorRing = new THREE.Mesh(
    new THREE.RingGeometry(3.1, floorRadius - 0.3, 56),
    new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.85 })
  );
  floorRing.rotation.x = -Math.PI / 2;
  floorRing.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.345, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(floorRing);

  const centerWell = new THREE.Mesh(
    new THREE.CylinderGeometry(2.25, 2.4, shellHeight - 2.2, 28),
    new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.82 })
  );
  centerWell.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.35 + (shellHeight - 2.2) * 0.5, LIGHTHOUSE_INTERIOR_BASE.z);
  centerWell.castShadow = true;
  centerWell.receiveShadow = true;
  interior.add(centerWell);
  addWorldCollider(LIGHTHOUSE_INTERIOR_BASE.x, LIGHTHOUSE_INTERIOR_BASE.z, 2.55, 'interior-core');

  const lowerTrim = new THREE.Mesh(new THREE.TorusGeometry(floorRadius - 0.05, 0.12, 8, 64), trimMat);
  lowerTrim.rotation.x = Math.PI / 2;
  lowerTrim.position.set(LIGHTHOUSE_INTERIOR_BASE.x, 1.72, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(lowerTrim);
  const upperTrim = lowerTrim.clone();
  upperTrim.position.y = shellHeight - 0.35;
  interior.add(upperTrim);

  const stairRailMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.78 });
  for (let i = 0; i < stairSteps; i += 1) {
    const angle = i * INTERIOR_STAIR_ANGLE_STEP;
    const step = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.14, 1.55), woodMat);
    step.position.set(
      LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(angle) * stairRadius,
      INTERIOR_STAIR_START_Y + i * stairRise,
      LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(angle) * stairRadius
    );
    step.rotation.y = -angle;
    step.castShadow = true;
    step.receiveShadow = true;
    interior.add(step);

    if (i < stairSteps - 1) {
      const nextAngle = (i + 1) * INTERIOR_STAIR_ANGLE_STEP;
      const nextX = LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(nextAngle) * stairRadius;
      const nextZ = LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(nextAngle) * stairRadius;
      const nextY = INTERIOR_STAIR_START_Y + (i + 1) * stairRise;
      const midX = (step.position.x + nextX) * 0.5;
      const midZ = (step.position.z + nextZ) * 0.5;
      const midY = (step.position.y + nextY) * 0.5 - 0.01;
      const run = Math.hypot(nextX - step.position.x, nextZ - step.position.z);
      const bridge = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, stairRise + 0.08, run + 0.62),
        new THREE.MeshStandardMaterial({ color: 0x8a572a, roughness: 0.82 })
      );
      bridge.position.set(midX, midY, midZ);
      bridge.rotation.y = -((angle + nextAngle) * 0.5);
      bridge.castShadow = true;
      bridge.receiveShadow = true;
      interior.add(bridge);
    }

    if (i % 2 === 0) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.72, 8), stairRailMat);
      post.position.set(
        LIGHTHOUSE_INTERIOR_BASE.x + Math.cos(angle) * (stairRadius + 1.52),
        step.position.y + 0.38,
        LIGHTHOUSE_INTERIOR_BASE.z + Math.sin(angle) * (stairRadius + 1.52)
      );
      post.castShadow = true;
      interior.add(post);
    }
  }

  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), trimMat);
    post.position.set(
      INTERIOR_TOP_POS.x + Math.cos(a) * 3.45,
      INTERIOR_TOP_POS.y + 0.18,
      INTERIOR_TOP_POS.z + Math.sin(a) * 3.45
    );
    post.castShadow = true;
    interior.add(post);
  }
  const topRail = new THREE.Mesh(new THREE.TorusGeometry(3.45, 0.08, 10, 40), trimMat);
  topRail.rotation.x = Math.PI / 2;
  topRail.position.set(INTERIOR_TOP_POS.x, INTERIOR_TOP_POS.y + 0.72, INTERIOR_TOP_POS.z);
  interior.add(topRail);

  const topPlatform = new THREE.Mesh(
    new THREE.CircleGeometry(3.35, 36),
    new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.76 })
  );
  topPlatform.rotation.x = -Math.PI / 2;
  topPlatform.position.set(INTERIOR_TOP_POS.x, INTERIOR_TOP_POS.y + 0.1, INTERIOR_TOP_POS.z);
  interior.add(topPlatform);

  const upperDeck = new THREE.Mesh(
    new THREE.RingGeometry(5.0, floorRadius - 0.25, 48),
    new THREE.MeshStandardMaterial({ color: 0x7c4f2d, roughness: 0.84 })
  );
  upperDeck.rotation.x = -Math.PI / 2;
  upperDeck.position.set(LIGHTHOUSE_INTERIOR_BASE.x, INTERIOR_TOP_POS.y - 0.42, LIGHTHOUSE_INTERIOR_BASE.z);
  upperDeck.receiveShadow = true;
  interior.add(upperDeck);

  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(shellRadius - 0.2, 56),
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.8 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(LIGHTHOUSE_INTERIOR_BASE.x, shellHeight - 0.22, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(ceiling);

  const entryFrame = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.1, 10, 30),
    new THREE.MeshStandardMaterial({ color: 0x60a5fa, emissive: 0x1d4ed8, emissiveIntensity: 0.5 })
  );
  entryFrame.rotation.x = Math.PI / 2;
  entryFrame.position.set(INTERIOR_ENTRY_POS.x, 1.45, INTERIOR_ENTRY_POS.z);
  interior.add(entryFrame);

  const mapTable = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.96, 0.72, 20), woodMat);
  mapTable.position.set(LIGHTHOUSE_INTERIOR_BASE.x - 4.25, 1.72, LIGHTHOUSE_INTERIOR_BASE.z - 3.4);
  mapTable.castShadow = true;
  mapTable.receiveShadow = true;
  interior.add(mapTable);
  const mapTop = new THREE.Mesh(
    new THREE.CircleGeometry(0.82, 20),
    new THREE.MeshStandardMaterial({ color: 0xf3ecd2, roughness: 0.96 })
  );
  mapTop.rotation.x = -Math.PI / 2;
  mapTop.position.set(mapTable.position.x, 2.09, mapTable.position.z);
  interior.add(mapTop);

  const lantern = new THREE.PointLight(0xffe8ad, 1.65, 42, 2);
  lantern.position.set(LIGHTHOUSE_INTERIOR_BASE.x, shellHeight - 2.1, LIGHTHOUSE_INTERIOR_BASE.z);
  interior.add(lantern);

  lighthouseInteriorPortal = new THREE.Group();
  const portalDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.12, 1.12, 0.16, 28),
    new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x0ea5e9,
      emissiveIntensity: 1.55,
      roughness: 0.24,
      metalness: 0.36
    })
  );
  const portalRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.38, 0.12, 12, 32),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 1.2 })
  );
  portalRing.rotation.x = Math.PI / 2;
  portalRing.position.y = 0.06;
  const portalCap = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), brassMat);
  portalCap.position.y = 0.36;
  const portalBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.44, 2.25, 18, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.42, side: THREE.DoubleSide })
  );
  portalBeam.position.y = 1.1;
  lighthouseInteriorPortal.add(portalDisc, portalRing, portalCap, portalBeam);
  lighthouseInteriorPortal.position.set(INTERIOR_EXIT_PORTAL_POS.x, INTERIOR_EXIT_PORTAL_POS.y, INTERIOR_EXIT_PORTAL_POS.z);
  const portalGlow = new THREE.PointLight(0x7dd3fc, 1.25, 12, 2);
  portalGlow.position.y = 0.7;
  lighthouseInteriorPortal.add(portalGlow);
  interior.add(lighthouseInteriorPortal);

  interior.visible = false;
  lighthouseInteriorGroup = interior;
  scene.add(interior);
}

function addBoat() {
  const boat = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.86 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.9 });
  const hullCore = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.72, 3.35, 14, 1), hullMat);
  hullCore.rotation.x = Math.PI / 2;
  hullCore.position.y = 0.25;
  hullCore.scale.set(1, 0.55, 1);
  hullCore.castShadow = true;
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.64, 0.88, 14), hullMat);
  bow.rotation.x = Math.PI / 2;
  bow.position.set(0, 0.24, 1.92);
  bow.castShadow = true;
  const stern = new THREE.Mesh(new THREE.ConeGeometry(0.6, 0.72, 14), hullMat);
  stern.rotation.x = -Math.PI / 2;
  stern.position.set(0, 0.24, -1.88);
  stern.castShadow = true;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.1, 2.28), new THREE.MeshStandardMaterial({ color: 0xbf7a31, roughness: 0.78 }));
  deck.position.y = 0.56;
  deck.castShadow = true;
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.16, 0.54), trimMat);
  bench.position.set(0, 0.72, -0.2);
  bench.castShadow = true;
  const gunwaleL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 3.2), trimMat);
  gunwaleL.position.set(-0.67, 0.52, 0);
  const gunwaleR = gunwaleL.clone();
  gunwaleR.position.x = 0.67;
  const sideFillFL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.26, 0.66), trimMat);
  sideFillFL.position.set(-0.56, 0.24, 1.34);
  const sideFillFR = sideFillFL.clone();
  sideFillFR.position.x = 0.56;
  const sideFillBL = sideFillFL.clone();
  sideFillBL.position.set(-0.56, 0.24, -1.34);
  const sideFillBR = sideFillBL.clone();
  sideFillBR.position.x = 0.56;
  const centerFill = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.18, 2.78), new THREE.MeshStandardMaterial({ color: 0xa1622b, roughness: 0.82 }));
  centerFill.position.y = 0.43;
  boat.add(hullCore, bow, stern, centerFill, deck, bench, gunwaleL, gunwaleR, sideFillFL, sideFillFR, sideFillBL, sideFillBR);

  const paddleMaterial = new THREE.MeshStandardMaterial({ color: 0x6b3d1f, roughness: 0.84 });
  function createPaddle(side = 1) {
    const pivot = new THREE.Group();
    pivot.position.set(0.78 * side, 0.66, -0.08);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.35, 8), paddleMaterial);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = 0.46 * side;
    shaft.castShadow = true;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.24), paddleMaterial);
    blade.position.x = 1.04 * side;
    blade.castShadow = true;
    pivot.add(shaft, blade);
    return pivot;
  }
  const paddleLeftPivot = createPaddle(-1);
  const paddleRightPivot = createPaddle(1);
  boat.add(paddleLeftPivot, paddleRightPivot);
  boat.position.set(boatState.x, boatState.y, boatState.z);
  scene.add(boat);
  boatState.mesh = boat;
  boatState.paddleLeftPivot = paddleLeftPivot;
  boatState.paddleRightPivot = paddleRightPivot;
}

function addDecorBoat(x, z, yaw = 0, scale = 1.9, y = 1.06) {
  const boat = new THREE.Group();
  boat.position.set(x, y, z);
  boat.rotation.y = yaw;
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x744521, roughness: 0.87 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.9 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.3 * scale, 0.82 * scale, 7.4 * scale), hullMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  boat.add(hull);

  const bow = new THREE.Mesh(new THREE.ConeGeometry(1.15 * scale, 2.1 * scale, 14), hullMat);
  bow.rotation.x = Math.PI / 2;
  bow.position.z = 4.15 * scale;
  bow.castShadow = true;
  boat.add(bow);

  const stern = new THREE.Mesh(new THREE.BoxGeometry(2.1 * scale, 0.58 * scale, 1.5 * scale), trimMat);
  stern.position.z = -3.7 * scale;
  stern.position.y = 0.12 * scale;
  stern.castShadow = true;
  boat.add(stern);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * scale, 0.11 * scale, 2.9 * scale, 8), trimMat);
  mast.position.y = 1.95 * scale;
  mast.castShadow = true;
  boat.add(mast);

  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7 * scale, 1.25 * scale),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.85, side: THREE.DoubleSide })
  );
  sail.position.set(0.86 * scale, 2.0 * scale, 0);
  sail.rotation.y = Math.PI / 2;
  boat.add(sail);

  scene.add(boat);
}

function addWoodHouse(x, z, yaw = 0) {
  const house = new THREE.Group();
  house.position.set(x, 1.36, z);
  house.rotation.y = yaw;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x7b4f2d, roughness: 0.88 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x5b3a24, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4e3423, roughness: 0.9 });

  const houseW = 9.4;
  const houseD = 8.0;
  const wallH = 3.2;
  const wallT = 0.22;
  const doorW = 1.9;
  const doorH = 2.45;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(houseW, 0.2, houseD), wallMat);
  floor.position.y = 0.08;
  floor.receiveShadow = true;
  house.add(floor);

  const back = new THREE.Mesh(new THREE.BoxGeometry(houseW, wallH, wallT), wallMat);
  back.position.set(0, wallH * 0.5 + 0.1, -houseD * 0.5 + wallT * 0.5);
  const left = new THREE.Mesh(new THREE.BoxGeometry(wallT, wallH, houseD), wallMat);
  left.position.set(-houseW * 0.5 + wallT * 0.5, wallH * 0.5 + 0.1, 0);
  const right = left.clone();
  right.position.x = houseW * 0.5 - wallT * 0.5;

  const frontSideW = (houseW - doorW) * 0.5;
  const frontLeft = new THREE.Mesh(new THREE.BoxGeometry(frontSideW, wallH, wallT), wallMat);
  frontLeft.position.set(-(doorW * 0.5 + frontSideW * 0.5), wallH * 0.5 + 0.1, houseD * 0.5 - wallT * 0.5);
  const frontRight = frontLeft.clone();
  frontRight.position.x = -frontLeft.position.x;
  const frontTop = new THREE.Mesh(new THREE.BoxGeometry(doorW, wallH - doorH, wallT), wallMat);
  frontTop.position.set(0, doorH + (wallH - doorH) * 0.5 + 0.1, houseD * 0.5 - wallT * 0.5);

  house.add(back, left, right, frontLeft, frontRight, frontTop);

  const frameTop = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.24, 0.12, 0.12), trimMat);
  frameTop.position.set(0, doorH + 0.16, houseD * 0.5 + 0.02);
  const frameLeft = new THREE.Mesh(new THREE.BoxGeometry(0.1, doorH, 0.12), trimMat);
  frameLeft.position.set(-doorW * 0.5 - 0.06, doorH * 0.5 + 0.1, houseD * 0.5 + 0.02);
  const frameRight = frameLeft.clone();
  frameRight.position.x = doorW * 0.5 + 0.06;
  house.add(frameTop, frameLeft, frameRight);

  const eave = new THREE.Mesh(
    new THREE.BoxGeometry(houseW + 0.12, 0.12, houseD + 0.12),
    trimMat
  );
  eave.position.set(0, wallH + 0.12, 0);
  eave.castShadow = true;
  eave.receiveShadow = true;

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(houseW, houseD) * 0.68, 2.45, 4),
    roofMat
  );
  roof.position.set(0, wallH + 1.34, 0);
  roof.rotation.y = Math.PI * 0.25;
  roof.castShadow = true;
  roof.receiveShadow = true;

  const roofPeak = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.14, 0.46, 8),
    trimMat
  );
  roofPeak.position.set(0, wallH + 2.74, 0);
  roofPeak.castShadow = true;
  roofPeak.receiveShadow = true;

  house.add(eave, roof, roofPeak);

  house.children.forEach((m) => {
    m.castShadow = true;
    m.receiveShadow = true;
  });
  scene.add(house);
  // Use the actual wall meshes for collision so blocking matches visible walls.
  addWallCollisionFromMesh(back, 'house');
  addWallCollisionFromMesh(left, 'house');
  addWallCollisionFromMesh(right, 'house');
  addWallCollisionFromMesh(frontLeft, 'house');
  addWallCollisionFromMesh(frontRight, 'house');
  addWallCollisionFromMesh(frontTop, 'house');
}

function addCliffAndWaterfall(x, z) {
  const cliff = new THREE.Group();
  cliff.position.set(x, 0, z);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x586069, roughness: 0.93 });
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x5f6872, roughness: 0.9 });
  const mainRock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(4.8, 0),
    rockMat
  );
  mainRock.position.set(0, 3.6, 0);
  mainRock.scale.set(2.6, 1.7, 2.0);
  mainRock.castShadow = true;
  mainRock.receiveShadow = true;
  cliff.add(mainRock);

  for (let i = 0; i < 11; i += 1) {
    let rx = (Math.random() - 0.5) * 7.6;
    let rz = (Math.random() - 0.5) * 3.7;
    // Keep front faces clearer so waterfall stays visible.
    if ((rx < 0 && rz < 1.2) || (rz > 0.1 && Math.abs(rx) < 2.2)) {
      rx += 1.8;
      rz -= 1.2;
    }
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(3.1 + Math.random() * 1.8, 0),
      rockMat
    );
    rock.position.set(rx, 2.25 + Math.random() * 2.1, rz);
    rock.scale.set(2.55, 1.45 + Math.random() * 0.95, 2.0);
    rock.castShadow = true;
    rock.receiveShadow = true;
    cliff.add(rock);
  }

  const makeWaterfallFace = (localX, localY, localZ, yaw, w = 3.4, h = 8.6) => {
    const normalX = Math.sin(yaw);
    const normalZ = Math.cos(yaw);
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.65, h + 0.9, 0.7),
      faceMat
    );
    face.position.set(localX, localY, localZ);
    face.rotation.y = yaw;
    face.castShadow = true;
    face.receiveShadow = true;
    cliff.add(face);

    const stream = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.92),
      new THREE.MeshBasicMaterial({
        color: 0x2ea9ff,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false
      })
    );
    // Slight outward offset; thickness keeps it visible from both camera sides.
    stream.position.set(
      localX + normalX * 0.16,
      localY - 0.12,
      localZ + normalZ * 0.16
    );
    stream.rotation.y = yaw;
    stream.renderOrder = 20;
    cliff.add(stream);

    const streakMat = new THREE.MeshBasicMaterial({
      color: 0xeaf7ff,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false
    });
    for (let i = 0; i < 11; i += 1) {
      const streak = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 2.0 + Math.random() * 0.9), streakMat);
      streak.position.set(
        (Math.random() - 0.5) * (w - 0.6),
        (Math.random() - 0.5) * (h - 0.8),
        0.02
      );
      stream.add(streak);
    }

    const foam = new THREE.Mesh(
      new THREE.CircleGeometry(1.35, 18),
      new THREE.MeshBasicMaterial({
        color: 0xe8f7ff,
        transparent: true,
        opacity: 0.74,
        depthTest: true,
        depthWrite: false
      })
    );
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(
      localX + normalX * 0.42,
      0.1,
      localZ + normalZ * 0.42
    );
    foam.renderOrder = 21;
    cliff.add(foam);
  };

  // Two visible faces so at least one waterfall is always seen from common camera angles.
  makeWaterfallFace(-2.25, 4.4, -1.25, Math.PI * 0.12, 3.8, 9.2);
  makeWaterfallFace(2.0, 4.2, 1.05, -Math.PI * 0.85, 2.8, 7.1);

  scene.add(cliff);
  addWorldCollider(x, z, 3.35, 'cliff');
}

function populateMainIslandNature() {
  const palmSpots = [
    [worldLimit * 0.62, worldLimit * 0.2, 1.06],
    [worldLimit * 0.34, -worldLimit * 0.42, 0.96],
    [-worldLimit * 0.72, worldLimit * 0.3, 1.1],
    [-worldLimit * 0.16, -worldLimit * 0.56, 0.92],
    [worldLimit * 0.04, worldLimit * 0.61, 0.87]
  ];
  palmSpots.forEach(([x, z, s]) => addPalm(x, z, s));
  addBush(worldLimit * 0.44, worldLimit * 0.28, 0.74);
  addBush(-worldLimit * 0.26, worldLimit * 0.44, 0.72);
  addBush(worldLimit * 0.14, -worldLimit * 0.36, 0.7);

  for (let i = 0; i < 120; i += 1) {
    const angle = (i / 120) * Math.PI * 2;
    const radius = worldLimit * (0.1 + Math.random() * 0.78);
    const x = Math.cos(angle) * radius + (Math.random() - 0.5) * 2.8;
    const z = Math.sin(angle) * radius + (Math.random() - 0.5) * 2.8;
    addGrassTuft(x, z, 0.8 + Math.random() * 0.45, i % 3 ? 0x4f8a3f : 0x568f45);
  }
  addFlowerPatch(worldLimit * 0.22, worldLimit * 0.38, 18, 5.6);
  addFlowerPatch(-worldLimit * 0.33, worldLimit * 0.12, 16, 5.1);
  addFlowerPatch(worldLimit * 0.46, -worldLimit * 0.22, 14, 4.9);
  addFlowerPatch(-worldLimit * 0.12, -worldLimit * 0.46, 13, 4.6);
}

function addLandmarks() {
  addDock(ISLAND_DOCK_POS, ISLAND_DOCK_YAW, { segments: 17, plankLength: 3.2, plankWidth: 3.2, spacing: 1.2 });
  addLighthouseIsland();
  addDock(LIGHTHOUSE_DOCK_POS, LIGHTHOUSE_DOCK_YAW, { segments: 12, plankLength: 2.8, plankWidth: 2.2, spacing: 1.1 });
  addLighthouseInterior();
  populateMainIslandNature();
  addWoodHouse(-worldLimit * 0.33, worldLimit * 0.12, 0);
  const cliffAngle = Math.atan2(-ISLAND_DOCK_POS.z, -ISLAND_DOCK_POS.x);
  addCliffAndWaterfall(Math.cos(cliffAngle) * worldLimit * 0.7, Math.sin(cliffAngle) * worldLimit * 0.7);
  const decorPos = findWaterSideSlot(ISLAND_DOCK_POS, ISLAND_DOCK_YAW, -1, 6.0, 3.2);
  addDecorBoat(
    decorPos.x,
    decorPos.z,
    ISLAND_DOCK_YAW - Math.PI * 0.18,
    0.58,
    1.08
  );
  addBoat();
}

addLandmarks();

const teleportOverlay = document.createElement('div');
teleportOverlay.style.position = 'fixed';
teleportOverlay.style.inset = '0';
teleportOverlay.style.background = 'radial-gradient(circle at 50% 42%, rgba(56, 189, 248, 0.28) 0%, rgba(2, 8, 20, 0.94) 70%)';
teleportOverlay.style.pointerEvents = 'none';
teleportOverlay.style.opacity = '0';
teleportOverlay.style.transition = 'opacity 240ms ease';
teleportOverlay.style.zIndex = '60';
teleportOverlay.style.display = 'flex';
teleportOverlay.style.alignItems = 'center';
teleportOverlay.style.justifyContent = 'center';
document.body.appendChild(teleportOverlay);

const teleportCard = document.createElement('div');
teleportCard.style.minWidth = '300px';
teleportCard.style.maxWidth = 'min(84vw, 460px)';
teleportCard.style.border = '1px solid rgba(148, 163, 184, 0.38)';
teleportCard.style.borderRadius = '16px';
teleportCard.style.background = 'linear-gradient(140deg, rgba(15,23,42,0.95), rgba(30,41,59,0.92))';
teleportCard.style.padding = '18px 20px 16px';
teleportCard.style.boxShadow = '0 26px 60px rgba(2, 6, 23, 0.5)';
teleportCard.style.opacity = '0';
teleportCard.style.transform = 'translateY(14px) scale(0.96)';
teleportCard.style.transition = 'opacity 220ms ease, transform 220ms ease';
teleportCard.style.backdropFilter = 'blur(8px)';
teleportOverlay.appendChild(teleportCard);

const teleportTitle = document.createElement('div');
teleportTitle.style.color = '#f8fafc';
teleportTitle.style.fontSize = '26px';
teleportTitle.style.fontWeight = '800';
teleportTitle.style.letterSpacing = '0.02em';
teleportCard.appendChild(teleportTitle);

const teleportSubtitle = document.createElement('div');
teleportSubtitle.style.color = 'rgba(191, 219, 254, 0.94)';
teleportSubtitle.style.fontSize = '14px';
teleportSubtitle.style.marginTop = '6px';
teleportSubtitle.style.letterSpacing = '0.02em';
teleportCard.appendChild(teleportSubtitle);

const teleportSweep = document.createElement('div');
teleportSweep.style.height = '3px';
teleportSweep.style.width = '100%';
teleportSweep.style.marginTop = '14px';
teleportSweep.style.borderRadius = '99px';
teleportSweep.style.background = 'linear-gradient(90deg, transparent 0%, rgba(125,211,252,0.95) 45%, transparent 100%)';
teleportSweep.style.backgroundSize = '220% 100%';
teleportSweep.style.animation = 'teleportSweep 720ms linear infinite';
teleportCard.appendChild(teleportSweep);

const teleportStyleEl = document.createElement('style');
teleportStyleEl.textContent = '@keyframes teleportSweep{0%{background-position:130% 0}100%{background-position:-130% 0}}';
document.head.appendChild(teleportStyleEl);

function setTeleportTheme(type) {
  if (type === 'enter-lighthouse') {
    teleportOverlay.style.background = 'radial-gradient(circle at 50% 35%, rgba(125, 211, 252, 0.34) 0%, rgba(2, 8, 20, 0.95) 70%)';
    teleportTitle.textContent = 'Entering Lighthouse';
    teleportSubtitle.textContent = 'Stepping through the doorway...';
    teleportSweep.style.filter = 'hue-rotate(0deg)';
    return;
  }
  if (type === 'exit-lighthouse') {
    teleportOverlay.style.background = 'radial-gradient(circle at 50% 35%, rgba(250, 204, 21, 0.26) 0%, rgba(2, 8, 20, 0.95) 74%)';
    teleportTitle.textContent = 'Climbing To Lantern Deck';
    teleportSubtitle.textContent = 'Wind and ocean coming into view...';
    teleportSweep.style.filter = 'hue-rotate(58deg)';
    return;
  }
  teleportOverlay.style.background = 'radial-gradient(circle at 50% 42%, rgba(56, 189, 248, 0.28) 0%, rgba(2, 8, 20, 0.94) 70%)';
  teleportTitle.textContent = 'Teleporting';
  teleportSubtitle.textContent = 'Please wait...';
  teleportSweep.style.filter = 'hue-rotate(0deg)';
}

function runTeleportTransition(type, callback) {
  if (isTeleporting) return;
  isTeleporting = true;
  setTeleportTheme(type);
  renderer.domElement.style.transition = 'filter 240ms ease, transform 240ms ease';
  renderer.domElement.style.filter = 'blur(2px) saturate(1.15) brightness(1.08)';
  renderer.domElement.style.transform = type === 'exit-lighthouse' ? 'scale(0.985)' : 'scale(1.02)';
  teleportOverlay.style.opacity = '1';
  teleportCard.style.opacity = '1';
  teleportCard.style.transform = 'translateY(0) scale(1)';
  window.setTimeout(() => {
    callback();
    teleportSubtitle.textContent = type === 'exit-lighthouse' ? 'You made it to the top.' : 'Welcome inside.';
    teleportOverlay.style.opacity = '0';
    teleportCard.style.opacity = '0';
    teleportCard.style.transform = 'translateY(16px) scale(0.95)';
    renderer.domElement.style.filter = 'none';
    renderer.domElement.style.transform = 'scale(1)';
    window.setTimeout(() => {
      isTeleporting = false;
    }, 240);
  }, 280);
}

function resolveBoatShoreCollision(x, z) {
  let nextX = x;
  let nextZ = z;
  let collided = false;
  const circles = [
    { cx: 0, cz: 0, radius: BOAT_CLEARANCE_MAIN },
    { cx: LIGHTHOUSE_POS.x, cz: LIGHTHOUSE_POS.z, radius: BOAT_CLEARANCE_LIGHTHOUSE }
  ];
  for (const circle of circles) {
    const dx = nextX - circle.cx;
    const dz = nextZ - circle.cz;
    const dist = Math.hypot(dx, dz);
    if (dist < circle.radius) {
      const safe = circle.radius / (dist || 1);
      nextX = circle.cx + dx * safe;
      nextZ = circle.cz + dz * safe;
      collided = true;
    }
  }
  return { x: nextX, z: nextZ, collided };
}

const beaconGroup = new THREE.Group();
const beaconPedestal = new THREE.Mesh(
  new THREE.CylinderGeometry(1.15, 1.35, 1.0, 18),
  new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.7 })
);
beaconPedestal.position.y = 1.85;
beaconPedestal.castShadow = true;
beaconPedestal.receiveShadow = true;

const beaconCore = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.9, 0),
  new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x0c4a6e,
    emissiveIntensity: 0.4,
    roughness: 0.15,
    metalness: 0.25
  })
);
beaconCore.position.y = 3.0;
beaconCore.castShadow = true;

beaconGroup.add(beaconPedestal);
beaconGroup.add(beaconCore);
scene.add(beaconGroup);

const rainCount = 700;
const rainPositions = new Float32Array(rainCount * 3);
for (let i = 0; i < rainCount; i += 1) {
  const idx = i * 3;
  rainPositions[idx] = (Math.random() - 0.5) * 180;
  rainPositions[idx + 1] = Math.random() * 35 + 4;
  rainPositions[idx + 2] = (Math.random() - 0.5) * 180;
}
const rainGeometry = new THREE.BufferGeometry();
rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
const rain = new THREE.Points(
  rainGeometry,
  new THREE.PointsMaterial({ color: 0xb9e6ff, size: 0.14, transparent: true, opacity: 0.65 })
);
rain.visible = false;
scene.add(rain);

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

function normalizeAppearance(value, fallback = defaultAppearance()) {
  const source = value && typeof value === 'object' ? value : {};
  const hairStyle = ['none', 'short', 'sidepart', 'spiky', 'long', 'ponytail', 'bob', 'wavy'].includes(source.hairStyle)
    ? source.hairStyle
    : fallback.hairStyle;
  const faceStyle = ['smile', 'serious', 'grin', 'wink', 'lashessmile', 'soft'].includes(source.faceStyle)
    ? source.faceStyle
    : fallback.faceStyle;
  const accessories = Array.isArray(source.accessories)
    ? source.accessories.filter((item) => ['hat', 'glasses', 'backpack'].includes(item))
    : Array.isArray(fallback.accessories)
      ? fallback.accessories.filter((item) => ['hat', 'glasses', 'backpack'].includes(item))
      : [];
  const toColor = (input, base) => (/^#[0-9a-fA-F]{6}$/.test(input || '') ? input : base);

  return {
    skin: toColor(source.skin, fallback.skin),
    shirt: toColor(source.shirt ?? source.color, fallback.shirt),
    pants: toColor(source.pants, fallback.pants),
    shoes: toColor(source.shoes, fallback.shoes),
    hairStyle,
    hairColor: toColor(source.hairColor, fallback.hairColor),
    faceStyle,
    accessories: [...new Set(accessories)]
  };
}

function clampToIsland(x, z, limit) {
  const radius = Math.hypot(x, z);
  if (radius <= limit) return { x, z };
  const scale = limit / (radius || 1);
  return { x: x * scale, z: z * scale };
}

function clampToRing(x, z, minRadius, maxRadius) {
  const radius = Math.hypot(x, z) || 1;
  if (radius >= minRadius && radius <= maxRadius) return { x, z };
  const targetRadius = radius < minRadius ? minRadius : maxRadius;
  const scale = targetRadius / radius;
  return { x: x * scale, z: z * scale };
}

function isSwimZone(x, z) {
  const radius = Math.hypot(x, z);
  return radius >= SWIM_MIN_RADIUS && radius <= SWIM_MAX_RADIUS;
}

function sampleInteriorStairHeight(x, z, currentY) {
  if (!inLighthouseInterior) return null;
  const dx = x - LIGHTHOUSE_INTERIOR_BASE.x;
  const dz = z - LIGHTHOUSE_INTERIOR_BASE.z;
  const radius = Math.hypot(dx, dz);
  if (radius <= 4.6 && currentY >= INTERIOR_TOP_POS.y - 3.0) {
    return INTERIOR_TOP_POS.y + 0.1;
  }
  if (radius >= 5.0 && radius <= INTERIOR_PLAY_RADIUS - 0.2 && currentY >= INTERIOR_TOP_POS.y - 2.2) {
    return INTERIOR_TOP_POS.y - 0.42;
  }
  if (radius < INTERIOR_STAIR_RADIUS - 1.15 || radius > INTERIOR_STAIR_RADIUS + 1.9) return null;

  let angle = Math.atan2(dz, dx);
  if (angle < 0) angle += Math.PI * 2;
  const risePerRadian = INTERIOR_STAIR_RISE / INTERIOR_STAIR_ANGLE_STEP;
  const startY = INTERIOR_STAIR_START_Y;
  const maxAngle = (INTERIOR_STAIR_STEPS - 1) * INTERIOR_STAIR_ANGLE_STEP;
  let bestY = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let turns = 0; turns <= 5; turns += 1) {
    const spiralAngle = angle + turns * Math.PI * 2;
    if (spiralAngle < 0 || spiralAngle > maxAngle + 0.5) continue;
    const y = startY + spiralAngle * risePerRadian + 0.07;
    const dist = Math.abs(y - currentY);
    if (dist < bestDist) {
      bestDist = dist;
      bestY = y;
    }
  }
  if (!Number.isFinite(bestY)) return null;
  return THREE.MathUtils.clamp(bestY, GROUND_Y, INTERIOR_TOP_POS.y + 0.12);
}

function clampToPlayableGround(x, z) {
  const MAIN_RADIUS = worldLimit * 1.14;
  const LIGHTHOUSE_RADIUS = 10.9;
  const INTERIOR_RADIUS = INTERIOR_PLAY_RADIUS;
  const inSwim = isSwimZone(x, z);

  const inMain = Math.hypot(x, z) <= MAIN_RADIUS;
  const dxL = x - LIGHTHOUSE_POS.x;
  const dzL = z - LIGHTHOUSE_POS.z;
  const inLighthouse = Math.hypot(dxL, dzL) <= LIGHTHOUSE_RADIUS;
  const dxI = x - LIGHTHOUSE_INTERIOR_BASE.x;
  const dzI = z - LIGHTHOUSE_INTERIOR_BASE.z;
  const inInterior = Math.hypot(dxI, dzI) <= INTERIOR_RADIUS;
  if (inMain || inLighthouse || inInterior || inSwim) {
    return { x, z };
  }

  const toMain = clampToIsland(x, z, MAIN_RADIUS);
  const distMain = Math.hypot(x - toMain.x, z - toMain.z);
  const lenL = Math.hypot(dxL, dzL) || 1;
  const toLight = {
    x: LIGHTHOUSE_POS.x + (dxL / lenL) * LIGHTHOUSE_RADIUS,
    z: LIGHTHOUSE_POS.z + (dzL / lenL) * LIGHTHOUSE_RADIUS
  };
  const distLight = Math.hypot(x - toLight.x, z - toLight.z);
  const lenI = Math.hypot(dxI, dzI) || 1;
  const toInterior = {
    x: LIGHTHOUSE_INTERIOR_BASE.x + (dxI / lenI) * INTERIOR_RADIUS,
    z: LIGHTHOUSE_INTERIOR_BASE.z + (dzI / lenI) * INTERIOR_RADIUS
  };
  const distInterior = Math.hypot(x - toInterior.x, z - toInterior.z);
  const toSwim = clampToRing(x, z, SWIM_MIN_RADIUS, SWIM_MAX_RADIUS);
  const distSwim = Math.hypot(x - toSwim.x, z - toSwim.z);
  if (distMain <= distLight && distMain <= distInterior && distMain <= distSwim) return toMain;
  if (distLight <= distInterior && distLight <= distSwim) return toLight;
  if (distInterior <= distSwim) return toInterior;
  return toSwim;
}

function isWaterAt(x, z) {
  const radius = Math.hypot(x, z);
  if (radius > SWIM_MAX_RADIUS) return false;

  // Brute-force dock safety: never treat areas around docks as water.
  if (Math.hypot(x - ISLAND_DOCK_POS.x, z - ISLAND_DOCK_POS.z) <= 16) return false;
  if (Math.hypot(x - LIGHTHOUSE_DOCK_POS.x, z - LIGHTHOUSE_DOCK_POS.z) <= 14) return false;

  // Hard land-safe radius for the main island footprint.
  if (radius <= worldLimit + 8.4) return false;

  const angle = Math.atan2(z, x);
  // Keep all shoreline blends (sand + hand-shaped beach edits) walkable.
  // Ocean should only start clearly beyond the island rim.
  const shorelineRadius = mainIslandRadiusAtAngle(angle) + 7.4;
  const onMainIslandLand = radius <= shorelineRadius;
  if (onMainIslandLand) return false;

  // The dock-side beach uses custom blended geometry that can extend beyond radialShape.
  // Keep that blended shoreline region dry so players walk there instead of swimming.
  const dockRadius = Math.hypot(ISLAND_DOCK_POS.x, ISLAND_DOCK_POS.z);
  const nearMainDockBeach = distance2D({ x, z }, ISLAND_DOCK_POS) < 11.4 && radius <= dockRadius + 3.2;
  if (nearMainDockBeach) return false;

  const dxL = x - LIGHTHOUSE_POS.x;
  const dzL = z - LIGHTHOUSE_POS.z;
  const onLighthouseIslandLand = Math.hypot(dxL, dzL) <= 15.4;
  if (onLighthouseIslandLand) return false;

  if (isInDockWalkZone(x, z, 3.0, 2.5)) return false;

  return true;
}

function isInDockWalkZone(x, z, forwardPad = 0, sidePad = 0) {
  for (const zone of dockWalkZones) {
    const dx = x - zone.x;
    const dz = z - zone.z;
    const fX = Math.sin(zone.yaw);
    const fZ = Math.cos(zone.yaw);
    const rX = Math.cos(zone.yaw);
    const rZ = -Math.sin(zone.yaw);
    const forward = dx * fX + dz * fZ;
    const side = dx * rX + dz * rZ;
    if (
      forward >= zone.minForward - forwardPad &&
      forward <= zone.maxForward + forwardPad &&
      Math.abs(side) <= zone.halfWidth + sidePad
    ) {
      return true;
    }
  }
  return false;
}

function dockFloorHeightAt(x, z, forwardPad = 0, sidePad = 0) {
  let best = null;
  for (const zone of dockWalkZones) {
    const dx = x - zone.x;
    const dz = z - zone.z;
    const fX = Math.sin(zone.yaw);
    const fZ = Math.cos(zone.yaw);
    const rX = Math.cos(zone.yaw);
    const rZ = -Math.sin(zone.yaw);
    const forward = dx * fX + dz * fZ;
    const side = dx * rX + dz * rZ;
    if (
      forward >= zone.minForward - forwardPad &&
      forward <= zone.maxForward + forwardPad &&
      Math.abs(side) <= zone.halfWidth + sidePad
    ) {
      const y = Number.isFinite(zone.floorY) ? zone.floorY : GROUND_Y;
      if (best === null || y > best) best = y;
    }
  }
  return best;
}

function groundHeightAt(x, z, currentY) {
  const stairY = sampleInteriorStairHeight(x, z, currentY);
  if (Number.isFinite(stairY)) return stairY;
  const dockY = dockFloorHeightAt(x, z, 2.2, 2.2);
  if (Number.isFinite(dockY)) return dockY;
  return GROUND_Y;
}

function shouldSwimAt(x, z, y) {
  return isWaterAt(x, z) && y <= GROUND_Y + 0.16 && !inLighthouseInterior;
}

function swimAnimationLevel(nowMs) {
  return SWIM_SURFACE_Y + Math.sin(nowMs * 0.0042) * 0.06;
}

function getSwimVerticalIntent() {
  const up = keys.has(' ') || keys.has('space') || keys.has('w') || keys.has('arrowup');
  const down = keys.has('c') || keys.has('control') || keys.has('s') || keys.has('arrowdown');
  if (up && !down) return 1;
  if (down && !up) return -1;
  return 0;
}

function applySwimVertical(local, delta, nowMs) {
  const bobBase = swimAnimationLevel(nowMs);
  const upHeld = keys.has(' ') || keys.has('space') || keys.has('w') || keys.has('arrowup');
  const downHeld = keys.has('c') || keys.has('control') || keys.has('s') || keys.has('arrowdown');
  const verticalSwimSpeed = 2.8;

  if (upHeld && !downHeld) {
    local.y += verticalSwimSpeed * delta;
  } else if (downHeld && !upHeld) {
    local.y -= verticalSwimSpeed * delta;
  } else {
    // Gentle return toward the surface when no vertical input is held.
    local.y += (bobBase - local.y) * Math.min(1, delta * 1.3);
  }

  local.y = THREE.MathUtils.clamp(local.y, SWIM_SINK_Y, SWIM_SURFACE_Y + 0.6);
  local.vy = 0;
}

function applyGroundVertical(local, delta, floorY) {
  if (pendingJump && local.y <= floorY + 0.05) {
    local.vy = JUMP_VELOCITY;
  }
  pendingJump = false;

  local.vy -= GRAVITY * delta;
  local.y += local.vy * delta;
  if (local.y <= floorY) {
    local.y = floorY;
    local.vy = 0;
  }
}

function swimMoveFactor() {
  return 0.68;
}

function canUseSlideAndSprint(local) {
  return !local.isSwimming;
}

function preserveLocalInWater(local, prevY) {
  if (local.isSwimming && local.y > SWIM_SURFACE_Y + 0.6) {
    local.y = Math.max(prevY, SWIM_SURFACE_Y + 0.2);
  }
}

function computeRemoteSwimState(player) {
  const remoteDockY = dockFloorHeightAt(player.mesh.position.x, player.mesh.position.z, 2.2, 2.2);
  if (Number.isFinite(remoteDockY)) {
    player.isSwimming = false;
    if (player.mesh.position.y < remoteDockY) player.mesh.position.y = remoteDockY;
    return;
  }
  // If a player is at normal ground height, always treat as walking.
  if (player.mesh.position.y >= GROUND_Y - 0.08) {
    player.isSwimming = false;
    return;
  }
  const inWater = isWaterAt(player.mesh.position.x, player.mesh.position.z);
  if (!inWater) {
    player.isSwimming = false;
    return;
  }
  if (player.isSwimming) {
    player.isSwimming = player.mesh.position.y <= SWIM_SURFACE_Y + 0.82;
    return;
  }
  player.isSwimming = player.mesh.position.y <= SWIM_SURFACE_Y + 0.58;
}

function swimStateFromPosition(player) {
  return Boolean(player) && shouldSwimAt(player.x, player.z, player.y);
}

function applyLocalSurfaceState(local) {
  const localDockY = dockFloorHeightAt(local.x, local.z, 2.2, 2.2);
  if (Number.isFinite(localDockY)) {
    local.isSwimming = false;
    local.swimTargetY = null;
    local.y = localDockY;
    local.vy = 0;
    return;
  }
  // Ground-height safeguard: never swim while standing on sand/land.
  if (local.y >= GROUND_Y - 0.08) {
    local.isSwimming = false;
    local.swimTargetY = null;
    return;
  }
  const inWater = isWaterAt(local.x, local.z) && !inLighthouseInterior && !local.onBoat;
  if (!inWater) {
    local.isSwimming = false;
    local.swimTargetY = null;
    return;
  }
  if (local.isSwimming) {
    local.isSwimming = local.y <= SWIM_SURFACE_Y + 0.78;
    return;
  }
  local.isSwimming = local.y <= GROUND_Y + 0.65;
  if (local.isSwimming) {
    local.swimTargetY = THREE.MathUtils.clamp(local.y, SWIM_SINK_Y, SWIM_SURFACE_Y + 0.35);
  }
}

function surfaceMoveMultiplier(local) {
  return local.isSwimming ? swimMoveFactor() : 1;
}

function floorYForLocal(local) {
  return groundHeightAt(local.x, local.z, local.y);
}

function applyVerticalMovement(local, delta, nowMs) {
  applyLocalSurfaceState(local);
  if (local.isSwimming) {
    applySwimVertical(local, delta, nowMs);
    pendingJump = false;
    return;
  }
  applyGroundVertical(local, delta, floorYForLocal(local));
}

function updateRemoteSurfaceState(player) {
  computeRemoteSwimState(player);
}

function swimSyncRange(x, z) {
  return isWaterAt(x, z);
}

function isServerSyncRange(x, z) {
  return isWithinPlayableWorld(x, z) || swimSyncRange(x, z);
}

function canEnterSwim(local) {
  return !local.onBoat && !inLighthouseInterior;
}

function movementSpeedForState(local) {
  return canUseSlideAndSprint(local) ? WALK_SPEED : WALK_SPEED * swimMoveFactor();
}

function validSwimTransition(local) {
  return canEnterSwim(local) && shouldSwimAt(local.x, local.z, local.y);
}

function applySwimTransition(local) {
  if (validSwimTransition(local)) {
    local.isSwimming = true;
    local.vy = 0;
  }
}

function afterMovementState(local, prevY) {
  applySwimTransition(local);
  preserveLocalInWater(local, prevY);
}

function remoteStatePostMove(player) {
  updateRemoteSurfaceState(player);
}

function interactWhileSwimming(local) {
  return local?.isSwimming;
}

function stopSwimOnTeleport(local) {
  if (local) {
    local.isSwimming = false;
    local.swimTargetY = null;
  }
}

function swimHintText() {
  return 'Swimming: WASD move, Space/W up, C/S down';
}

function canBoardBoat(local) {
  const nearDock = distance2D(local, ISLAND_DOCK_POS) < 5 || distance2D(local, LIGHTHOUSE_DOCK_POS) < 5;
  const nearBoat = Boolean(boatState.mesh) && distance2D(local, boatState) < 5.2;
  if (nearBoat) return true;
  if (interactWhileSwimming(local)) return false;
  return nearDock;
}

function movementClamp(local) {
  const bounded = clampToPlayableGround(local.x, local.z);
  const collided = resolveWorldCollisions(bounded.x, bounded.z, local.y);
  local.x = collided.x;
  local.z = collided.z;
}

function localStepMovementEnd(local, delta, nowMs, prevY) {
  movementClamp(local);
  applyVerticalMovement(local, delta, nowMs);
  afterMovementState(local, prevY);
}

function serverMovementRange(local) {
  return isServerSyncRange(local.x, local.z);
}

function finalizeRemoteMovement(player) {
  remoteStatePostMove(player);
}

function jumpAllowed(local) {
  return !local.isSwimming;
}

function movementScaleForLocal(local) {
  return surfaceMoveMultiplier(local);
}

function shouldSlide(local) {
  return canUseSlideAndSprint(local);
}

function runSlideAllowed(local, isSliding) {
  return isSliding && shouldSlide(local);
}

function sprintAllowed(local) {
  return canUseSlideAndSprint(local);
}

function inSwimSyncRange(local) {
  return serverMovementRange(local);
}

function allowBoatBoard(local) {
  return canBoardBoat(local);
}

function swimBodyTilt(stride) {
  return -0.58 + stride * 0.05;
}

function swimStrokePhase(player) {
  return player.animPhase;
}

function swimLegKick(phase) {
  return Math.sin(phase * 1.8) * 0.36;
}

function swimArmStroke(phase) {
  return Math.sin(phase) * 0.9;
}

function swimBodyRoll(phase) {
  return Math.sin(phase * 0.5) * 0.11;
}

function swimBodyBob(phase, baseY) {
  return baseY - 0.34 + Math.sin(phase * 2) * 0.06;
}

function smoothRotation(obj, x, y, z, delta, speed = 10) {
  if (!obj) return;
  const t = Math.min(1, delta * speed);
  obj.rotation.x += (x - obj.rotation.x) * t;
  obj.rotation.y += (y - obj.rotation.y) * t;
  obj.rotation.z += (z - obj.rotation.z) * t;
}

function inDeepWater(player) {
  return player.isSwimming;
}

function applySwimPose(player, body, parts, baseBodyY, delta) {
  const phase = swimStrokePhase(player);
  const speed = Math.min(1, player.animSpeed + 0.25);
  const strokePhase = phase * 1.45;
  const leftStroke = Math.sin(strokePhase);
  const rightStroke = Math.sin(strokePhase + Math.PI);
  const flutter = Math.sin(strokePhase * 3.2) * (0.14 + speed * 0.12);
  const roll = Math.sin(strokePhase) * 0.05;
  const bodyBob = -0.76 + Math.sin(strokePhase * 2.0) * 0.018;
  body.position.y += (baseBodyY + bodyBob - body.position.y) * Math.min(1, delta * 9.2);
  // True prone belly-down posture, nearly parallel to the water surface.
  smoothRotation(body, 1.48 + Math.sin(strokePhase * 0.5) * 0.015, 0, roll, delta, 12.4);
  // Front crawl: one arm pulls back while the other reaches forward.
  smoothRotation(parts.leftArmPivot, -0.45 + leftStroke * 1.28, 0, -0.38 + leftStroke * 0.18, delta, 14.2);
  smoothRotation(parts.rightArmPivot, -0.45 + rightStroke * 1.28, 0, 0.38 - rightStroke * 0.18, delta, 14.2);
  smoothRotation(parts.leftLegPivot, 0.2 + flutter, 0, 0, delta, 12.1);
  smoothRotation(parts.rightLegPivot, 0.2 - flutter, 0, 0, delta, 12.1);
}

function shouldUseWaterIdle(player, speed) {
  return player.isSwimming && speed <= 0.14;
}

function applyWaterIdlePose(player, body, parts, baseBodyY, now, delta) {
  const t = now * 0.0026 + player.animPhase;
  body.position.y += (baseBodyY - 0.76 + Math.sin(t * 1.5) * 0.02 - body.position.y) * Math.min(1, delta * 8.2);
  smoothRotation(body, 1.45, 0, Math.sin(t * 0.8) * 0.018, delta, 10.2);
  smoothRotation(parts.leftArmPivot, -0.38 + Math.sin(t * 1.2) * 0.1, 0, -0.3, delta, 10.9);
  smoothRotation(parts.rightArmPivot, -0.38 - Math.sin(t * 1.2) * 0.1, 0, 0.3, delta, 10.9);
  smoothRotation(parts.leftLegPivot, 0.2 + Math.sin(t * 1.9) * 0.04, 0, 0, delta, 10.1);
  smoothRotation(parts.rightLegPivot, 0.2 - Math.sin(t * 1.9) * 0.04, 0, 0, delta, 10.1);
}

function movementInputScale(local, sprintHeld, isSliding) {
  if (!sprintAllowed(local)) return 1;
  if (sprintHeld && !isSliding) return SPRINT_MULTIPLIER;
  return 1;
}

function canSprintNow(local, sprintHeld, staminaLevel, isSliding) {
  return sprintAllowed(local) && sprintHeld && staminaLevel > 0.5 && !isSliding;
}

function canSlideNow(local, wantsSlide, isGrounded, isSliding, input) {
  return shouldSlide(local) && wantsSlide && isGrounded && !isSliding && (Math.abs(input.x) > 0.0001 || Math.abs(input.z) > 0.0001);
}

function slideDrainMultiplier(local) {
  return local.isSwimming ? 0 : 1;
}

function surfaceHintOverride(local) {
  if (local?.isSwimming) return swimHintText();
  return null;
}

function isWithinPlayableWorld(x, z) {
  const MAIN_RADIUS = worldLimit * 1.14;
  const LIGHTHOUSE_RADIUS = 11.7;
  const INTERIOR_RADIUS = INTERIOR_PLAY_RADIUS;
  const onMain = Math.hypot(x, z) <= MAIN_RADIUS;
  const onLighthouse = Math.hypot(x - LIGHTHOUSE_POS.x, z - LIGHTHOUSE_POS.z) <= LIGHTHOUSE_RADIUS;
  const inInterior = Math.hypot(x - LIGHTHOUSE_INTERIOR_BASE.x, z - LIGHTHOUSE_INTERIOR_BASE.z) <= INTERIOR_RADIUS;
  const inSwim = isSwimZone(x, z);
  return onMain || onLighthouse || inInterior || inSwim;
}

function setBeaconVisual(active) {
  if (active) {
    beaconCore.material.color.set(0xfbbf24);
    beaconCore.material.emissive.set(0xf59e0b);
    beaconCore.material.emissiveIntensity = 1.35;
  } else {
    beaconCore.material.color.set(0x38bdf8);
    beaconCore.material.emissive.set(0x0c4a6e);
    beaconCore.material.emissiveIntensity = 0.4;
  }
}

function updateBeaconState(payload) {
  if (!payload || payload.id !== 'beacon') return;
  interactables.set(payload.id, payload);
  setBeaconVisual(Boolean(payload.active));
}

function makeExactBaconMesh() {
  return null;
}

function makePlayerMesh(appearance) {
  const exact = makeExactBaconMesh();
  if (exact) {
    return exact;
  }

  const UNIT = 0.52;
  const rig = new THREE.Group();
  rig.position.y = 0.56;

  const hips = new THREE.Mesh(
    new THREE.BoxGeometry(1.36 * UNIT, 0.86 * UNIT, 0.72 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.pants, roughness: 0.82 })
  );
  hips.position.y = 1.08 * UNIT;
  hips.castShadow = true;

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(1.56 * UNIT, 1.62 * UNIT, 0.88 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.shirt, roughness: 0.68 })
  );
  torso.position.y = 2.46 * UNIT;
  torso.castShadow = true;

  const torsoStripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.32 * UNIT, 0.3 * UNIT, 0.08 * UNIT),
    new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.7 })
  );
  torsoStripe.position.set(0, 2.4 * UNIT, 0.49 * UNIT);
  torsoStripe.castShadow = true;

  const jacket = new THREE.Mesh(
    new THREE.BoxGeometry(1.62 * UNIT, 1.66 * UNIT, 0.94 * UNIT),
    new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.75 })
  );
  jacket.position.copy(torso.position);
  jacket.castShadow = true;

  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(1.4 * UNIT, 0.14 * UNIT, 0.82 * UNIT),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.72 })
  );
  belt.position.y = 1.76 * UNIT;
  belt.castShadow = true;

  const neck = new THREE.Mesh(
    new THREE.BoxGeometry(0.38 * UNIT, 0.2 * UNIT, 0.28 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.9 })
  );
  neck.position.y = 3.52 * UNIT;
  neck.castShadow = true;

  const neckConnector = new THREE.Mesh(
    new THREE.BoxGeometry(0.44 * UNIT, 0.18 * UNIT, 0.34 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.88 })
  );
  neckConnector.position.y = 3.72 * UNIT;
  neckConnector.castShadow = true;

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(1.12 * UNIT, 1.08 * UNIT, 1.02 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.88 })
  );
  head.position.y = 4.42 * UNIT;
  head.castShadow = true;

  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.2 });
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.06 * UNIT, 8, 8), eyeMat);
  leftEye.position.set(-0.23 * UNIT, 4.56 * UNIT, 0.56 * UNIT);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.23 * UNIT;

  const mouthSmile = new THREE.Mesh(new THREE.TorusGeometry(0.2 * UNIT, 0.03 * UNIT, 6, 12, Math.PI), eyeMat);
  mouthSmile.rotation.set(Math.PI, 0, 0);
  mouthSmile.position.set(0, 4.26 * UNIT, 0.56 * UNIT);

  const mouthSerious = new THREE.Mesh(new THREE.BoxGeometry(0.34 * UNIT, 0.03 * UNIT, 0.02 * UNIT), eyeMat);
  mouthSerious.position.set(0, 4.22 * UNIT, 0.56 * UNIT);

  const mouthGrin = new THREE.Mesh(new THREE.TorusGeometry(0.24 * UNIT, 0.04 * UNIT, 6, 14, Math.PI), eyeMat);
  mouthGrin.rotation.set(Math.PI, 0, 0);
  mouthGrin.position.set(0, 4.24 * UNIT, 0.56 * UNIT);
  const mouthSoft = new THREE.Mesh(new THREE.TorusGeometry(0.16 * UNIT, 0.025 * UNIT, 6, 12, Math.PI), eyeMat);
  mouthSoft.rotation.set(Math.PI, 0, 0);
  mouthSoft.position.set(0, 4.2 * UNIT, 0.56 * UNIT);

  const leftEyeWink = new THREE.Mesh(new THREE.BoxGeometry(0.13 * UNIT, 0.03 * UNIT, 0.02 * UNIT), eyeMat);
  leftEyeWink.position.set(-0.23 * UNIT, 4.56 * UNIT, 0.56 * UNIT);
  const lashMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.25 });
  const leftLashes = new THREE.Mesh(new THREE.BoxGeometry(0.16 * UNIT, 0.025 * UNIT, 0.02 * UNIT), lashMat);
  leftLashes.position.set(-0.23 * UNIT, 4.65 * UNIT, 0.56 * UNIT);
  const rightLashes = leftLashes.clone();
  rightLashes.position.x = 0.23 * UNIT;

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.86 * UNIT, 3.0 * UNIT, 0);
  const leftArm = new THREE.Mesh(
    new THREE.BoxGeometry(0.46 * UNIT, 1.4 * UNIT, 0.46 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.9 })
  );
  leftArm.position.y = -0.8 * UNIT;
  leftArm.castShadow = true;
  leftArmPivot.add(leftArm);
  const leftSleeve = new THREE.Mesh(
    new THREE.BoxGeometry(0.5 * UNIT, 0.42 * UNIT, 0.5 * UNIT),
    new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.76 })
  );
  leftSleeve.position.y = -0.2 * UNIT;
  leftArmPivot.add(leftSleeve);

  const leftHand = new THREE.Mesh(
    new THREE.BoxGeometry(0.36 * UNIT, 0.34 * UNIT, 0.32 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.88 })
  );
  leftHand.position.y = -1.7 * UNIT;
  leftHand.castShadow = true;
  leftArmPivot.add(leftHand);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.86 * UNIT, 3.0 * UNIT, 0);
  const rightArm = leftArm.clone();
  rightArm.position.y = -0.8 * UNIT;
  rightArmPivot.add(rightArm);
  const rightSleeve = leftSleeve.clone();
  rightArmPivot.add(rightSleeve);
  const rightHand = leftHand.clone();
  rightArmPivot.add(rightHand);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.38 * UNIT, 1.02 * UNIT, 0);
  const leftLeg = new THREE.Mesh(
    new THREE.BoxGeometry(0.52 * UNIT, 1.8 * UNIT, 0.56 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.pants, roughness: 0.84 })
  );
  leftLeg.position.y = -1.02 * UNIT;
  leftLeg.castShadow = true;
  leftLegPivot.add(leftLeg);

  const leftKnee = new THREE.Mesh(
    new THREE.BoxGeometry(0.53 * UNIT, 0.2 * UNIT, 0.58 * UNIT),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 })
  );
  leftKnee.position.y = -0.94 * UNIT;
  leftKnee.castShadow = true;
  leftLegPivot.add(leftKnee);

  const leftBoot = new THREE.Mesh(
    new THREE.BoxGeometry(0.58 * UNIT, 0.4 * UNIT, 0.88 * UNIT),
    new THREE.MeshStandardMaterial({ color: appearance.shoes, roughness: 0.68 })
  );
  leftBoot.position.set(0, -1.96 * UNIT, 0.14 * UNIT);
  leftBoot.castShadow = true;
  leftLegPivot.add(leftBoot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.38 * UNIT, 1.02 * UNIT, 0);
  const rightLeg = leftLeg.clone();
  rightLeg.position.y = -1.02 * UNIT;
  rightLegPivot.add(rightLeg);
  const rightKnee = leftKnee.clone();
  rightLegPivot.add(rightKnee);
  const rightBoot = leftBoot.clone();
  rightLegPivot.add(rightBoot);

  const hairMat = new THREE.MeshStandardMaterial({ color: appearance.hairColor, roughness: 0.6 });
  const hairMatSoft = new THREE.MeshStandardMaterial({ color: appearance.hairColor, roughness: 0.72 });

  const hairShort = new THREE.Group();
  const shortCrown = new THREE.Mesh(new THREE.SphereGeometry(0.66 * UNIT, 18, 12), hairMat);
  shortCrown.scale.set(1.0, 0.58, 0.96);
  shortCrown.position.set(0, 5.08 * UNIT, -0.02 * UNIT);
  shortCrown.castShadow = true;
  const shortBack = new THREE.Mesh(new THREE.BoxGeometry(1.06 * UNIT, 0.34 * UNIT, 0.26 * UNIT), hairMatSoft);
  shortBack.position.set(0, 4.85 * UNIT, -0.46 * UNIT);
  shortBack.castShadow = true;
  for (let i = -1; i <= 1; i += 1) {
    const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.22 * UNIT, 0.2 * UNIT, 0.16 * UNIT), hairMat);
    fringe.position.set(i * 0.19 * UNIT, 4.84 * UNIT - Math.abs(i) * 0.01 * UNIT, 0.53 * UNIT);
    fringe.castShadow = true;
    hairShort.add(fringe);
  }
  hairShort.add(shortCrown, shortBack);

  const hairSidePart = new THREE.Group();
  const sideCrown = new THREE.Mesh(new THREE.SphereGeometry(0.68 * UNIT, 18, 12), hairMat);
  sideCrown.scale.set(1.0, 0.6, 0.96);
  sideCrown.position.set(0.04 * UNIT, 5.07 * UNIT, 0);
  sideCrown.castShadow = true;
  const partLine = new THREE.Mesh(new THREE.BoxGeometry(0.1 * UNIT, 0.02 * UNIT, 0.82 * UNIT), new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.3 }));
  partLine.position.set(0.1 * UNIT, 5.26 * UNIT, -0.02 * UNIT);
  const sideSweep = new THREE.Mesh(new THREE.BoxGeometry(0.44 * UNIT, 0.28 * UNIT, 0.2 * UNIT), hairMatSoft);
  sideSweep.position.set(0.31 * UNIT, 4.93 * UNIT, 0.49 * UNIT);
  sideSweep.rotation.y = -0.15;
  sideSweep.castShadow = true;
  const sideBang = new THREE.Mesh(new THREE.BoxGeometry(0.34 * UNIT, 0.34 * UNIT, 0.18 * UNIT), hairMatSoft);
  sideBang.position.set(-0.28 * UNIT, 4.82 * UNIT, 0.54 * UNIT);
  sideBang.rotation.y = 0.18;
  sideBang.castShadow = true;
  hairSidePart.add(sideCrown, partLine, sideSweep, sideBang);

  const hairSpiky = new THREE.Group();
  for (let i = -2; i <= 2; i += 1) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry((0.14 + Math.abs(i) * 0.015) * UNIT, 0.58 * UNIT, 12), hairMat);
    spike.position.set(i * 0.17 * UNIT, 5.2 * UNIT - Math.abs(i) * 0.02 * UNIT, -0.02 * UNIT);
    spike.rotation.x = -0.2 + Math.abs(i) * 0.05;
    spike.castShadow = true;
    hairSpiky.add(spike);
  }
  const spikyBase = new THREE.Mesh(new THREE.SphereGeometry(0.62 * UNIT, 16, 10), hairMatSoft);
  spikyBase.scale.set(1, 0.38, 0.9);
  spikyBase.position.set(0, 5.03 * UNIT, -0.03 * UNIT);
  spikyBase.castShadow = true;
  hairSpiky.add(spikyBase);

  const hairLong = new THREE.Group();
  const longCrown = new THREE.Mesh(new THREE.SphereGeometry(0.66 * UNIT, 18, 12), hairMat);
  longCrown.scale.set(1.0, 0.58, 0.94);
  longCrown.position.set(0, 5.08 * UNIT, 0);
  longCrown.castShadow = true;
  const longBack = new THREE.Mesh(new THREE.BoxGeometry(1.0 * UNIT, 1.24 * UNIT, 0.52 * UNIT), hairMatSoft);
  longBack.position.set(0, 4.56 * UNIT, -0.42 * UNIT);
  longBack.castShadow = true;
  const longFrontL = new THREE.Mesh(new THREE.BoxGeometry(0.2 * UNIT, 0.56 * UNIT, 0.16 * UNIT), hairMatSoft);
  longFrontL.position.set(-0.49 * UNIT, 4.6 * UNIT, 0.38 * UNIT);
  longFrontL.castShadow = true;
  const longFrontR = longFrontL.clone();
  longFrontR.position.x = 0.49 * UNIT;
  hairLong.add(longCrown, longBack, longFrontL, longFrontR);

  const hairPonytail = new THREE.Group();
  const ponyCap = new THREE.Mesh(new THREE.SphereGeometry(0.66 * UNIT, 18, 12), hairMat);
  ponyCap.scale.set(1.0, 0.58, 0.95);
  ponyCap.position.set(0, 5.08 * UNIT, 0);
  ponyCap.castShadow = true;
  const ponyBand = new THREE.Mesh(new THREE.TorusGeometry(0.14 * UNIT, 0.03 * UNIT, 8, 16), new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5 }));
  ponyBand.position.set(0, 4.9 * UNIT, -0.5 * UNIT);
  ponyBand.rotation.x = Math.PI / 2;
  const ponyTailTop = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * UNIT, 0.13 * UNIT, 0.42 * UNIT, 10), hairMatSoft);
  ponyTailTop.position.set(0, 4.64 * UNIT, -0.58 * UNIT);
  ponyTailTop.rotation.x = 0.28;
  ponyTailTop.castShadow = true;
  const ponyTailMid = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * UNIT, 0.1 * UNIT, 0.42 * UNIT, 10), hairMatSoft);
  ponyTailMid.position.set(0, 4.3 * UNIT, -0.62 * UNIT);
  ponyTailMid.rotation.x = 0.2;
  ponyTailMid.castShadow = true;
  const ponyTailEnd = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * UNIT, 0.06 * UNIT, 0.36 * UNIT, 10), hairMatSoft);
  ponyTailEnd.position.set(0, 4.02 * UNIT, -0.58 * UNIT);
  ponyTailEnd.rotation.x = 0.05;
  ponyTailEnd.castShadow = true;
  hairPonytail.add(ponyCap, ponyBand, ponyTailTop, ponyTailMid, ponyTailEnd);

  const hairBob = new THREE.Group();
  const bobCrown = new THREE.Mesh(new THREE.SphereGeometry(0.68 * UNIT, 18, 12), hairMat);
  bobCrown.scale.set(1.02, 0.58, 0.95);
  bobCrown.position.set(0, 5.05 * UNIT, 0);
  bobCrown.castShadow = true;
  const bobBack = new THREE.Mesh(new THREE.BoxGeometry(1.08 * UNIT, 0.82 * UNIT, 0.4 * UNIT), hairMatSoft);
  bobBack.position.set(0, 4.54 * UNIT, -0.36 * UNIT);
  bobBack.castShadow = true;
  const bobSideL = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * UNIT, 0.14 * UNIT, 0.72 * UNIT, 10), hairMatSoft);
  bobSideL.position.set(-0.55 * UNIT, 4.63 * UNIT, 0.1 * UNIT);
  bobSideL.rotation.z = 0.1;
  bobSideL.castShadow = true;
  const bobSideR = bobSideL.clone();
  bobSideR.position.x = 0.55 * UNIT;
  bobSideR.rotation.z = -0.1;
  hairBob.add(bobCrown, bobBack, bobSideL, bobSideR);

  const hairWavy = new THREE.Group();
  const waveCrown = new THREE.Mesh(new THREE.SphereGeometry(0.67 * UNIT, 18, 12), hairMat);
  waveCrown.scale.set(1, 0.58, 0.95);
  waveCrown.position.set(0, 5.08 * UNIT, -0.01 * UNIT);
  waveCrown.castShadow = true;
  hairWavy.add(waveCrown);
  for (let i = -2; i <= 2; i += 1) {
    const curl = new THREE.Mesh(new THREE.SphereGeometry((0.13 + (2 - Math.abs(i)) * 0.012) * UNIT, 10, 8), hairMatSoft);
    curl.position.set(i * 0.18 * UNIT, 4.58 * UNIT - Math.abs(i) * 0.02 * UNIT, 0.44 * UNIT);
    curl.castShadow = true;
    hairWavy.add(curl);
  }
  for (const side of [-1, 1]) {
    const sideWave = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * UNIT, 0.08 * UNIT, 0.58 * UNIT, 10), hairMatSoft);
    sideWave.position.set(side * 0.56 * UNIT, 4.52 * UNIT, 0.02 * UNIT);
    sideWave.rotation.z = -side * 0.12;
    sideWave.castShadow = true;
    hairWavy.add(sideWave);
  }

  const hat = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52 * UNIT, 0.52 * UNIT, 0.3 * UNIT, 16),
    new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 })
  );
  hat.position.set(0, 5.38 * UNIT, 0);
  hat.castShadow = true;

  const glasses = new THREE.Group();
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.2 });
  const glassLeft = new THREE.Mesh(new THREE.TorusGeometry(0.13 * UNIT, 0.02 * UNIT, 8, 12), glassMat);
  glassLeft.position.set(-0.22 * UNIT, 4.56 * UNIT, 0.57 * UNIT);
  const glassRight = glassLeft.clone();
  glassRight.position.x = 0.22 * UNIT;
  const glassBridge = new THREE.Mesh(new THREE.BoxGeometry(0.12 * UNIT, 0.02 * UNIT, 0.02 * UNIT), glassMat);
  glassBridge.position.set(0, 4.56 * UNIT, 0.57 * UNIT);
  glasses.add(glassLeft, glassRight, glassBridge);

  const backpack = new THREE.Mesh(
    new THREE.BoxGeometry(1.0 * UNIT, 1.2 * UNIT, 0.35 * UNIT),
    new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.82 })
  );
  backpack.position.set(0, 2.5 * UNIT, -0.64 * UNIT);
  backpack.castShadow = true;

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.72, 20),
    new THREE.MeshBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.25 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;

  rig.add(
    hips,
    torso,
    torsoStripe,
    jacket,
    belt,
    neck,
    neckConnector,
    head,
    leftArmPivot,
    rightArmPivot,
    leftLegPivot,
    rightLegPivot,
    leftEye,
    rightEye,
    mouthSmile,
    mouthSerious,
    mouthGrin,
    mouthSoft,
    leftEyeWink,
    leftLashes,
    rightLashes,
    hat,
    glasses,
    backpack,
    hairShort,
    hairSidePart,
    sideBang,
    hairSpiky,
    hairLong,
    hairPonytail,
    hairBob,
    hairWavy
  );

  const group = new THREE.Group();
  group.add(rig, shadow);
  group.userData.body = rig;
  group.userData.baseBodyY = rig.position.y;
  group.userData.parts = {
    hips,
    torso,
    jacket,
    neck,
    neckConnector,
    head,
    leftArmPivot,
    rightArmPivot,
    leftLegPivot,
    rightLegPivot,
    leftArm,
    rightArm,
    leftHand,
    rightHand,
    leftLeg,
    rightLeg,
    leftKnee,
    rightKnee,
    leftBoot,
    rightBoot,
    leftSleeve,
    rightSleeve,
    torsoStripe,
    belt,
    leftEye,
    rightEye,
    mouthSmile,
    mouthSerious,
    mouthGrin,
    mouthSoft,
    leftEyeWink,
    leftLashes,
    rightLashes,
    hat,
    glasses,
    backpack,
    hairShort,
    hairSidePart,
    sideBang,
    hairSpiky,
    hairLong,
    hairPonytail,
    hairBob,
    hairWavy,
    faceStyle: appearance.faceStyle,
    accessories: appearance.accessories
  };
  scene.add(group);

  return group;
}

function paintPlayer(player, appearance) {
  const parts = player?.mesh?.userData?.parts;
  if (!parts) return;
  const tintMeshTree = (node, color) => {
    if (!node) return;
    if (node.material?.color) {
      node.material.color.set(color);
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => tintMeshTree(child, color));
    }
  };

  parts.torso.material.color.set(appearance.shirt);
  parts.torsoStripe.material.color.set(appearance.shirt);
  parts.jacket.material.color.set(appearance.shirt);
  parts.belt.material.color.set(0x1f2937);
  parts.hips.material.color.set(appearance.pants);
  parts.neck.material.color.set(appearance.skin);
  parts.neckConnector.material.color.set(appearance.skin);
  parts.head.material.color.set(appearance.skin);
  parts.leftArm.material.color.set(appearance.skin);
  parts.rightArm.material.color.set(appearance.skin);
  parts.leftHand.material.color.set(appearance.skin);
  parts.rightHand.material.color.set(appearance.skin);
  parts.leftSleeve.material.color.set(appearance.shirt);
  parts.rightSleeve.material.color.set(appearance.shirt);
  parts.leftLeg.material.color.set(appearance.pants);
  parts.rightLeg.material.color.set(appearance.pants);
  parts.leftBoot.material.color.set(appearance.shoes);
  parts.rightBoot.material.color.set(appearance.shoes);
  tintMeshTree(parts.hairShort, appearance.hairColor);
  tintMeshTree(parts.hairSidePart, appearance.hairColor);
  tintMeshTree(parts.sideBang, appearance.hairColor);
  tintMeshTree(parts.hairSpiky, appearance.hairColor);
  tintMeshTree(parts.hairLong, appearance.hairColor);
  tintMeshTree(parts.hairPonytail, appearance.hairColor);
  tintMeshTree(parts.hairBob, appearance.hairColor);
  tintMeshTree(parts.hairWavy, appearance.hairColor);

  parts.hairShort.visible = appearance.hairStyle === 'short';
  parts.hairSidePart.visible = appearance.hairStyle === 'sidepart';
  parts.sideBang.visible = appearance.hairStyle === 'sidepart';
  parts.hairSpiky.visible = appearance.hairStyle === 'spiky';
  parts.hairLong.visible = appearance.hairStyle === 'long';
  parts.hairPonytail.visible = appearance.hairStyle === 'ponytail';
  parts.hairBob.visible = appearance.hairStyle === 'bob';
  parts.hairWavy.visible = appearance.hairStyle === 'wavy';
  const accessories = Array.isArray(appearance.accessories) ? appearance.accessories : [];
  parts.hat.visible = accessories.includes('hat');
  parts.glasses.visible = accessories.includes('glasses');
  parts.backpack.visible = accessories.includes('backpack');

  parts.leftEye.visible = true;
  parts.rightEye.visible = true;
  parts.leftEyeWink.visible = false;
  parts.leftLashes.visible = false;
  parts.rightLashes.visible = false;
  parts.mouthSmile.visible = false;
  parts.mouthSerious.visible = false;
  parts.mouthGrin.visible = false;
  parts.mouthSoft.visible = false;

  if (appearance.faceStyle === 'serious') {
    parts.mouthSerious.visible = true;
  } else if (appearance.faceStyle === 'grin') {
    parts.mouthGrin.visible = true;
  } else if (appearance.faceStyle === 'wink') {
    parts.leftEye.visible = false;
    parts.leftEyeWink.visible = true;
    parts.mouthSmile.visible = true;
  } else if (appearance.faceStyle === 'lashessmile') {
    parts.leftLashes.visible = true;
    parts.rightLashes.visible = true;
    parts.mouthSmile.visible = true;
  } else if (appearance.faceStyle === 'soft') {
    parts.leftLashes.visible = true;
    parts.rightLashes.visible = true;
    parts.mouthSoft.visible = true;
  } else {
    parts.mouthSmile.visible = true;
  }
}

function applyPlayerCustomization(id, name, color, appearancePayload) {
  const player = players.get(id);
  if (!player) return;

  if (typeof name === 'string' && name.trim()) {
    player.name = name.trim();
  }
  const appearance = normalizeAppearance(appearancePayload, normalizeAppearance(player.appearance, defaultAppearance()));
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
    appearance.shirt = color;
  }
  player.appearance = appearance;
  player.color = appearance.shirt;
  paintPlayer(player, appearance);

  if (player.label) {
    player.label.textContent = player.name;
  }

  if (id === localPlayerId) {
    localStorage.setItem('island_profile_name', player.name);
    if (player.color?.startsWith('#')) {
      localStorage.setItem('island_profile_color', player.color);
      colorInputEl.value = player.color;
    }
    localStorage.setItem('island_profile_skin', appearance.skin);
    localStorage.setItem('island_profile_hair_style', appearance.hairStyle);
    localStorage.setItem('island_profile_hair_color', appearance.hairColor);
    localStorage.setItem('island_profile_face_style', appearance.faceStyle);
    localStorage.setItem('island_profile_pants_color', appearance.pants);
    localStorage.setItem('island_profile_shoes_color', appearance.shoes);
    localStorage.setItem('island_profile_accessories', (appearance.accessories || []).join(','));
    skinInputEl.value = appearance.skin;
    hairStyleInputEl.value = appearance.hairStyle;
    hairColorInputEl.value = appearance.hairColor;
    faceStyleInputEl.value = appearance.faceStyle;
    pantsColorInputEl.value = appearance.pants;
    shoesColorInputEl.value = appearance.shoes;
    selectedAccessories.clear();
    (appearance.accessories || []).forEach((item) => selectedAccessories.add(item));
    nameInputEl.value = player.name;
    refreshItemCards();
    if (!customizeModalEl.classList.contains('hidden')) {
      updatePreviewAvatar();
    }
  }
}

function addPlayer(data) {
  if (players.has(data.id)) return;

  const appearance = normalizeAppearance(data.appearance, {
    ...defaultAppearance(),
    shirt: data.color || '#38bdf8'
  });
  const mesh = makePlayerMesh(appearance);
  mesh.position.set(data.x, data.y ?? 0, data.z);

  const tag = document.createElement('div');
  tag.className = 'player-tag';
  tag.textContent = data.name || `Player-${String(data.id).slice(0, 4)}`;
  nameTagsEl.appendChild(tag);

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.style.display = 'none';
  nameTagsEl.appendChild(bubble);

  players.set(data.id, {
    mesh,
    x: data.x,
    y: data.y ?? 0,
    vy: 0,
    z: data.z,
    name: data.name || `Player-${String(data.id).slice(0, 4)}`,
    color: appearance.shirt,
    appearance,
    emoteType: null,
    emoteUntil: 0,
    animPhase: Math.random() * Math.PI * 2,
    animSpeed: 0,
    facingYaw: 0,
    targetYaw: 0,
    onBoat: false,
    isSwimming: false,
    isLocal: data.id === localPlayerId,
    label: tag,
    bubble,
    bubbleUntil: 0
  });

  paintPlayer(players.get(data.id), appearance);
  updateHud();
}

function removePlayer(id) {
  const player = players.get(id);
  if (!player) return;
  scene.remove(player.mesh);
  // Dispose geometry and materials to prevent GPU memory leak on player leave
  player.mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
  player.label?.remove();
  player.bubble?.remove();
  players.delete(id);
  updateHud();
}

function showChatBubble(id, text) {
  const player = players.get(id);
  if (!player || !player.bubble) return;

  const safeText = String(text || '').trim().slice(0, 120);
  if (!safeText) return;

  player.bubble.textContent = safeText;
  player.bubble.style.display = 'block';
  player.bubble.style.opacity = '1';
  player.bubbleUntil = Date.now() + CHAT_BUBBLE_MS;
}

function updateHud() {
  playerCountEl.textContent = String(players.size || 1);
}

function appendChatLine({ fromName, text, sentAt, isSystem = false }) {
  const row = document.createElement('li');
  const time = new Date(sentAt || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  const safeName = isSystem ? 'System' : fromName || 'Player';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `[${time}] ${safeName}:`;
  row.appendChild(meta);
  row.appendChild(document.createTextNode(` ${text}`));
  chatLogEl.appendChild(row);

  while (chatLogEl.children.length > 70) {
    chatLogEl.removeChild(chatLogEl.firstChild);
  }

  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function triggerEmote(type) {
  const now = performance.now();
  if (now - lastEmoteAt < 300) return;
  lastEmoteAt = now;
  if (localPlayerId) {
    applyEmote(localPlayerId, type, Date.now());
  }
  socket.emit('emote', { type });
}

function applyEmote(id, type, sentAt = Date.now()) {
  const player = players.get(id);
  if (!player) return;
  player.emoteType = type;
  player.emoteUntil = sentAt + 2200;
}

function removeVoicePeer(peerId) {
  const pc = voicePeers.get(peerId);
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
    voicePeers.delete(peerId);
  }
  const audio = voiceAudioEls.get(peerId);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    voiceAudioEls.delete(peerId);
  }
  pendingVoiceIce.delete(peerId);
}

function queueVoiceIce(peerId, candidate) {
  if (!peerId || !candidate) return;
  const list = pendingVoiceIce.get(peerId) || [];
  list.push(candidate);
  pendingVoiceIce.set(peerId, list);
}

async function flushQueuedIce(peerId, pc) {
  const list = pendingVoiceIce.get(peerId);
  if (!pc || !list?.length || !pc.remoteDescription) return;
  pendingVoiceIce.delete(peerId);
  for (const candidate of list) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }
}

function hasRemoteDescription(pc) {
  return Boolean(pc?.remoteDescription?.type);
}

function ensureVoicePeer(peerId, shouldOffer) {
  if (!voiceEnabled || !peerId || peerId === localPlayerId) return null;
  if (voicePeers.has(peerId)) return voicePeers.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers: VOICE_ICE_SERVERS
  });
  const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const localTrack = localVoiceStream?.getAudioTracks?.()[0] || null;
  if (localTrack) {
    audioTransceiver.sender.replaceTrack(localTrack).catch(() => {});
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('voice:ice', { to: peerId, candidate: event.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      pc.createOffer({ iceRestart: true })
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          socket.emit('voice:offer', { to: peerId, offer: pc.localDescription });
        })
        .catch(() => {});
    }
  };
  pc.ontrack = (event) => {
    let audio = voiceAudioEls.get(peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
      voiceAudioEls.set(peerId, audio);
    }
    audio.srcObject = event.streams[0];
    const startPlayback = audio.play();
    if (startPlayback?.catch) {
      startPlayback.catch(() => {});
    }
  };
  voicePeers.set(peerId, pc);

  if (shouldOffer) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('voice:offer', { to: peerId, offer: pc.localDescription });
      })
      .catch(() => {});
  }
  return pc;
}

async function enableVoice() {
  if (voiceEnabled) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    if (voiceToggleEl) voiceToggleEl.textContent = 'Voice not supported';
    return;
  }
  voiceEnabled = true;
  await setVoiceMuted(false);
  socket.emit('voice:join');
}

function disableVoice() {
  if (!voiceEnabled) return;
  voiceEnabled = false;
  voiceMuted = false;
  socket.emit('voice:leave');
  if (localVoiceStream) {
    localVoiceStream.getTracks().forEach((track) => track.stop());
    localVoiceStream = null;
  }
  [...voicePeers.keys()].forEach(removeVoicePeer);
  updateVoiceButtonLabels();
}

async function toggleVoiceQuick() {
  if (!voiceEnabled) {
    await enableVoice();
    return;
  }
  await setVoiceMuted(!voiceMuted);
}

function updateVoiceVolumes() {
  if (!voiceEnabled || !localPlayerId) return;
  const local = players.get(localPlayerId);
  if (!local) return;
  voiceAudioEls.forEach((audio, peerId) => {
    const remote = players.get(peerId);
    if (!remote || !audio) return;
    const distance = Math.hypot(local.x - remote.x, local.z - remote.z);
    if (distance >= VOICE_RADIUS) {
      audio.volume = 0;
      return;
    }
    const ratio = 1 - distance / VOICE_RADIUS;
    audio.volume = Math.max(0, Math.min(1, ratio));
  });
}

function updatePlayerEmotes(now, delta) {
  players.forEach((player) => {
    const body = player.mesh.userData.body;
    const parts = player.mesh.userData.parts;
    const baseBodyY = player.mesh.userData.baseBodyY;
    if (!body || !parts) return;
    const resetForGround = () => {
      body.rotation.set(0, 0, 0);
      body.position.y = baseBodyY;
      parts.leftArmPivot.rotation.set(0, 0, 0);
      parts.rightArmPivot.rotation.set(0, 0, 0);
      parts.leftLegPivot.rotation.set(0, 0, 0);
      parts.rightLegPivot.rotation.set(0, 0, 0);
    };

    if (player.onBoat) {
      resetForGround();
      body.position.y = baseBodyY - 0.68;
      body.rotation.x = -0.08;
      parts.leftLegPivot.rotation.x = 1.26;
      parts.rightLegPivot.rotation.x = 1.26;
      const rowStrength = Math.min(1, Math.abs(boatState.speed) / 8);
      const stroke = Math.sin(boatState.paddlePhase || 0) * rowStrength;
      parts.leftArmPivot.rotation.x = -0.2 + stroke * 0.46;
      parts.rightArmPivot.rotation.x = -0.2 - stroke * 0.46;
      parts.leftArmPivot.rotation.z = -0.18 + stroke * 0.18;
      parts.rightArmPivot.rotation.z = 0.18 - stroke * 0.18;
      return;
    }

    const hasEmote = Boolean(player.emoteType && now <= player.emoteUntil);
    player.animPhase += delta * (4 + player.animSpeed * 13);
    const stride = Math.sin(player.animPhase);
    const strideAbs = Math.abs(stride);
    const speed = Math.min(1, player.animSpeed);

    if (!hasEmote && inDeepWater(player)) {
      if (shouldUseWaterIdle(player, speed)) {
        applyWaterIdlePose(player, body, parts, baseBodyY, now, delta);
      } else {
        applySwimPose(player, body, parts, baseBodyY, delta);
      }
      return;
    }

    resetForGround();

    // Roblox-like locomotion: strong arm-leg opposition and blocky posture.
    if (!hasEmote && speed > 0.04) {
      const legSwing = 0.96 * speed;
      const armSwing = 1.08 * speed;

      parts.leftLegPivot.rotation.x = stride * legSwing;
      parts.rightLegPivot.rotation.x = -stride * legSwing;
      parts.leftArmPivot.rotation.x = -stride * armSwing;
      parts.rightArmPivot.rotation.x = stride * armSwing;

      body.position.y = baseBodyY + strideAbs * (0.06 + speed * 0.05);
      body.rotation.x = -0.08 - speed * 0.12;
      body.rotation.y = Math.sin(player.animPhase * 0.5) * 0.03;
    } else if (!hasEmote) {
      // Idle has a subtle toy-like sway.
      const idle = Math.sin(now * 0.0042 + player.animPhase) * 0.03;
      body.position.y = baseBodyY + idle;
      body.rotation.y = Math.sin(now * 0.0024 + player.animPhase) * 0.04;
      parts.leftArmPivot.rotation.x = 0.03 + Math.sin(now * 0.0035 + player.animPhase) * 0.04;
      parts.rightArmPivot.rotation.x = 0.03 - Math.sin(now * 0.0035 + player.animPhase) * 0.04;
    }

    if (!hasEmote && player.y > GROUND_Y + 0.08) {
      // In-air pose: arms up, legs slightly tucked.
      body.rotation.x = -0.2;
      parts.leftArmPivot.rotation.x = -0.45;
      parts.rightArmPivot.rotation.x = -0.45;
      parts.leftLegPivot.rotation.x = 0.28;
      parts.rightLegPivot.rotation.x = 0.28;
    }

    if (!hasEmote) {
      player.emoteType = null;
      return;
    }

    const t = (now % 1200) / 1200;
    if (player.emoteType === 'wave') {
      parts.rightArmPivot.rotation.x = -1.42;
      parts.rightArmPivot.rotation.z = Math.sin(t * Math.PI * 10) * 0.5;
      parts.leftArmPivot.rotation.x = 0.28;
      body.rotation.y = Math.sin(t * Math.PI * 2) * 0.16;
    } else if (player.emoteType === 'dance') {
      const beat = Math.sin(t * Math.PI * 6);
      body.rotation.y = beat * 0.72;
      body.position.y = baseBodyY + Math.abs(beat) * 0.18;
      parts.leftArmPivot.rotation.x = beat * 1.22;
      parts.rightArmPivot.rotation.x = -parts.leftArmPivot.rotation.x;
      parts.leftLegPivot.rotation.x = beat * 0.68;
      parts.rightLegPivot.rotation.x = -parts.leftLegPivot.rotation.x;
    } else if (player.emoteType === 'cheer') {
      body.position.y = baseBodyY + Math.abs(Math.sin(t * Math.PI * 4)) * 0.26;
      parts.leftArmPivot.rotation.x = -1.52;
      parts.rightArmPivot.rotation.x = -1.52;
      parts.leftArmPivot.rotation.z = -0.16;
      parts.rightArmPivot.rotation.z = 0.16;
      body.rotation.z = Math.sin(t * Math.PI * 4) * 0.16;
    }
  });
}

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function teleportLocal(local, pos, yaw = null) {
  local.x = pos.x;
  local.y = pos.y ?? GROUND_Y;
  local.z = pos.z;
  local.vy = 0;
  stopSwimOnTeleport(local);
  local.mesh.position.set(local.x, local.y, local.z);
  if (typeof yaw === 'number') {
    local.facingYaw = yaw;
    local.targetYaw = yaw;
    local.mesh.rotation.y = yaw;
  }
}

function boardBoat(local) {
  if (!boatState.mesh) return;
  boatState.onboard = true;
  local.onBoat = true;
  local.isSwimming = false;
  const slot = nearestDockSlot(local, 11);
  const nearBoat = distance2D(local, boatState) < 5.2;
  if (slot && !nearBoat) {
    const posed = boatPoseForDock(slot);
    boatState.x = posed.x;
    boatState.z = posed.z;
    boatState.yaw = posed.yaw;
  }
  boatState.speed = 0;
  boatState.mesh.position.set(boatState.x, boatState.y, boatState.z);
  boatState.mesh.rotation.y = boatState.yaw;
  teleportLocal(local, { x: boatState.x, y: GROUND_Y, z: boatState.z }, boatState.yaw);
}

function exitBoat(local, forceAnywhere = false) {
  boatState.onboard = false;
  boatState.speed = 0;
  local.onBoat = false;
  local.isSwimming = false;
  const dockSlot = nearestDockSlot(boatState, 12);
  if (dockSlot && !forceAnywhere) {
    const posed = boatPoseForDock(dockSlot);
    boatState.x = posed.x;
    boatState.z = posed.z;
    boatState.yaw = posed.yaw;
    boatState.mesh.position.set(boatState.x, boatState.y, boatState.z);
    boatState.mesh.rotation.y = boatState.yaw;
    const disembark = {
      x: dockSlot.dock.x - Math.sin(dockSlot.yaw) * 1.2,
      y: GROUND_Y,
      z: dockSlot.dock.z - Math.cos(dockSlot.yaw) * 1.2
    };
    teleportLocal(local, disembark, boatState.yaw);
    return;
  }

  const sideOffset = 1.14;
  const sideSign = Math.sin(performance.now() * 0.003) > 0 ? 1 : -1;
  const outX = boatState.x + Math.cos(boatState.yaw) * sideOffset * sideSign;
  const outZ = boatState.z - Math.sin(boatState.yaw) * sideOffset * sideSign;
  const outY = isWaterAt(outX, outZ) ? SWIM_SURFACE_Y : GROUND_Y;
  teleportLocal(local, { x: outX, y: outY, z: outZ }, boatState.yaw);
  local.isSwimming = isWaterAt(outX, outZ);
}

function tryInteract() {
  if (!isAuthenticated || menuOpen || !customizeModalEl.classList.contains('hidden')) return;
  const now = performance.now();
  if (now - lastInteractAt < 220) return;
  const local = players.get(localPlayerId);
  if (!local || isTeleporting) return;

  const nearLighthouseEntry =
    distance2D(local, LIGHTHOUSE_DOOR_POS) < 4.9 ||
    (distance2D(local, LIGHTHOUSE_POS) < 8.6 && local.y <= GROUND_Y + 1.7);
  const nearInteriorPortal = inLighthouseInterior && distance2D(local, INTERIOR_EXIT_PORTAL_POS) < 3.1;
  const nearTopPortal = !inLighthouseInterior && !local.onBoat && distance2D(local, LIGHTHOUSE_TOP_POS) < 2.9 && local.y > 11.6;

  if (!local.onBoat && nearLighthouseEntry && !inLighthouseInterior) {
    runTeleportTransition('enter-lighthouse', () => {
      inLighthouseInterior = true;
      if (lighthouseInteriorGroup) lighthouseInteriorGroup.visible = true;
      teleportLocal(local, { x: INTERIOR_ENTRY_POS.x, y: GROUND_Y, z: INTERIOR_ENTRY_POS.z }, Math.PI);
    });
    lastInteractAt = now;
    return;
  }

  if (nearInteriorPortal) {
    runTeleportTransition('exit-lighthouse', () => {
      inLighthouseInterior = false;
      if (lighthouseInteriorGroup) lighthouseInteriorGroup.visible = false;
      teleportLocal(local, { x: LIGHTHOUSE_TOP_POS.x, y: LIGHTHOUSE_TOP_POS.y, z: LIGHTHOUSE_TOP_POS.z }, Math.PI);
    });
    lastInteractAt = now;
    return;
  }

  if (nearTopPortal) {
    runTeleportTransition('enter-lighthouse', () => {
      inLighthouseInterior = true;
      if (lighthouseInteriorGroup) lighthouseInteriorGroup.visible = true;
      teleportLocal(local, { x: INTERIOR_EXIT_PORTAL_POS.x, y: INTERIOR_EXIT_PORTAL_POS.y, z: INTERIOR_EXIT_PORTAL_POS.z }, Math.PI);
    });
    lastInteractAt = now;
    return;
  }

  if (boatState.onboard) {
    exitBoat(local, true);
    lastInteractAt = now;
    return;
  } else {
    if (allowBoatBoard(local)) {
      boardBoat(local);
      lastInteractAt = now;
      return;
    }
  }

  const beacon = interactables.get('beacon');
  if (!beacon) return;
  const distance = Math.hypot(local.x - beacon.x, local.z - beacon.z);
  if (distance > 4.2) return;
  socket.emit('interact', { id: 'beacon' });
  lastInteractAt = now;
}

socket.on('connect', () => {
  statusEl.textContent = 'Connected';
  if (!isAuthenticated) {
    if (authStatusEl && !authStatusEl.textContent.trim()) {
      authStatusEl.textContent = 'Signing in...';
    }
    autoAuthToGameplay();
  }
});

socket.on('disconnect', () => {
  statusEl.textContent = 'Disconnected';
  [...voicePeers.keys()].forEach(removeVoicePeer);
  if (isAuthenticated) {
    setAuthModalOpen(true, 'Connection lost. Login again.');
    clearSessionWorld();
  }
});

socket.on('auth:required', () => {
  statusEl.textContent = 'Auth Required';
  clearSessionWorld();
  setAuthModalOpen(true, 'Please login or create an account.');
  autoAuthToGameplay();
});

socket.on('init', (payload) => {
  isAuthenticated = true;
  setAuthModalOpen(false);
  localPlayerId = payload.id;
  worldLimit = payload.worldLimit || worldLimit;

  players.forEach((_, id) => removePlayer(id));
  payload.players.forEach(addPlayer);

  interactables.clear();
  (payload.interactables || []).forEach(updateBeaconState);

  const local = payload.players.find((player) => player.id === localPlayerId);
  if (local) {
    applyPlayerCustomization(local.id, local.name, local.color, local.appearance);
    customizeStatusEl.textContent = `Saved as ${local.name || 'Player'}`;
  }

  statusEl.textContent = 'Connected';
  appendChatLine({
    text: 'Connected to server chat.',
    isSystem: true
  });
  if (voiceEnabled) {
    socket.emit('voice:join');
  }
});

socket.on('playerJoined', (payload) => {
  if (!isAuthenticated) return;
  addPlayer(payload);
  appendChatLine({
    text: `${payload.name || 'A player'} joined the island.`,
    isSystem: true
  });
});

socket.on('playerLeft', (id) => {
  if (!isAuthenticated) return;
  const player = players.get(id);
  removePlayer(id);
  appendChatLine({
    text: `${player?.name || `Player-${id.slice(0, 4)}`} left the island.`,
    isSystem: true
  });
});

socket.on('playerMoved', ({ id, x, y, z, name, color, appearance }) => {
  const player = players.get(id);
  if (!player) return;
  player.x = x;
  player.y = Number.isFinite(y) ? y : player.y;
  player.z = z;
  if (typeof name === 'string' || typeof color === 'string' || appearance) {
    applyPlayerCustomization(id, name, color, appearance);
  }
});

socket.on('playerCustomized', ({ id, name, color, appearance }) => {
  applyPlayerCustomization(id, name, color, appearance);
  if (id === localPlayerId) {
    if (customizeTimer) {
      clearTimeout(customizeTimer);
      customizeTimer = null;
    }
    customizeStatusEl.textContent = `Saved as ${name}`;
  }
});

socket.on('playerEmote', ({ id, type, sentAt }) => {
  applyEmote(id, type, sentAt);
});

socket.on('voice:participants', (ids) => {
  if (!voiceEnabled || !Array.isArray(ids)) return;
  ids.forEach((id) => {
    if (id !== localPlayerId) ensureVoicePeer(id, String(localPlayerId || '') < String(id));
  });
});

socket.on('voice:user-joined', (id) => {
  if (!voiceEnabled || !id || id === localPlayerId) return;
  ensureVoicePeer(id, String(localPlayerId || '') < String(id));
});

socket.on('voice:user-left', (id) => {
  removeVoicePeer(id);
});

socket.on('voice:offer', async ({ from, offer }) => {
  if (!voiceEnabled || !from || !offer) return;
  const pc = ensureVoicePeer(from, false);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushQueuedIce(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice:answer', { to: from, answer: pc.localDescription });
  } catch {}
});

socket.on('voice:answer', async ({ from, answer }) => {
  const pc = voicePeers.get(from);
  if (!pc || !answer) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushQueuedIce(from, pc);
  } catch {}
});

socket.on('voice:ice', async ({ from, candidate }) => {
  if (!from || !candidate || !voiceEnabled) return;
  const pc = voicePeers.get(from) || ensureVoicePeer(from, false);
  if (!pc) return;
  if (!hasRemoteDescription(pc)) {
    queueVoiceIce(from, candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch {}
});

socket.on('interactableUpdated', (payload) => {
  updateBeaconState(payload);
});

socket.on('chat', ({ fromId, fromName, text, sentAt }) => {
  const resolvedName = fromId ? players.get(fromId)?.name || fromName : fromName;
  appendChatLine({ fromName: resolvedName, text, sentAt, isSystem: fromName === 'System' });
  if (fromId) {
    showChatBubble(fromId, text);
  }
});

function keyToEmote(key) {
  if (key === '1') return 'wave';
  if (key === '2') return 'dance';
  if (key === '3') return 'cheer';
  return null;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!authModalEl.classList.contains('hidden')) return;
    if (!customizeModalEl.classList.contains('hidden')) {
      setCustomizeModal(false);
      return;
    }
    setMenuOpen(!menuOpen);
    return;
  }

  const key = event.key.toLowerCase();
  const typingInInput =
    document.activeElement === chatInputEl ||
    document.activeElement === nameInputEl ||
    document.activeElement === authUsernameEl ||
    document.activeElement === authPasswordEl;

  if (
    key === '/' &&
    isAuthenticated &&
    authModalEl.classList.contains('hidden') &&
    customizeModalEl.classList.contains('hidden') &&
    !typingInInput
  ) {
    event.preventDefault();
    if (menuOpen) setMenuOpen(false);
    setChatPanelOpen(true);
    chatInputEl?.focus();
    return;
  }

  if (
    key === 'f' &&
    !event.repeat &&
    isAuthenticated &&
    authModalEl.classList.contains('hidden') &&
    customizeModalEl.classList.contains('hidden') &&
    !typingInInput
  ) {
    event.preventDefault();
    void toggleFullscreenPointerLock();
    return;
  }

  if (!isAuthenticated || menuOpen || !customizeModalEl.classList.contains('hidden')) return;
  if (typingInInput) return;
  if (key === 'q') {
    emoteWheelOpen = true;
    emoteWheelEl?.classList.remove('hidden');
    return;
  }
  if (key === ' ') {
    event.preventDefault();
  }

  if (key === 'e' && !event.repeat) {
    tryInteract();
  }

  const emote = keyToEmote(key);
  if (emote && !event.repeat) {
    triggerEmote(emote);
  }

  const wantsJump = (key === ' ' || key === 'space') && !event.repeat;
  if (wantsJump) {
    pendingJump = true;
  }

  keys.add(key);
});

window.addEventListener('keyup', (event) => {
  if (!isAuthenticated || menuOpen || !customizeModalEl.classList.contains('hidden')) return;
  const key = event.key.toLowerCase();
  if (key === 'q') {
    emoteWheelOpen = false;
    emoteWheelEl?.classList.add('hidden');
  }
  keys.delete(key);
});

chatFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isAuthenticated) return;
  const text = chatInputEl.value.trim();
  if (!text) return;

  socket.emit('chat', { text });
  chatInputEl.value = '';
  chatInputEl.focus();
});

let previewScene = null;
let previewCamera = null;
let previewRenderer = null;
let previewAvatar = null;
let previewLight = null;
let previewYaw = 0;
let previewAutoSpin = true;
let previewDragging = false;
let previewPointerId = null;
let previewLastX = 0;

function currentFormAppearance() {
  return normalizeAppearance(
    {
      skin: skinInputEl.value,
      shirt: colorInputEl.value,
      pants: pantsColorInputEl.value,
      shoes: shoesColorInputEl.value,
      hairStyle: hairStyleInputEl.value,
      hairColor: hairColorInputEl.value,
      faceStyle: faceStyleInputEl.value,
      accessories: [...selectedAccessories]
    },
    defaultAppearance()
  );
}

function refreshItemCards() {
  itemCards.forEach((card) => {
    const type = card.dataset.type;
    const value = card.dataset.value;
    const selected =
      (type === 'hair' && hairStyleInputEl.value === value) ||
      (type === 'face' && faceStyleInputEl.value === value) ||
      (type === 'accessory' && selectedAccessories.has(value));
    card.classList.toggle('active', selected);
  });
}

function makePreviewMesh(appearance) {
  const mesh = makePlayerMesh(appearance);
  scene.remove(mesh);
  mesh.position.set(0, 0, 0);
  paintPlayer({ mesh }, appearance);
  return mesh;
}

function ensurePreviewScene() {
  if (previewScene) return;
  previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(0x111827);
  previewCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  previewCamera.position.set(0, 2.5, 6.4);
  previewLight = new THREE.DirectionalLight(0xffffff, 1.25);
  previewLight.position.set(5, 8, 7);
  previewScene.add(new THREE.HemisphereLight(0xdbeafe, 0x1f2937, 0.86), previewLight);
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(1.9, 24),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.92 })
  );
  pad.rotation.x = -Math.PI / 2;
  previewScene.add(pad);
  previewRenderer = new THREE.WebGLRenderer({ canvas: customizePreviewEl, antialias: true, alpha: false });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const startDrag = (event) => {
    previewDragging = true;
    previewAutoSpin = false;
    previewPointerId = event.pointerId;
    previewLastX = event.clientX;
    if (customizePreviewEl.setPointerCapture) {
      try {
        customizePreviewEl.setPointerCapture(event.pointerId);
      } catch {}
    }
  };

  const moveDrag = (event) => {
    if (!previewDragging || (previewPointerId !== null && event.pointerId !== previewPointerId)) return;
    const dx = event.clientX - previewLastX;
    previewLastX = event.clientX;
    previewYaw += dx * 0.012;
  };

  const endDrag = (event) => {
    if (previewPointerId !== null && event.pointerId !== previewPointerId) return;
    previewDragging = false;
    previewPointerId = null;
  };

  customizePreviewEl.addEventListener('pointerdown', startDrag);
  customizePreviewEl.addEventListener('pointermove', moveDrag);
  customizePreviewEl.addEventListener('pointerup', endDrag);
  customizePreviewEl.addEventListener('pointercancel', endDrag);
  customizePreviewEl.addEventListener('pointerleave', endDrag);
}

function updatePreviewAvatar() {
  ensurePreviewScene();
  if (previewAvatar) {
    previewScene.remove(previewAvatar);
  }
  previewAvatar = makePreviewMesh(currentFormAppearance());
  previewScene.add(previewAvatar);
}

function renderPreview() {
  if (!previewRenderer || !previewScene || !previewAvatar || customizeModalEl.classList.contains('hidden')) return;
  const width = Math.max(220, customizePreviewEl.clientWidth || customizePreviewEl.width);
  const height = Math.max(220, customizePreviewEl.clientHeight || customizePreviewEl.height);
  previewRenderer.setSize(width, height, false);
  previewCamera.aspect = width / height;
  previewCamera.updateProjectionMatrix();
  if (previewAutoSpin && !previewDragging) {
    previewYaw += 0.012;
  }
  previewAvatar.rotation.y = previewYaw;
  previewRenderer.render(previewScene, previewCamera);
}

itemCards.forEach((card) => {
  card.addEventListener('click', () => {
    const type = card.dataset.type;
    const value = card.dataset.value;
    if (type === 'hair') hairStyleInputEl.value = value;
    if (type === 'face') faceStyleInputEl.value = value;
    if (type === 'accessory') {
      if (selectedAccessories.has(value)) selectedAccessories.delete(value);
      else selectedAccessories.add(value);
    }
    refreshItemCards();
    updatePreviewAvatar();
  });
});

function outfitStorageKey(slot) {
  return `island_outfit_slot_${slot}`;
}

function saveOutfit(slot) {
  const appearance = currentFormAppearance();
  const name = nameInputEl.value.trim().slice(0, 18);
  localStorage.setItem(
    outfitStorageKey(slot),
    JSON.stringify({
      name,
      appearance
    })
  );
  customizeStatusEl.textContent = `Saved outfit slot ${slot}.`;
}

function loadOutfit(slot) {
  const raw = localStorage.getItem(outfitStorageKey(slot));
  if (!raw) {
    customizeStatusEl.textContent = `No outfit in slot ${slot}.`;
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const appearance = normalizeAppearance(parsed.appearance, currentFormAppearance());
    if (parsed.name) nameInputEl.value = String(parsed.name).slice(0, 18);
    skinInputEl.value = appearance.skin;
    colorInputEl.value = appearance.shirt;
    pantsColorInputEl.value = appearance.pants;
    shoesColorInputEl.value = appearance.shoes;
    hairStyleInputEl.value = appearance.hairStyle;
    hairColorInputEl.value = appearance.hairColor;
    faceStyleInputEl.value = appearance.faceStyle;
    selectedAccessories.clear();
    (appearance.accessories || []).forEach((item) => selectedAccessories.add(item));
    refreshItemCards();
    updatePreviewAvatar();
    customizeStatusEl.textContent = `Loaded outfit slot ${slot}.`;
  } catch {
    customizeStatusEl.textContent = `Outfit slot ${slot} is invalid.`;
  }
}

outfitSaveButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const slot = Number(button.dataset.outfitSave);
    if (slot) saveOutfit(slot);
  });
});

outfitLoadButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const slot = Number(button.dataset.outfitLoad);
    if (slot) loadOutfit(slot);
  });
});

[skinInputEl, hairStyleInputEl, hairColorInputEl, faceStyleInputEl, colorInputEl, pantsColorInputEl, shoesColorInputEl].forEach((input) => {
  input.addEventListener('input', () => {
    refreshItemCards();
    updatePreviewAvatar();
  });
  input.addEventListener('change', () => {
    refreshItemCards();
    updatePreviewAvatar();
  });
});

refreshItemCards();

customizeFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const currentLocal = players.get(localPlayerId);
  const name = (nameInputEl.value.trim().slice(0, 18) || currentLocal?.name || '').trim();
  const appearance = normalizeAppearance(
    {
      skin: skinInputEl.value,
      shirt: colorInputEl.value,
      pants: pantsColorInputEl.value,
      shoes: shoesColorInputEl.value,
      hairStyle: hairStyleInputEl.value,
      hairColor: hairColorInputEl.value,
      faceStyle: faceStyleInputEl.value,
      accessories: [...selectedAccessories]
    },
    currentLocal?.appearance || defaultAppearance()
  );
  const color = appearance.shirt;
  if (!name) return;

  applyPlayerCustomization(localPlayerId, name, color, appearance);
  customizeStatusEl.textContent = `Saving ${name}...`;
  if (customizeTimer) {
    clearTimeout(customizeTimer);
  }

  customizeTimer = window.setTimeout(() => {
    customizeStatusEl.textContent = 'Save pending. Check connection.';
  }, 3000);

  socket.emit('customize', { name, color, appearance }, (response) => {
    if (customizeTimer) {
      clearTimeout(customizeTimer);
      customizeTimer = null;
    }
    if (!response?.ok) {
      customizeStatusEl.textContent = 'Save failed. Try again.';
      return;
    }

    applyPlayerCustomization(localPlayerId, response.name, response.color, response.appearance);
    customizeStatusEl.textContent = `Saved as ${response.name}. This is now your spawn avatar.`;
  });
});

function setCustomizeModal(open) {
  if (open && !isAuthenticated) return;
  customizeModalEl.classList.toggle('hidden', !open);
  if (open) {
    setMenuOpen(false);
    refreshItemCards();
    updatePreviewAvatar();
  }
}

async function submitAuth(mode) {
  const username = (authUsernameEl?.value || '').trim().toLowerCase();
  const password = authPasswordEl?.value || '';
  if (!username || !password) {
    if (authStatusEl) authStatusEl.textContent = 'Enter username and password.';
    return;
  }
  if (authStatusEl) authStatusEl.textContent = mode === 'register' ? 'Creating account...' : 'Logging in...';
  socket.emit(mode === 'register' ? 'auth:register' : 'auth:login', { username, password }, (response) => {
    if (!response?.ok) {
      if (authStatusEl) authStatusEl.textContent = response?.error || 'Authentication failed.';
      return;
    }
    localStorage.setItem('island_auth_username', username);
    localStorage.setItem('island_auth_password', password);
    if (authStatusEl) authStatusEl.textContent = `Welcome, ${username}.`;
  });
}

menuToggleEl?.addEventListener('click', () => setMenuOpen(!menuOpen));
chatToggleEl?.addEventListener('click', () => {
  if (!isAuthenticated) return;
  setChatPanelOpen(!chatPanelOpen);
  if (chatPanelOpen) chatInputEl?.focus();
});
voiceQuickToggleEl?.addEventListener('click', async () => {
  if (!isAuthenticated) return;
  await toggleVoiceQuick();
});
fullscreenToggleEl?.addEventListener('click', async () => {
  await toggleFullscreenPointerLock();
});
menuOverlayEl?.addEventListener('click', (event) => {
  if (event.target === menuOverlayEl) setMenuOpen(false);
});
minimapToggleEl?.addEventListener('click', () => {
  setMinimapEnabled(!minimapEnabled);
});
minimapEl?.addEventListener('click', () => {
  if (!minimapEnabled) return;
  setMinimapExpanded(!minimapExpanded);
});
saveQuitEl?.addEventListener('click', () => {
  disableVoice();
  setCustomizeModal(false);
  setMenuOpen(false);
  socket.emit('auth:logout');
  clearSessionWorld();
  setAuthModalOpen(true, 'Progress saved. Login to continue.');
});
authLoginEl?.addEventListener('click', () => submitAuth('login'));
authRegisterEl?.addEventListener('click', () => submitAuth('register'));
authPasswordEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitAuth('login');
  }
});
authUsernameEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitAuth('login');
  }
});

customizeOpenEl?.addEventListener('click', () => {
  setCustomizeModal(true);
});
customizeCloseEl?.addEventListener('click', () => setCustomizeModal(false));
customizeModalEl?.addEventListener('click', (event) => {
  if (event.target === customizeModalEl) setCustomizeModal(false);
});

emoteButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const type = button.dataset.emote;
    if (type) triggerEmote(type);
  });
});

wheelButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const type = button.dataset.wheelEmote;
    if (!type) return;
    triggerEmote(type);
    emoteWheelOpen = false;
    emoteWheelEl?.classList.add('hidden');
  });
});

voiceToggleEl?.addEventListener('click', async () => {
  await toggleVoiceQuick();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyResponsiveLayout();
});

window.addEventListener('beforeunload', () => {
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }
  disableVoice();
});

let joystickId = null;
let joystickX = 0;
let joystickY = 0;

function updateJoystick(event) {
  const rect = joystickEl.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = event.clientX - centerX;
  const dy = event.clientY - centerY;
  const radius = rect.width * 0.38;
  const len = Math.hypot(dx, dy) || 1;
  const scale = len > radius ? radius / len : 1;
  const clampedX = dx * scale;
  const clampedY = dy * scale;

  joystickX = clampedX / radius;
  joystickY = clampedY / radius;

  joystickStickEl.style.left = `${40 + clampedX}px`;
  joystickStickEl.style.top = `${40 + clampedY}px`;
}

function resetJoystick() {
  joystickId = null;
  joystickX = 0;
  joystickY = 0;
  joystickStickEl.style.left = '40px';
  joystickStickEl.style.top = '40px';
}

joystickEl.addEventListener('pointerdown', (event) => {
  joystickId = event.pointerId;
  joystickEl.setPointerCapture(event.pointerId);
  updateJoystick(event);
});

joystickEl.addEventListener('pointermove', (event) => {
  if (event.pointerId !== joystickId) return;
  updateJoystick(event);
});

joystickEl.addEventListener('pointerup', (event) => {
  if (event.pointerId !== joystickId) return;
  joystickEl.releasePointerCapture(event.pointerId);
  resetJoystick();
});

joystickEl.addEventListener('pointercancel', resetJoystick);

mobileJumpEl?.addEventListener('click', () => {
  if (!isAuthenticated || menuOpen || !customizeModalEl.classList.contains('hidden')) return;
  pendingJump = true;
});
mobileUseEl?.addEventListener('click', tryInteract);
mobileEmoteEl?.addEventListener('click', () => {
  if (!isAuthenticated || menuOpen || !customizeModalEl.classList.contains('hidden')) return;
  triggerEmote('dance');
});

let lastSentAt = 0;
const WALK_SPEED = 12;
const SPRINT_MULTIPLIER = 1.58;
const GROUND_Y = 1.35;
const GRAVITY = 30;
const JUMP_VELOCITY = 11;
const SEND_EVERY_MS = 45;
const TURN_SPEED = 14;
const REMOTE_TURN_SPEED = 10;
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 25;
const STAMINA_REGEN = 18;
const SLIDE_DURATION = 0.42;
const SLIDE_SPEED = 20;
let stamina = STAMINA_MAX;
let slideUntil = 0;
let slideDirX = 0;
let slideDirZ = 0;

const CAMERA_PITCH_MIN = 0.2;
const CAMERA_PITCH_MAX = 1.18;
const CAMERA_DIST_MIN = 8;
const CAMERA_DIST_MAX = 30;
const CAMERA_DIST_START = 17;
let cameraYaw = 0;
let cameraPitch = 0.58;
let cameraDistance = CAMERA_DIST_START;
let cameraDistanceTarget = CAMERA_DIST_START;
let isOrbiting = false;
let orbitPointerId = null;
let lastPointerX = 0;
let lastPointerY = 0;

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (pointerLocked) return;
  if (event.button !== 0) return;
  isOrbiting = true;
  orbitPointerId = event.pointerId;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (pointerLocked) {
    cameraYaw -= (event.movementX || 0) * 0.0038;
    cameraPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, cameraPitch - (event.movementY || 0) * 0.0038));
    return;
  }
  if (!isOrbiting || event.pointerId !== orbitPointerId) return;
  const dx = event.clientX - lastPointerX;
  const dy = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;

  cameraYaw -= dx * 0.005;
  cameraPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, cameraPitch - dy * 0.005));
});

function endOrbit(event) {
  if (pointerLocked) return;
  if (!isOrbiting || event.pointerId !== orbitPointerId) return;
  isOrbiting = false;
  orbitPointerId = null;
  renderer.domElement.releasePointerCapture(event.pointerId);
}

renderer.domElement.addEventListener('pointerup', endOrbit);
renderer.domElement.addEventListener('pointercancel', endOrbit);
renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    cameraDistanceTarget = Math.max(
      CAMERA_DIST_MIN,
      Math.min(CAMERA_DIST_MAX, cameraDistanceTarget + event.deltaY * 0.01)
    );
  },
  { passive: false }
);

let dayTime = 0.23;
let rainActive = false;
let nextWeatherToggleAt = 15;
// Pre-allocated color objects — avoids new THREE.Color() every frame
const _skyColor = new THREE.Color();
const _fogColor = new THREE.Color();

function updateDayAndWeather(delta, nowSeconds) {
  dayTime = (dayTime + delta / 240) % 1;
  const sunAngle = dayTime * Math.PI * 2;
  const dayFactor = Math.max(0.08, Math.sin(sunAngle) * 0.65 + 0.5);

  sun.intensity = 0.25 + dayFactor * 1.0;
  hemi.intensity = 0.32 + dayFactor * 0.8;
  sun.position.set(Math.cos(sunAngle) * 40, 16 + dayFactor * 26, Math.sin(sunAngle) * 40);

  _skyColor.setHSL(0.56, 0.45, 0.14 + dayFactor * 0.53);
  _fogColor.setHSL(0.56, 0.35, 0.11 + dayFactor * 0.42);
  scene.fog.color.copy(_fogColor);
  renderer.setClearColor(_skyColor);

  if (nowSeconds > nextWeatherToggleAt) {
    rainActive = Math.random() > 0.55;
    nextWeatherToggleAt = nowSeconds + 22 + Math.random() * 16;
  }

  rain.visible = rainActive;
  weatherLabelEl.textContent = rainActive ? 'Rain' : 'Clear';

  if (rainActive) {
    const attr = rainGeometry.attributes.position;
    // Only iterate particles when rain is actually visible
    for (let i = 0; i < rainCount; i += 1) {
      const idx = i * 3;
      attr.array[idx + 1] -= delta * 22;
      if (attr.array[idx + 1] < 0.5) {
        attr.array[idx + 1] = 30 + Math.random() * 10;
      }
    }
    attr.needsUpdate = true;
  }

  if (dayTime < 0.2 || dayTime > 0.85) {
    timeLabelEl.textContent = 'Night';
  } else if (dayTime < 0.32) {
    timeLabelEl.textContent = 'Morning';
  } else if (dayTime < 0.62) {
    timeLabelEl.textContent = 'Day';
  } else {
    timeLabelEl.textContent = 'Evening';
  }
}

function movementInput() {
  let x = 0;
  let z = 0;

  if (keys.has('w') || keys.has('arrowup')) z -= 1;
  if (keys.has('s') || keys.has('arrowdown')) z += 1;
  if (keys.has('a') || keys.has('arrowleft')) x -= 1;
  if (keys.has('d') || keys.has('arrowright')) x += 1;

  x += joystickX;
  z += joystickY;

  return { x, z };
}

function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function rotatePlayerTowards(player, targetYaw, delta, speed) {
  if (!player?.mesh) return;
  const current = Number.isFinite(player.facingYaw) ? player.facingYaw : player.mesh.rotation.y;
  const target = normalizeAngle(targetYaw);
  const diff = normalizeAngle(target - current);
  const t = Math.min(1, delta * speed);
  const next = normalizeAngle(current + diff * t);
  player.facingYaw = next;
  player.mesh.rotation.y = next;
}

function updateLocalPlayer(delta, nowMs) {
  if (!isAuthenticated || menuOpen || !customizeModalEl.classList.contains('hidden')) return;
  const local = players.get(localPlayerId);
  if (!local) return;

  const prevX = local.x;
  const prevY = local.y;
  const prevZ = local.z;

  if (boatState.onboard && boatState.mesh) {
    const throttle = (keys.has('w') || keys.has('arrowup') ? 1 : 0) + (keys.has('s') || keys.has('arrowdown') ? -0.55 : 0);
    const steer = (keys.has('a') || keys.has('arrowleft') ? 1 : 0) + (keys.has('d') || keys.has('arrowright') ? -1 : 0);
    boatState.yaw += steer * delta * 1.9;
    boatState.speed = THREE.MathUtils.lerp(boatState.speed, throttle * 10.5, Math.min(1, delta * 3.5));
    boatState.x += Math.sin(boatState.yaw) * boatState.speed * delta;
    boatState.z += Math.cos(boatState.yaw) * boatState.speed * delta;
    const shore = resolveBoatShoreCollision(boatState.x, boatState.z);
    boatState.x = shore.x;
    boatState.z = shore.z;
    if (shore.collided) {
      boatState.speed *= 0.55;
    }
    const travelLimit = worldLimit * 2.9;
    boatState.x = THREE.MathUtils.clamp(boatState.x, -travelLimit, travelLimit);
    boatState.z = THREE.MathUtils.clamp(boatState.z, -travelLimit, travelLimit);
    boatState.paddlePhase += delta * (3.2 + Math.abs(boatState.speed) * 0.45);
    const rowStrength = Math.min(1, Math.abs(boatState.speed) / 8);
    const stroke = Math.sin(boatState.paddlePhase) * rowStrength;
    if (boatState.paddleLeftPivot && boatState.paddleRightPivot) {
      boatState.paddleLeftPivot.rotation.x = -0.35 + stroke * 0.75;
      boatState.paddleRightPivot.rotation.x = -0.35 - stroke * 0.75;
      boatState.paddleLeftPivot.rotation.z = -0.2 + stroke * 0.18;
      boatState.paddleRightPivot.rotation.z = 0.2 - stroke * 0.18;
    }
    boatState.mesh.position.set(boatState.x, boatState.y + Math.sin(nowMs * 0.002) * 0.05, boatState.z);
    boatState.mesh.rotation.y = boatState.yaw;
    const seatForward = -0.12;
    const seatRight = 0;
    const fX = Math.sin(boatState.yaw);
    const fZ = Math.cos(boatState.yaw);
    const rX = Math.cos(boatState.yaw);
    const rZ = -Math.sin(boatState.yaw);
    local.x = boatState.x + fX * seatForward + rX * seatRight;
    local.y = boatState.y - 0.06;
    local.z = boatState.z + fZ * seatForward + rZ * seatRight;
    local.vy = 0;
    local.targetYaw = boatState.yaw;
    local.facingYaw = boatState.yaw;
    local.mesh.position.set(local.x, local.y, local.z);
    local.mesh.rotation.y = boatState.yaw;
    local.animSpeed = Math.min(1, Math.abs(boatState.speed) / 10);

    if (staminaFillEl) {
      stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN * delta);
      const pct = Math.round((stamina / STAMINA_MAX) * 100);
      staminaFillEl.style.width = `${pct}%`;
    }
    return;
  }
  applyLocalSurfaceState(local);
  const activeFloorY = floorYForLocal(local);
  const isGrounded = local.y <= activeFloorY + 0.05;
  const sprintHeld = keys.has('shift');
  const wantsSlide = keys.has('c');

  const input = movementInput();
  let hasMoveInput = false;
  const isSliding = nowMs < slideUntil;

  if (canSlideNow(local, wantsSlide, isGrounded, isSliding, input)) {
    const len = Math.hypot(input.x, input.z) || 1;
    const normalizedX = input.x / len;
    const normalizedZ = input.z / len;
    const forwardScale = -normalizedZ;
    slideDirX = normalizedX * Math.cos(cameraYaw) + forwardScale * -Math.sin(cameraYaw);
    slideDirZ = normalizedX * -Math.sin(cameraYaw) + forwardScale * -Math.cos(cameraYaw);
    const dirLen = Math.hypot(slideDirX, slideDirZ) || 1;
    slideDirX /= dirLen;
    slideDirZ /= dirLen;
    slideUntil = nowMs + SLIDE_DURATION * 1000;
  }

  let speed = movementSpeedForState(local);
  if (Math.abs(input.x) > 0.0001 || Math.abs(input.z) > 0.0001) {
    hasMoveInput = true;
    const len = Math.hypot(input.x, input.z) || 1;
    const normalizedX = input.x / len;
    const normalizedZ = input.z / len;
    const forwardScale = -normalizedZ;

    const worldX = normalizedX * Math.cos(cameraYaw) + forwardScale * -Math.sin(cameraYaw);
    const worldZ = normalizedX * -Math.sin(cameraYaw) + forwardScale * -Math.cos(cameraYaw);
    const canSprint = canSprintNow(local, sprintHeld, stamina, isSliding);
    if (canSprint) {
      speed *= SPRINT_MULTIPLIER;
      stamina = Math.max(0, stamina - STAMINA_DRAIN * delta);
    } else {
      stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN * delta * 0.75);
    }
    local.x += worldX * speed * delta;
    local.z += worldZ * speed * delta;
    local.targetYaw = Math.atan2(worldX, worldZ);
  } else {
    stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN * delta);
  }

  if (runSlideAllowed(local, isSliding)) {
    const slideT = Math.max(0, (slideUntil - nowMs) / (SLIDE_DURATION * 1000));
    const slideSpeed = SLIDE_SPEED * slideT;
    local.x += slideDirX * slideSpeed * delta;
    local.z += slideDirZ * slideSpeed * delta;
    local.targetYaw = Math.atan2(slideDirX, slideDirZ);
    hasMoveInput = true;
    stamina = Math.max(0, stamina - STAMINA_DRAIN * delta * 0.5 * slideDrainMultiplier(local));

  }
  localStepMovementEnd(local, delta, nowMs, prevY);
  playerSpeedFromDelta(local, prevX, prevZ, delta, local.x, local.z);

  local.mesh.position.set(local.x, local.y, local.z);
  if (hasMoveInput) {
    rotatePlayerTowards(local, local.targetYaw ?? 0, delta, TURN_SPEED);
  } else {
    rotatePlayerTowards(local, local.targetYaw ?? local.facingYaw ?? 0, delta, TURN_SPEED * 0.65);
  }
  if (staminaFillEl) {
    const pct = Math.round((stamina / STAMINA_MAX) * 100);
    staminaFillEl.style.width = `${pct}%`;
  }

  if (nowMs - lastSentAt >= SEND_EVERY_MS) {
    const inServerSyncRange = inSwimSyncRange(local);
    const changed =
      Math.abs(local.x - prevX) > 0.01 ||
      Math.abs(local.y - prevY) > 0.01 ||
      Math.abs(local.z - prevZ) > 0.01;
    if (changed && inServerSyncRange) {
      socket.emit('move', { x: local.x, y: local.y, z: local.z });
      lastSentAt = nowMs;
    }
  }
}

function updateRemotePlayers(delta) {
  players.forEach((player, id) => {
    if (id === localPlayerId) return;
    const prevX = player.mesh.position.x;
    const prevZ = player.mesh.position.z;
    player.mesh.position.x += (player.x - player.mesh.position.x) * Math.min(1, delta * 12);
    player.mesh.position.y += ((player.y ?? GROUND_Y) - player.mesh.position.y) * Math.min(1, delta * 14);
    player.mesh.position.z += (player.z - player.mesh.position.z) * Math.min(1, delta * 12);
    const dx = player.mesh.position.x - prevX;
    const dz = player.mesh.position.z - prevZ;
    if (Math.hypot(dx, dz) > 0.0015) {
      player.targetYaw = Math.atan2(dx, dz);
    }
    finalizeRemoteMovement(player);
    rotatePlayerTowards(player, player.targetYaw ?? player.facingYaw ?? 0, delta, REMOTE_TURN_SPEED);
    playerSpeedFromDelta(player, prevX, prevZ, delta);
  });
}

function playerSpeedFromDelta(player, prevX, prevZ, delta, currentX, currentZ) {
  if (!player || delta <= 0) return;
  const nextX = Number.isFinite(currentX) ? currentX : player.mesh.position.x;
  const nextZ = Number.isFinite(currentZ) ? currentZ : player.mesh.position.z;
  const distance = Math.hypot(nextX - prevX, nextZ - prevZ);
  const speed = distance / delta;
  player.animSpeed = THREE.MathUtils.clamp(speed / 8, 0, 1);
}

function updateNameTags() {
  const viewportX = window.innerWidth * 0.5;
  const viewportY = window.innerHeight * 0.5;
  const now = Date.now();
  const TAG_WORLD_OFFSET_Y = 3.25;
  const BUBBLE_PIXEL_GAP = 30;

  players.forEach((player) => {
    if (!player.label) return;

    const position = player.mesh.position.clone();
    position.y += TAG_WORLD_OFFSET_Y;
    position.project(camera);

    const isVisible =
      position.z > -1 &&
      position.z < 1 &&
      Math.abs(position.x) < 1.2 &&
      Math.abs(position.y) < 1.2;

    if (!isVisible) {
      player.label.style.display = 'none';
      if (player.bubble) {
        player.bubble.style.display = 'none';
      }
      return;
    }

    player.label.style.display = 'block';
    player.label.style.left = `${position.x * viewportX + viewportX}px`;
    player.label.style.top = `${-position.y * viewportY + viewportY}px`;

    if (!player.bubble) return;
    if (now > player.bubbleUntil) {
      player.bubble.style.display = 'none';
      return;
    }

    const msLeft = player.bubbleUntil - now;
    const alpha = Math.max(0, Math.min(1, msLeft / CHAT_BUBBLE_MS));
    player.bubble.style.display = 'block';
    player.bubble.style.opacity = `${alpha}`;
    player.bubble.style.left = `${position.x * viewportX + viewportX}px`;
    player.bubble.style.top = `${-position.y * viewportY + viewportY - BUBBLE_PIXEL_GAP}px`;
  });
}

function updateInteractionHint() {
  const local = players.get(localPlayerId);
  if (!local) {
    interactHintEl.textContent = 'Explore the island';
    return;
  }

  if (boatState.onboard) {
    interactHintEl.textContent = 'Boat controls: W/S move, A/D steer, E to get off anywhere';
    return;
  }
  const swimHint = surfaceHintOverride(local);
  if (swimHint) {
    interactHintEl.textContent = swimHint;
    return;
  }
  if (inLighthouseInterior) {
    if (distance2D(local, INTERIOR_EXIT_PORTAL_POS) < 3.1) {
      interactHintEl.textContent = 'Press E on the glowing marker to go to lighthouse top';
      return;
    }
    interactHintEl.textContent = 'Climb the stairs to the glowing marker at the top';
    return;
  }
  if (distance2D(local, LIGHTHOUSE_TOP_POS) < 3 && local.y > 11.6) {
    interactHintEl.textContent = 'Press E on portal to go back inside lighthouse';
    return;
  }
  if (distance2D(local, LIGHTHOUSE_DOOR_POS) < 5.2 || distance2D(local, LIGHTHOUSE_POS) < 8.6) {
    interactHintEl.textContent = 'Press E to enter lighthouse';
    return;
  }
  if (distance2D(local, ISLAND_DOCK_POS) < 6 || distance2D(local, LIGHTHOUSE_DOCK_POS) < 6) {
    interactHintEl.textContent = 'Press E to board boat';
    return;
  }
  const beacon = interactables.get('beacon');
  if (beacon && Math.hypot(local.x - beacon.x, local.z - beacon.z) <= 4.2) {
    interactHintEl.textContent = 'Press E to toggle beacon';
    return;
  }
  interactHintEl.textContent = 'Use dock boat to reach lighthouse';
}

function headingText() {
  const degrees = ((THREE.MathUtils.radToDeg(cameraYaw) % 360) + 360) % 360;
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(degrees / 45) % 8;
  return `${labels[index]} (${Math.round(degrees)}deg)`;
}

function drawMinimap() {
  if (!minimapEnabled || !minimapEl || !minimapCtx) return;
  const size = minimapEl.width;
  const center = size / 2;
  const radius = center - 8;

  minimapCtx.clearRect(0, 0, size, size);
  minimapCtx.fillStyle = '#1f4564';
  minimapCtx.beginPath();
  minimapCtx.arc(center, center, radius + 2, 0, Math.PI * 2);
  minimapCtx.fill();

  minimapCtx.fillStyle = '#638852';
  minimapCtx.beginPath();
  minimapCtx.arc(center, center, radius * 0.72, 0, Math.PI * 2);
  minimapCtx.fill();

  minimapCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  minimapCtx.lineWidth = 1;
  minimapCtx.beginPath();
  minimapCtx.arc(center, center, radius * 0.72, 0, Math.PI * 2);
  minimapCtx.stroke();

  const scale = (radius * 0.72) / worldLimit;

  const beacon = interactables.get('beacon');
  if (beacon) {
    minimapCtx.fillStyle = beacon.active ? '#fbbf24' : '#38bdf8';
    minimapCtx.beginPath();
    minimapCtx.arc(center + beacon.x * scale, center + beacon.z * scale, 4, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  minimapCtx.fillStyle = '#f97316';
  minimapCtx.beginPath();
  minimapCtx.arc(center + ISLAND_DOCK_POS.x * scale, center + ISLAND_DOCK_POS.z * scale, 3, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.beginPath();
  minimapCtx.arc(center + LIGHTHOUSE_DOCK_POS.x * scale, center + LIGHTHOUSE_DOCK_POS.z * scale, 3, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.fillStyle = '#f8fafc';
  minimapCtx.beginPath();
  minimapCtx.arc(center + LIGHTHOUSE_POS.x * scale, center + LIGHTHOUSE_POS.z * scale, 4, 0, Math.PI * 2);
  minimapCtx.fill();

  if (boatState.mesh) {
    minimapCtx.fillStyle = '#a16207';
    minimapCtx.beginPath();
    minimapCtx.arc(center + boatState.x * scale, center + boatState.z * scale, 3, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  players.forEach((player, id) => {
    minimapCtx.fillStyle = id === localPlayerId ? '#ffd166' : '#f8fafc';
    minimapCtx.beginPath();
    minimapCtx.arc(center + player.x * scale, center + player.z * scale, id === localPlayerId ? 4 : 3, 0, Math.PI * 2);
    minimapCtx.fill();
  });

  compassEl.textContent = `Heading: ${headingText()}`;
}

const clock = new THREE.Clock();
// Throttle timestamps for expensive per-frame operations
let _lastMinimapDraw = 0;
let _lastNameTagUpdate = 0;
function animate(nowMs) {
  const delta = clock.getDelta();
  const nowSeconds = nowMs / 1000;

  updateDayAndWeather(delta, nowSeconds);
  beaconCore.rotation.y += delta * 1.2;

  const beacon = interactables.get('beacon');
  if (beacon?.active) {
    beaconCore.position.y = 3.0 + Math.sin(nowMs * 0.004) * 0.12;
  } else {
    beaconCore.position.y += (3.0 - beaconCore.position.y) * Math.min(1, delta * 8);
  }
  if (lighthouseInteriorPortal) {
    lighthouseInteriorPortal.rotation.y += delta * 0.7;
    lighthouseInteriorPortal.position.y = INTERIOR_EXIT_PORTAL_POS.y + Math.sin(nowMs * 0.0042) * 0.08;
  }
  if (lighthouseTopPortal) {
    lighthouseTopPortal.rotation.y += delta * 0.9;
    lighthouseTopPortal.position.y = 13.23 + Math.sin(nowMs * 0.005) * 0.06;
  }

  updateLocalPlayer(delta, nowMs);
  updateRemotePlayers(delta);
  updateInteractionHint();
  updatePlayerEmotes(Date.now(), delta);
  updateVoiceVolumes();

  const local = players.get(localPlayerId);
  if (local) {
    const activeCameraTarget = inLighthouseInterior ? Math.min(cameraDistanceTarget, 10.5) : cameraDistanceTarget;
    cameraDistance += (activeCameraTarget - cameraDistance) * Math.min(1, delta * 10);
    if (inLighthouseInterior) {
      cameraDistance = Math.min(cameraDistance, 10.5);
      cameraDistanceTarget = activeCameraTarget;
    }

    const horizontal = Math.cos(cameraPitch) * cameraDistance;
    const offsetX = Math.sin(cameraYaw) * horizontal;
    const offsetY = Math.sin(cameraPitch) * cameraDistance;
    const offsetZ = Math.cos(cameraYaw) * horizontal;
    let desiredX = local.x + offsetX;
    const headTrackY = local.y + (local.isSwimming ? 1.15 : 1.78);
    const desiredY = headTrackY + offsetY;
    let desiredZ = local.z + offsetZ;
    if (inLighthouseInterior) {
      const camRadius = INTERIOR_PLAY_RADIUS - 1.35;
      const cdx = desiredX - LIGHTHOUSE_INTERIOR_BASE.x;
      const cdz = desiredZ - LIGHTHOUSE_INTERIOR_BASE.z;
      const clen = Math.hypot(cdx, cdz);
      if (clen > camRadius) {
        const scale = camRadius / (clen || 1);
        desiredX = LIGHTHOUSE_INTERIOR_BASE.x + cdx * scale;
        desiredZ = LIGHTHOUSE_INTERIOR_BASE.z + cdz * scale;
      }
    }

    camera.position.x += (desiredX - camera.position.x) * Math.min(1, delta * 10);
    camera.position.y += (desiredY - camera.position.y) * Math.min(1, delta * 10);
    camera.position.z += (desiredZ - camera.position.z) * Math.min(1, delta * 10);
    camera.lookAt(local.x, headTrackY - (local.isSwimming ? 0.2 : 0.05), local.z);
  }

  // Name tags: update at most every 50 ms
  if (nowMs - _lastNameTagUpdate >= 50) {
    updateNameTags();
    _lastNameTagUpdate = nowMs;
  }
  // Minimap: redraw at most every 100 ms
  if (nowMs - _lastMinimapDraw >= 100) {
    drawMinimap();
    _lastMinimapDraw = nowMs;
  }
  renderer.render(scene, camera);
  renderPreview();
  requestAnimationFrame(animate);
}

updateHud();
requestAnimationFrame(animate);