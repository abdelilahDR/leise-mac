const {
  app,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  BrowserWindow,
  ipcMain,
  Notification,
  clipboard,
  systemPreferences,
  screen,
  powerMonitor,
  session,
  shell,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { PRODUCT_NAME } = require('./product');
const { exec } = require('child_process');

// ============================================
// Startup banner — if you do NOT see this on `npm start`, you are running the
// wrong directory or the installed app is intercepting things.
// ============================================
console.log('═══════════════════════════════════════════════');
console.log(`  ${PRODUCT_NAME} DEV — diagnostic build  ` + new Date().toISOString());
console.log('  cwd:', process.cwd());
console.log('  __dirname:', __dirname);
console.log('═══════════════════════════════════════════════');

// ============================================
// Sound Feedback
// ============================================

function playSound(soundName) {
  if (config && config.soundsEnabled === false) return;
  // Play macOS system sounds (non-blocking)
  const soundPath = `/System/Library/Sounds/${soundName}.aiff`;
  exec(`afplay "${soundPath}"`, (error) => {
    if (error) {
      console.log('Sound playback failed:', error.message);
    }
  });
}

// ============================================
// Configuration Management
// ============================================

// One-time migration from the app's previous name: if this userData is
// fresh and a legacy dir exists, carry config and history over. Encrypted
// keys cannot survive the rename (safeStorage is keyed to the app name),
// so the key is re-entered once in Settings.
(function migrateLegacyUserData() {
  try {
    if (process.env.LEISE_ONBOARD_TEST || process.env.LEISE_FRESH || process.env.LEISE_DEMO) return; // fresh-install simulations

    const fresh = !fs.existsSync(path.join(app.getPath('userData'), 'config.json'));
    if (!fresh) return;
    const appSupport = path.dirname(app.getPath('userData'));
    for (const legacy of ['whisp', 'Whisp']) {
      const oldDir = path.join(appSupport, legacy);
      const oldConfig = path.join(oldDir, 'config.json');
      if (fs.existsSync(oldConfig)) {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.copyFileSync(oldConfig, path.join(app.getPath('userData'), 'config.json'));
        const oldHistory = path.join(oldDir, 'history.json');
        if (fs.existsSync(oldHistory)) {
          fs.copyFileSync(oldHistory, path.join(app.getPath('userData'), 'history.json'));
        }
        console.log('[main] migrated userData from', oldDir);
        return;
      }
    }
  } catch (err) {
    console.error('[main] legacy userData migration failed:', err);
  }
})();

// Test probes get an isolated userData; this must run before configPath is
// derived from it.
if (process.env.LEISE_FOCUS_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-focus-test'));
}
if (process.env.LEISE_ONBOARD_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-onboard-test-' + process.pid));
}
// LEISE_FRESH: interactive fresh-install demo — isolated userData, no legacy
// migration, otherwise the real app.
if (process.env.LEISE_FRESH) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-fresh-demo'));
}
// LEISE_DEMO: the end-to-end test environment. Every launch is a first launch —
// the userData directory is wiped, so onboarding always runs from the top. The
// gates that block a walkthrough are opened (permissions, key validation); the
// product itself — recording, transcription, insertion — is untouched.
const DEMO = !!process.env.LEISE_DEMO;
if (DEMO) {
  const dir = path.join(app.getPath('temp'), 'leise-demo');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* first run */ }
  app.setPath('userData', dir);
}
if (process.env.LEISE_AUTOSTOP_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-autostop-test-' + process.pid));
}
if (process.env.LEISE_MENUBAR_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-menubar-test-' + process.pid));
}
if (process.env.LEISE_RETRY_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-retry-test-' + process.pid));
}
if (process.env.LEISE_CLEANUP_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'leise-cleanup-test-' + process.pid));
}
// Fixed dir (no pid): the relaunched child must land in the same userData so
// the runner can read its report. Seeded as onboarded so the launch is the
// steady-state one and the relaunch logic is reachable.
if (process.env.LEISE_RELAUNCH_TEST) {
  const dir = path.join(app.getPath('temp'), 'leise-relaunch-test');
  app.setPath('userData', dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      onboardingComplete: true, transcriptionProvider: 'groq', groqApiKey: 'probe-key',
    }));
  } catch (e) {
    console.error('[relaunch-test] seed failed:', e);
  }
}

const configPath = path.join(app.getPath('userData'), 'config.json');
const historyPath = path.join(app.getPath('userData'), 'history.json');
const HISTORY_MAX = 20;

// API keys are encrypted at rest via Electron safeStorage (macOS Keychain
// holds the encryption key). In memory config keeps plaintext for use; on
// disk only apiKeyEnc/groqApiKeyEnc appear. Plaintext keys from older
// versions migrate to encrypted on the first save.
const KEY_FIELDS = ['apiKey', 'groqApiKey'];

function encryptKey(value) {
  const { safeStorage } = require('electron');
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64');
    }
  } catch (err) {
    console.error('encryptKey failed:', err);
  }
  return null; // encryption unavailable — caller keeps plaintext
}

function decryptKey(enc) {
  const { safeStorage } = require('electron');
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (err) {
    console.error('decryptKey failed:', err);
    return '';
  }
}

const CONFIG_DEFAULTS = {
  apiKey: '',
  groqApiKey: '',
  transcriptionProvider: 'groq',
  // Demo runs alongside the installed app, which already holds Control+Space;
  // a second registration silently fails and recording would never start.
  shortcut: process.env.LEISE_DEMO ? 'Control+Alt+Space' : 'Control+Space',
  soundsEnabled: true,
  autoPasteEnabled: true,
  autoStopEnabled: false, // stop recording on sustained silence after speech
  cleanupEnabled: false, // LLM pass: collapse repeats, apply spoken corrections, strip filler
  preferredInputDeviceId: '',
  // system | light | dark, drives nativeTheme.themeSource. Demo can start in a
  // given mode so both can be checked without touching System Settings.
  appearance: (process.env.LEISE_DEMO && process.env.LEISE_DEMO_THEME) || 'system',
  customVocabulary: '', // names and jargon, passed to Whisper as a spelling hint
};

function applyAppearance() {
  const value = ['light', 'dark'].includes(config.appearance) ? config.appearance : 'system';
  nativeTheme.themeSource = value;
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      // Enc fields stay raw here: safeStorage only works after app ready,
      // and this runs at module load. hydrateKeys() decrypts them.
      return { ...CONFIG_DEFAULTS, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  return { ...CONFIG_DEFAULTS };
}

// The key that actually matters is the active provider's key — a Groq-only
// setup is fully valid (and the default).
// Demo only. Onboarding accepts whatever is typed so the flow is never
// blocked, but the transcription call still needs a key that works — otherwise
// the first recording comes back "Invalid API Key". Prefer LEISE_DEMO_KEY, else
// borrow the installed app's key: same app identity, so safeStorage decrypts it.
let demoKeyCache = null;
function demoRealKeys() {
  if (!DEMO) return {};
  if (demoKeyCache) return demoKeyCache;
  const out = {};
  if (process.env.LEISE_DEMO_KEY) {
    out.apiKey = process.env.LEISE_DEMO_KEY;
    out.groqApiKey = process.env.LEISE_DEMO_KEY;
  } else {
    try {
      const installed = path.join(app.getPath('appData'), PRODUCT_NAME, 'config.json');
      const raw = JSON.parse(fs.readFileSync(installed, 'utf8'));
      for (const f of KEY_FIELDS) {
        const dec = raw[f + 'Enc'] ? decryptKey(raw[f + 'Enc']) : raw[f];
        if (dec) out[f] = dec;
      }
    } catch (err) {
      console.log('[demo] no installed key to borrow:', err.message);
    }
  }
  demoKeyCache = out;
  return out;
}

// The key the app should actually transcribe with.
function effectiveKey(field) {
  if (!DEMO) return config[field];
  return demoRealKeys()[field] || config[field];
}

function hasActiveKey() {
  return (config.transcriptionProvider === 'openai')
    ? !!effectiveKey('apiKey') : !!effectiveKey('groqApiKey');
}

function saveConfig(newConfig) {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const onDisk = { ...newConfig };
    for (const field of KEY_FIELDS) {
      const enc = encryptKey(onDisk[field]);
      if (enc !== null) {
        // A fresh key replaces any stale ciphertext; without one, a stale
        // blob already in memory rides along untouched.
        if (enc) onDisk[field + 'Enc'] = enc;
        delete onDisk[field];
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save config:', err);
    return false;
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(historyPath)) {
      const data = fs.readFileSync(historyPath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('Failed to load history:', err);
  }
  return [];
}

function saveHistory(history) {
  try {
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save history:', err);
    return false;
  }
}

function appendToHistory(text, source) {
  const trimmed = text && text.trim();
  if (!trimmed) return;
  const history = loadHistory();
  history.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    text: trimmed,
    timestamp: Date.now(),
    source,
  });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  saveHistory(history);
}

function clearHistory() {
  saveHistory([]);
}

let config = loadConfig();

// Runs once app is ready (safeStorage needs that): decrypt stored keys into
// memory, and if the file still holds plaintext keys, re-save to migrate.
function hydrateKeys() {
  let hadPlaintext = false;
  for (const field of KEY_FIELDS) {
    if (config[field]) hadPlaintext = true;
    const enc = config[field + 'Enc'];
    if (enc && !config[field]) {
      const dec = decryptKey(enc);
      if (dec) {
        config[field] = dec;
        delete config[field + 'Enc'];
      }
      // Decryption failed (for example after an app rename, when the
      // Keychain service no longer matches). Keep the ciphertext in memory
      // so later saves preserve it on disk instead of destroying it.
    } else if (enc) {
      delete config[field + 'Enc'];
    }
  }
  if (hadPlaintext && (config.apiKey || config.groqApiKey)) saveConfig(config);
}

// ============================================
// Global State
// ============================================

let tray = null;
let recorderWindow = null;
let overlayWindow = null;
let settingsWindow = null;
let onboardingWindow = null;
let pointerWindow = null;
let pointerTimer = null;
let pointerAnchor = null;
let isRecording = false;
let recordingStartedAt = 0;
let isTestRecording = false;
let escapeRegistered = false;
let enterRegistered = false;
let overlayHideTimer = null;
let wasCancelled = false;
let userDismissed = false;
let watchdogTimer = null;

// Counts how many transcriptions in a row have failed (watchdog fire or
// transcription-error). On the 2nd consecutive failure we proactively recycle
// the recorder window — catches degraded states where each call almost
// completes but never returns clean. Reset to 0 on any successful result.
let consecutiveFailures = 0;
const FAILURE_RECYCLE_THRESHOLD = 2;

// Rolling buffer of last N transcription latencies (ms). Used for the
// "Performance" line in the tray menu and to spot Groq variance.
const PERF_BUFFER_SIZE = 20;
const perfBuffer = [];

function recordPerf(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !isFinite(elapsedMs)) return;
  perfBuffer.push(elapsedMs);
  if (perfBuffer.length > PERF_BUFFER_SIZE) perfBuffer.shift();
}

function getPerfStats() {
  if (perfBuffer.length === 0) return null;
  const sorted = [...perfBuffer].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / sorted.length);
  // p95 with floor on small samples
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[p95Index];
  const last = perfBuffer[perfBuffer.length - 1];
  return { avg, p95, last, n: sorted.length };
}

// Destroy + recreate the hidden recorder BrowserWindow. The recorder
// renderer is the long-lived process that holds AudioContext, MediaRecorder,
// Chromium's fetch connection pool, and the mic device handle. After enough
// time / Mac sleep / network state churn it can wedge in ways no app-level
// reset can recover (this is the "have to restart Whisp every few hours"
// symptom). Recycling the BrowserWindow gives us a brand-new renderer
// process — equivalent to an app restart for the part that matters, but
// transparent to the user.
function recycleRecorderWindow(reason) {
  const oldPid = (recorderWindow && !recorderWindow.isDestroyed())
    ? recorderWindow.webContents.getOSProcessId()
    : null;
  console.warn(`[main] recycleRecorderWindow reason="${reason}" oldPid=${oldPid}`);
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    try { recorderWindow.destroy(); } catch (e) { console.error('destroy failed:', e); }
  }
  recorderWindow = null;
  createRecorderWindow();
  // Recreating the renderer alone does not touch the shared NetworkService —
  // flush its stale sockets/DNS too, or the new renderer inherits the wedge.
  flushNetworkStack(`recycle: ${reason}`);
  const newPid = recorderWindow && recorderWindow.webContents.getOSProcessId();
  console.warn(`[main] recycleRecorderWindow done newPid=${newPid}`);
  consecutiveFailures = 0;
}

// Drop Chromium's shared socket pool + DNS cache. Recycling the recorder
// BrowserWindow gives us a fresh renderer, but the NetworkService that holds
// the fetch connection pool and host-resolver cache is SHARED and survives the
// recycle. After a network change (e.g. Wi-Fi → iPhone hotspot) those stale
// sockets/DNS entries point at a dead route and every fetch hangs until a full
// app quit. Flushing them here is what actually clears that wedge.
function flushNetworkStack(reason) {
  console.warn(`[main] flushNetworkStack (${reason})`);
  try {
    session.defaultSession.closeAllConnections();
    session.defaultSession.clearHostResolverCache();
  } catch (e) {
    console.error('[main] flushNetworkStack failed:', e);
  }
}

function noteTranscriptionFailure(reason) {
  consecutiveFailures += 1;
  console.warn(`[main] transcription failure (${reason}), consecutiveFailures=${consecutiveFailures}`);
  if (consecutiveFailures >= FAILURE_RECYCLE_THRESHOLD) {
    recycleRecorderWindow(`${consecutiveFailures} consecutive failures`);
  }
}

function noteTranscriptionSuccess() {
  if (consecutiveFailures > 0) {
    console.log(`[main] transcription recovered, resetting consecutiveFailures (was ${consecutiveFailures})`);
  }
  consecutiveFailures = 0;
}

// Watchdog: if a transcription sits 'in flight' for more than this, assume
// the recorder hung (state bug, network hang, MediaRecorder.onstop never
// firing) and force-reset so the user can retry without restarting.
const WATCHDOG_MS = 15000;

// Mirrors transcriptionBudgetMs in recorder.html — one curve gives the
// recorder its per-attempt fetch timeout and main its watchdog. A 5-minute
// take is a bigger upload; a fixed short ceiling was cutting long dictations.
function transcriptionBudgetMs(durationMs) {
  return Math.min(45000, 10000 + Math.round((durationMs || 0) / 12));
}

function startWatchdog(ms = WATCHDOG_MS) {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    console.warn(`[main] watchdog fired — transcription stuck >${ms}ms, force-resetting`);
    watchdogTimer = null;
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send('abort-transcription');
    }
    const wasUserVisible = !wasCancelled;
    wasCancelled = false;
    userDismissed = false;
    resetToIdle();
    if (wasUserVisible) {
      showOverlay('error', { error: `Timed out. Try again, or restart ${PRODUCT_NAME}.` });
      scheduleOverlayHide(2500);
    } else {
      hideOverlay();
    }
    // CRITICAL: recycle the recorder window. A watchdog fire means the
    // renderer's MediaRecorder/AudioContext/fetch never returned — the
    // process is wedged. Without this, the NEXT recording uses the same
    // broken renderer and hangs identically, which is why the user had
    // to restart the entire app every few hours.
    consecutiveFailures += 1;
    recycleRecorderWindow(`watchdog fired (consecutiveFailures=${consecutiveFailures})`);
  }, WATCHDOG_MS);
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

// ============================================
// Icon Creation (Using PNG for better macOS support)
// ============================================

// Mic glyph in four flavors. Idle and working are macOS template images so
// they adapt to any menubar; recording deliberately breaks monochrome in red.
// Unpackaged (npm start) runs use a blue mic so a test build is unmistakable
// next to the installed app.
function loadTrayImage(name, template) {
  const image = nativeImage.createFromPath(path.join(__dirname, 'icons', name));
  if (image.isEmpty()) {
    console.error('Failed to load tray icon:', name);
    return nativeImage.createEmpty();
  }
  if (template) image.setTemplateImage(true);
  return image;
}

function createTrayIcon(state, frame = 'a') {
  switch (state) {
    case 'recording':
      return loadTrayImage(`tray-mic-rec-${frame}.png`, false);
    case 'transcribing':
      return loadTrayImage(`tray-mic-tx-${frame}.png`, true);
    default:
      return app.isPackaged
        ? loadTrayImage('tray-mic-idle.png', true)
        : loadTrayImage('tray-mic-dev.png', false);
  }
}

// Slow pulse while recording or transcribing: two frames swapped on a timer.
let trayPulseTimer = null;
let trayPulseFrame = 'a';

function stopTrayPulse() {
  if (trayPulseTimer) { clearInterval(trayPulseTimer); trayPulseTimer = null; }
  trayPulseFrame = 'a';
}

function startTrayPulse(state, intervalMs) {
  stopTrayPulse();
  trayPulseTimer = setInterval(() => {
    trayPulseFrame = trayPulseFrame === 'a' ? 'b' : 'a';
    if (tray) tray.setImage(createTrayIcon(state, trayPulseFrame));
  }, intervalMs);
}

// ============================================
// Windows
// ============================================

function forwardRendererConsole(name, win) {
  // Electron 28+ uses a single event object: event.message, event.level.
  // Older Electron used positional args (event, level, message, line, sourceId).
  // Handle both for safety.
  win.webContents.on('console-message', (...args) => {
    let message = '(empty)';
    let level = '?';
    if (args.length >= 1 && args[0] && typeof args[0].message === 'string') {
      message = args[0].message;
      level = args[0].level !== undefined ? String(args[0].level) : '?';
    } else if (args.length >= 3) {
      level = args[1];
      message = args[2];
    }
    console.log(`[${name}:${level}] ${message}`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[${name}] did-fail-load`, errorCode, errorDescription, validatedURL);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[${name}] render-process-gone`, details);
  });
}

function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  forwardRendererConsole('recorder', recorderWindow);
  recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));

  recorderWindow.webContents.on('did-finish-load', () => {
    // Send API keys and provider to recorder
    if (config.apiKey) {
      recorderWindow.webContents.send('set-api-key', effectiveKey('apiKey'));
    }
    if (config.groqApiKey) {
      recorderWindow.webContents.send('set-groq-api-key', effectiveKey('groqApiKey'));
    }
    recorderWindow.webContents.send('set-transcription-provider', config.transcriptionProvider || 'openai');
  });
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.showInactive();
    return;
  }

  // Get primary display for positioning
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Overlay at bottom center - sized for success state with 2-3 lines
  const overlayWidth = 360;
  const overlayHeight = 120;

  // Use saved position or default to bottom center
  let x, y;
  if (config.overlayPosition) {
    x = config.overlayPosition.x;
    y = config.overlayPosition.y;
  } else {
    x = Math.floor((screenWidth - overlayWidth) / 2);
    y = screenHeight - overlayHeight - 40; // 40px from bottom (lower default)
  }

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    // macOS shadows on transparent windows outline the content's alpha —
    // including the CSS drop shadow — as a rim-lit ghost pill. Depth comes
    // from the capsule's own box-shadow instead.
    hasShadow: false,
    type: 'panel', // macOS: doesn't activate app when shown
    // focusable: true (default) — required for click events to fire on macOS
    show: false, // shown inactive on ready-to-show; the default show ACTIVATES
                 // the panel and steals key focus from the user's app, which
                 // sent the very first paste of a session into this window
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  forwardRendererConsole('overlay', overlayWindow);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
  });
  overlayWindow.setVisibleOnAllWorkspaces(true);

  // Save position when user moves the overlay
  overlayWindow.on('moved', () => {
    const [newX, newY] = overlayWindow.getPosition();
    config.overlayPosition = { x: newX, y: newY };
    saveConfig(config);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 400,
    height: 660,
    center: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createOnboardingWindow(mode) {
  // Reopening from the menu shows the Guide; a fresh setup gets the intro.
  const screen = mode === 'guide' && config.onboardingComplete ? 'guide' : '';
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }

  onboardingWindow = new BrowserWindow({
    width: 400,
    height: screen === 'guide' ? 420 : 480,
    center: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // The design gives this window a 20px corner radius; macOS will not set
    // that on a framed window, so the window is transparent and the renderer
    // paints the panel. Two consequences, both handled in onboarding.html:
    // vibrancy cannot be clipped to a rounded body (it would paint the full
    // square rect behind it), so the ground is solid; and a transparent window
    // has no native traffic lights, so they are drawn.
    frame: false,
    transparent: true,
    roundedCorners: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  onboardingWindow.loadFile(path.join(__dirname, 'onboarding.html'), {
    query: screen ? { screen } : {},
  });

  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
    // The Dock icon exists only to make first launch unmissable. Once the
    // window is gone it has nothing to point at, whether onboarding was
    // finished or abandoned.
    if (app.dock) app.dock.hide();
  });
}

// LSUIElement keeps Leise out of the Dock, but app.focus({ steal: true })
// raises the activation policy to regular and nothing lowers it again, so the
// app sits in the Dock for the rest of the session. Any launch that could not
// decrypt the stored key took that path. Drop back to accessory once the
// window is up; hiding the Dock deactivates the app, so take focus again.
function restoreAccessory(win) {
  if (process.platform !== 'darwin' || !app.dock) return;
  const drop = () => {
    if (!config.onboardingComplete) return; // onboarding still wants the icon
    app.dock.hide();
    if (win && !win.isDestroyed()) win.focus();
  };
  if (!win || win.isDestroyed() || win.isVisible()) drop();
  else win.once('ready-to-show', drop);
}

// ============================================
// Menu bar pointer
// ============================================

// Created at the maximum, then resized to the card the renderer measures —
// the bound shortcut can be anything from ⌃ Space to ⌘ ⇧ Space.
const POINTER_MAX_WIDTH = 360;
const POINTER_MAX_HEIGHT = 140;
const POINTER_DWELL_MS = 8000;
const KEY_GLYPHS = { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Command: '⌘', CommandOrControl: '⌘' };

function displayShortcut(acc) {
  return (acc || 'Control+Space').split('+').map((p) => KEY_GLYPHS[p] || p).join(' ');
}

// Centre the panel under the tray glyph, clamped to the display it sits on.
// Returns the bounds plus the caret's window-relative x.
function pointerPlacement(width, height) {
  const display = screen.getDisplayNearestPoint(
    pointerAnchor
      ? { x: Math.round(pointerAnchor.x), y: Math.round(pointerAnchor.y) }
      : screen.getCursorScreenPoint()
  );
  const area = display.workArea;
  // The glyph can sit behind the notch or a menu bar manager, and then
  // getBounds reports nothing. Fall back to the top right, where the menu
  // bar's own overflow lives.
  const centreX = pointerAnchor ? pointerAnchor.x : area.x + area.width - 24;
  const y = Math.round(pointerAnchor ? pointerAnchor.y + 2 : area.y + 2);
  let x = Math.round(centreX - width / 2);
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
  // Kept off the rounded corners so the caret never grows out of one.
  const caret = Math.round(Math.min(Math.max(centreX - x, 28), width - 28));
  return { x, y, width, height, caret };
}

// A reminder under the menu bar glyph: where Leise went, and how to call it.
// Shown once onboarding finishes, and on every relaunch of an already-running
// app — a menubar app otherwise answers a double click with nothing at all.
function showTrayPointer() {
  if (process.platform !== 'darwin') return;
  if (onboardingWindow && !onboardingWindow.isDestroyed()) return;
  if (pointerWindow && !pointerWindow.isDestroyed()) {
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(dismissTrayPointer, POINTER_DWELL_MS);
    return;
  }

  const b = tray && !tray.isDestroyed() ? tray.getBounds() : null;
  pointerAnchor = b && b.width ? { x: b.x + b.width / 2, y: b.y + b.height } : null;
  const place = pointerPlacement(POINTER_MAX_WIDTH, POINTER_MAX_HEIGHT);

  pointerWindow = new BrowserWindow({
    width: place.width,
    height: place.height,
    x: place.x,
    y: place.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    // Same as the overlay: a macOS shadow on a transparent window traces the
    // content's alpha. Depth comes from the card's own box-shadow.
    hasShadow: false,
    type: 'panel', // macOS: doesn't activate the app when shown
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  pointerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pointerWindow.loadFile(path.join(__dirname, 'pointer.html'), {
    query: { keys: displayShortcut(config.shortcut) },
  });
  // Shown by the pointer-size handler, once the window fits its content.
  pointerWindow.on('closed', () => {
    pointerWindow = null;
    clearTimeout(pointerTimer);
    pointerTimer = null;
  });

  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(dismissTrayPointer, POINTER_DWELL_MS);
}

function dismissTrayPointer() {
  if (!pointerWindow || pointerWindow.isDestroyed()) return;
  const win = pointerWindow;
  // Let the panel play its exit and close itself back through close-pointer.
  win.webContents.send('dismiss-pointer');
  clearTimeout(pointerTimer);
  // Backstop, in case the renderer never answers.
  pointerTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.close();
  }, 500);
}

function showOverlay(state, data = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('update-overlay', { state, ...data });
    });
  } else {
    overlayWindow.webContents.send('update-overlay', { state, ...data });
    overlayWindow.showInactive();
  }
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

function scheduleOverlayHide(delay) {
  // Clear any existing timer first
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
  }
  overlayHideTimer = setTimeout(() => {
    hideOverlay();
    resetToIdle();
    overlayHideTimer = null;
  }, delay);
}

// ============================================
// Tray Menu
// ============================================

function createTray() {
  try {
    const icon = createTrayIcon('idle');
    tray = new Tray(icon);
    updateTrayMenu();
    tray.setToolTip(PRODUCT_NAME);
  } catch (err) {
    console.error('Failed to create tray:', err);
  }
}

function formatRelativeTime(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function buildHistorySubmenu() {
  const history = loadHistory();
  if (history.length === 0) {
    return [{ label: 'No recent transcriptions', enabled: false }];
  }

  const items = history.map((entry) => {
    const preview = entry.text.length > 40 ? entry.text.slice(0, 40) + '…' : entry.text;
    const tag = entry.source === 'cancelled' ? '↩' : '✓';
    return {
      label: `${tag} ${preview}  ·  ${formatRelativeTime(entry.timestamp)}`,
      click: () => copyHistoryEntry(entry.id),
    };
  });

  items.push({ type: 'separator' });
  items.push({
    label: 'Clear History',
    click: () => {
      clearHistory();
      updateTrayMenu();
    },
  });

  return items;
}

function copyHistoryEntry(id) {
  const history = loadHistory();
  const entry = history.find((e) => e.id === id);
  if (!entry) return;
  clipboard.writeText(entry.text);
  new Notification({
    title: PRODUCT_NAME,
    body: 'Copied to clipboard',
  }).show();
}

function buildPerfLabel() {
  const stats = getPerfStats();
  if (!stats) return 'Performance: no data yet';
  return `Performance: avg ${stats.avg}ms · p95 ${stats.p95}ms · last ${stats.last}ms · n=${stats.n}`;
}

function updateTrayMenu() {
  const history = loadHistory();
  const last = history[0];

  const template = [
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      accelerator: config.shortcut || 'Ctrl+Space',
      click: () => toggleRecording(),
    },
    { type: 'separator' },
  ];

  if (last) {
    const preview = last.text.length > 26 ? last.text.slice(0, 26) + '…' : last.text;
    template.push({
      label: `Copy Last: "${preview}"`,
      click: () => copyHistoryEntry(last.id),
    });
  }

  template.push({
    label: 'Recent Transcriptions',
    submenu: buildHistorySubmenu(),
  });

  // Latency telemetry is developer data — only in unpackaged runs.
  if (!app.isPackaged) {
    template.push({ label: buildPerfLabel(), enabled: false });
  }

  template.push(
    { type: 'separator' },
    { label: 'Settings…', click: () => createSettingsWindow() },
    { label: 'Guide', click: () => createOnboardingWindow('guide') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function updateTrayIcon(state) {
  if (!tray) return;
  tray.setImage(createTrayIcon(state));
  if (state === 'recording') startTrayPulse(state, 550);
  else if (state === 'transcribing') startTrayPulse(state, 800);
  else stopTrayPulse();
}

// ============================================
// Recording Logic
// ============================================

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  console.log('[main] startRecording called, isRecording=', isRecording);
  if (isRecording) return;

  // Clear any pending overlay hide timer from previous success/error state
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }

  // Cancel any in-flight watchdog from the previous transcription.
  clearWatchdog();

  // Check for the active provider's key (Groq-only setups are valid)
  if (!hasActiveKey()) {
    createSettingsWindow();
    new Notification({
      title: PRODUCT_NAME,
      body: 'Add your API key in Settings first.',
    }).show();
    return;
  }

  isRecording = true;
  recordingStartedAt = Date.now();
  noteActivity();
  // A dismiss/cancel from a PREVIOUS overlay must never bleed into this
  // recording. If userDismissed stayed true, this recording's result would be
  // silently dropped and the overlay would hang on "Transcribing…" forever.
  userDismissed = false;
  wasCancelled = false;
  resetAutoStop();
  updateTrayIcon('recording');
  updateTrayMenu();
  playSound('Pop'); // Audio feedback for recording start

  // Show overlay
  showOverlay('recording');

  // Register Escape key to cancel
  if (!escapeRegistered) {
    globalShortcut.register('Escape', () => {
      cancelRecording();
    });
    escapeRegistered = true;
  }

  // Register Enter key to stop and process
  if (!enterRegistered) {
    globalShortcut.register('Return', () => {
      stopRecording();
    });
    enterRegistered = true;
  }

  // Start recording in recorder window
  recorderWindow.webContents.send('start-recording');
}

function stopRecording() {
  console.log('[main] stopRecording called, isRecording=', isRecording, 'wasCancelled=', wasCancelled);
  if (!isRecording) return;

  isRecording = false;
  noteActivity();
  updateTrayIcon(wasCancelled ? 'idle' : 'transcribing');
  updateTrayMenu();
  playSound('Tink'); // Audio feedback for recording stop
  // Watchdog budget scales with the recording length, like the recorder's own
  // fetch timeout; per-attempt IPC re-arms it while the retry chain runs.
  const recordedMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
  startWatchdog(transcriptionBudgetMs(recordedMs) + 5000);

  // Update overlay — when cancelled, hide immediately. Transcription still
  // runs in the background and the result lands silently in tray history.
  if (wasCancelled) {
    if (overlayHideTimer) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
    }
    hideOverlay();
  } else {
    showOverlay('transcribing');
  }

  // Unregister Escape key
  if (escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }

  // Unregister Enter key
  if (enterRegistered) {
    globalShortcut.unregister('Return');
    enterRegistered = false;
  }

  // Stop recording in recorder window
  recorderWindow.webContents.send('stop-recording');
}

function cancelRecording() {
  console.log('[main] cancelRecording called, isRecording=', isRecording);
  if (!isRecording) {
    hideOverlay();
    return;
  }

  // Mark as cancelled, then run the normal stop path so the audio still
  // gets transcribed. The result handler routes to history instead of pasting.
  wasCancelled = true;
  stopRecording();
}

function resetToIdle() {
  isRecording = false;
  updateTrayIcon('idle');
  updateTrayMenu();

  if (escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }

  if (enterRegistered) {
    globalShortcut.unregister('Return');
    enterRegistered = false;
  }
}

// ============================================
// Scheduled self-relaunch
// ============================================
// Multi-day uptime wears out state that recycling the recorder window and
// flushing the NetworkService cannot fully reset; the proven fix has been
// quitting and reopening the app every few days. This automates exactly that,
// only when nothing is in flight and the user has been away for a while.
// LSUIElement plus a completed onboarding make the relaunch invisible: no
// dock icon, no windows, no focus change; the tray icon is back in a second.

const RELAUNCH_TEST = !!process.env.LEISE_RELAUNCH_TEST;
const RELAUNCH_UPTIME_MS = RELAUNCH_TEST ? 3000 : 48 * 3600 * 1000;
const RELAUNCH_IDLE_MS = RELAUNCH_TEST ? 500 : 15 * 60 * 1000;
const RELAUNCH_CHECK_MS = RELAUNCH_TEST ? 250 : 30 * 60 * 1000;
const appStartedAt = Date.now();
let lastActivityAt = Date.now();

function noteActivity() {
  lastActivityAt = Date.now();
}

function maybeSelfRelaunch() {
  // An unconfigured app relaunches into the Settings-window path — a visible
  // surface. Hygiene only ever runs on a fully set up, invisible steady state.
  if (!config.onboardingComplete || !hasActiveKey()) return;
  if (isRecording || watchdogTimer) return;
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  if (onboardingWindow && !onboardingWindow.isDestroyed()) return;
  if (Date.now() - appStartedAt < RELAUNCH_UPTIME_MS) return;
  if (Date.now() - lastActivityAt < RELAUNCH_IDLE_MS) return;
  console.warn(`[main] self-relaunch: uptime ${Math.round((Date.now() - appStartedAt) / 60000)}min, idle ${Math.round((Date.now() - lastActivityAt) / 60000)}min — fresh process, fresh network stack`);
  app.relaunch(RELAUNCH_TEST ? { args: process.argv.slice(1).concat('--leise-relaunch-child') } : undefined);
  app.quit();
}

// ============================================
// Auto-stop on silence (config.autoStopEnabled, off by default)
// ============================================
// Runs on the level frames the recorder already sends every 50ms. Speech must
// hold above the floor for a few consecutive frames before silence starts the
// countdown — a keyboard click or door thud alone can't arm it and cut off a
// recording the user is still thinking into. The floor mirrors the overlay's
// LEVEL_FLOOR so the meter and the stop share one definition of quiet.

const AUTO_STOP_FLOOR = 0.09; // = LEVEL_FLOOR in overlay.html
const AUTO_STOP_ARM_FRAMES = 3; // consecutive voiced frames (~150ms) to arm
const AUTO_STOP_SILENCE_MS = 2000;

let autoStopVoicedRun = 0;
let autoStopArmed = false;
let autoStopLastVoiceAt = 0;

function resetAutoStop() {
  autoStopVoicedRun = 0;
  autoStopArmed = false;
  autoStopLastVoiceAt = 0;
}

function handleAudioLevels(levels) {
  if (!isRecording || !config.autoStopEnabled) return;
  if (!Array.isArray(levels) || levels.length === 0) return;

  let peak = 0;
  for (const v of levels) if (v > peak) peak = v;
  const now = Date.now();

  if (peak >= AUTO_STOP_FLOOR) {
    autoStopVoicedRun += 1;
    if (autoStopVoicedRun >= AUTO_STOP_ARM_FRAMES) autoStopArmed = true;
    autoStopLastVoiceAt = now;
    return;
  }

  if (!autoStopArmed) {
    autoStopVoicedRun = 0;
    return;
  }

  if (now - autoStopLastVoiceAt >= AUTO_STOP_SILENCE_MS) {
    console.log('[main] auto-stop: silence after speech');
    stopRecording();
  }
}

// ============================================
// Text Insertion
// ============================================

function insertText(text) {
  // Copy to clipboard
  clipboard.writeText(text);

  // Auto-paste off: clipboard is the destination. Tell the user, done.
  if (config.autoPasteEnabled === false) {
    showOverlay('copy');
    scheduleOverlayHide(2600);
    return;
  }

  const { exec } = require('child_process');

  // If the overlay holds key focus (clicked or dragged), the synthesized
  // keystroke would land in it. Hand focus back to the user's app first.
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isFocused()) {
    app.hide();
  }

  // Small delay to ensure clipboard is ready, then paste
  // The paste will go to whatever app/field was last active before our overlay
  setTimeout(() => {
    const script = `tell application "System Events" to keystroke "v" using command down`;
    exec(`osascript -e '${script}'`, (error) => {
      // Don't show success overlay if user already started new recording
      if (isRecording) {
        return;
      }

      if (error) {
        console.error('Failed to paste via AppleScript:', error.message);
        showOverlay('copy');
        scheduleOverlayHide(2600);
      } else {
        // Success shows no text: the capsule contracts to a circle, draws the
        // check, then drops away. The renderer starts the drop at 1100ms.
        showOverlay('success');
        scheduleOverlayHide(1500);
      }
    });
  }, 100);
}

// ============================================
// IPC Handlers
// ============================================

ipcMain.handle('get-config', () => {
  const needsAccessibility = !systemPreferences.isTrustedAccessibilityClient(false);
  return { ...config, needsAccessibility };
});

ipcMain.handle('save-config', (event, newConfig) => {
  noteActivity();
  const previousShortcut = config.shortcut;
  config = { ...config, ...newConfig };
  let shortcutError = null;

  if (newConfig.appearance) applyAppearance();

  // Shortcut changed: swap the global registration, roll back on failure.
  if (newConfig.shortcut && newConfig.shortcut !== previousShortcut) {
    globalShortcut.unregister(previousShortcut);
    const ok = globalShortcut.register(newConfig.shortcut, () => toggleRecording());
    if (!ok) {
      shortcutError = `${newConfig.shortcut} is taken by another app. Kept ${previousShortcut}.`;
      config.shortcut = previousShortcut;
      globalShortcut.register(previousShortcut, () => toggleRecording());
    }
    updateTrayMenu();
  }

  const success = saveConfig(config);

  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('set-api-key', effectiveKey('apiKey'));
    recorderWindow.webContents.send('set-groq-api-key', effectiveKey('groqApiKey'));
    recorderWindow.webContents.send('set-transcription-provider', config.transcriptionProvider || 'openai');
  }

  if (shortcutError) return { success, shortcutError, shortcut: config.shortcut };
  return success;
});

ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

ipcMain.on('open-settings', () => {
  createSettingsWindow();
});

// Windows report their content height and get resized to fit — settings and
// onboarding shrink and grow with their content instead of clipping it.
ipcMain.on('content-height', (event, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win === overlayWindow || win === recorderWindow) return;
  const clamped = Math.max(320, Math.min(Math.round(height), 860));
  win.setContentSize(400, clamped, true);
  // A transparent window's shadow is derived from its drawn alpha and is not
  // recomputed on resize, so it would keep the previous screen's outline.
  if (win === onboardingWindow && process.platform === 'darwin') {
    win.setHasShadow(false);
    win.setHasShadow(true);
  }
});

ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on('get-product-name', (event) => {
  event.returnValue = PRODUCT_NAME;
});

ipcMain.handle('test-api-key', async (event, apiKey) => {
  // Anything non-empty passes: the point is to walk the flow, not to hold a
  // real OpenAI key. Transcription still needs a real one.
  if (DEMO) return { success: !!(apiKey && apiKey.trim()) };
  try {
    const fetch = require('node-fetch');
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 8000, // node-fetch has no default timeout — without this the
                     // Test button hangs forever if the network is down.
    });

    if (response.ok) {
      return { success: true };
    } else {
      const data = await response.json();
      return { success: false, error: data.error?.message || 'Invalid API key' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('test-groq-api-key', async (event, apiKey) => {
  if (DEMO) return { success: !!(apiKey && apiKey.trim()) };
  try {
    const fetch = require('node-fetch');
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 8000, // node-fetch has no default timeout — without this the
                     // Test button hangs forever if the network is down.
    });

    if (response.ok) {
      return { success: true };
    } else {
      const data = await response.json();
      return { success: false, error: data.error?.message || 'Invalid API key' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('transcription-result', (event, text, elapsedMs) => {
  console.log('[main] transcription-result received, length=', (text || '').length, 'elapsed=', elapsedMs, 'wasCancelled=', wasCancelled, 'userDismissed=', userDismissed);

  clearWatchdog();
  noteActivity();
  if (typeof elapsedMs === 'number') recordPerf(elapsedMs);

  // Skip normal processing if this is a test recording from onboarding
  if (isTestRecording) {
    return;
  }

  // User clicked ✕ to dismiss while transcribing — drop the result silently.
  if (userDismissed) {
    userDismissed = false;
    wasCancelled = false;
    // Defense in depth: never leave the overlay/tray stuck on "Transcribing…"
    // if a dropped result races a dismiss. Force back to idle.
    hideOverlay();
    resetToIdle();
    return;
  }

  const trimmed = text && text.trim();

  if (!trimmed) {
    // Empty result. If the user cancelled, stay silent — they don't care.
    if (wasCancelled) {
      wasCancelled = false;
      updateTrayIcon('idle');
      return;
    }
    // Empty result is NOT a failure for recycle purposes — the recorder
    // worked fine, the user was just silent. Reset the counter.
    noteTranscriptionSuccess();
    showOverlay('error', { error: 'No speech detected' });
    scheduleOverlayHide(2000);
    return;
  }

  noteTranscriptionSuccess();

  if (wasCancelled) {
    // Silent cancel: write to history, keep the tray idle, no overlay flash.
    appendToHistory(trimmed, 'cancelled');
    updateTrayMenu();
    wasCancelled = false;
    updateTrayIcon('idle');
    return;
  }

  appendToHistory(trimmed, 'inserted');
  updateTrayMenu();
  insertText(trimmed);
});

ipcMain.on('transcription-error', (event, error) => {
  console.error('[main] transcription-error received:', error, 'wasCancelled=', wasCancelled, 'userDismissed=', userDismissed);

  clearWatchdog();

  // Skip normal processing if this is a test recording from onboarding
  if (isTestRecording) {
    return;
  }

  // User clicked ✕ to dismiss — likely an AbortError we triggered. Stay quiet.
  if (userDismissed) {
    userDismissed = false;
    wasCancelled = false;
    // Defense in depth: force back to idle so a dropped error can't leave the
    // overlay/tray stuck.
    hideOverlay();
    resetToIdle();
    return;
  }

  // Any real error counts toward the consecutive-failure recycle.
  noteTranscriptionFailure(`transcription-error: ${error}`);

  // Cancelled (Escape) recordings should also stay silent on errors.
  if (wasCancelled) {
    wasCancelled = false;
    resetToIdle();
    return;
  }

  playSound('Basso'); // one low note, the only sound with weight
  showOverlay('error', { error });
  resetToIdle();

  if (!escapeRegistered) {
    globalShortcut.register('Escape', () => {
      hideOverlay();
      globalShortcut.unregister('Escape');
      escapeRegistered = false;
    });
    escapeRegistered = true;
  }
});

ipcMain.on('recording-status', (event, status) => {
  console.log('[main] recording-status:', status);
});

// The recorder renderer fires this when the OS network comes/goes (e.g. you
// switch Wi-Fi → iPhone hotspot). Proactively drop the stale socket pool + DNS
// so the next transcription starts on a fresh connection instead of hanging on
// a dead route left over from the old network.
ipcMain.on('network-changed', (event, state) => {
  console.log('[main] network-changed:', state);
  flushNetworkStack(`network ${state}`);
});

// The recorder announces each transcription attempt with its time budget so
// the watchdog covers the whole retry chain instead of killing it mid-retry.
ipcMain.on('transcription-attempt', (event, info) => {
  const budget = (info && info.budgetMs) || 0;
  console.log(`[main] transcription attempt ${info && info.attempt}/${info && info.of}, budget=${budget}ms`);
  if (watchdogTimer) startWatchdog(budget + 5000);
});

ipcMain.on('flush-network', (event, reason) => {
  flushNetworkStack(`recorder: ${reason}`);
});

ipcMain.on('audio-levels', (event, levels) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('audio-levels', levels);
  }
  handleAudioLevels(levels);
});

ipcMain.on('close-overlay', () => {
  console.log('[main] close-overlay received, isRecording=', isRecording);
  if (isRecording) {
    // Recording → existing cancel-with-history flow
    cancelRecording();
    return;
  }

  // Not recording: either transcribing (a request IS in flight) or showing a
  // terminal success/saved/error overlay (nothing in flight). Only mark as
  // dismissed when a request is actually in flight — the watchdog is armed for
  // exactly that window. Setting it on a terminal overlay makes the flag stick
  // and silently drop the NEXT transcription's result.
  if (watchdogTimer) {
    userDismissed = true;
  }
  clearWatchdog();
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('abort-transcription');
  }
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  hideOverlay();
  resetToIdle();
});

// The window has no native close button any more; this is it. Deliberately not
// completeOnboarding(): closing is not finishing.
ipcMain.on('close-pointer', () => {
  if (pointerWindow && !pointerWindow.isDestroyed()) pointerWindow.close();
});

// The panel reports the size of its hugged card. Fit the window to it, place
// it under the glyph, hand back the caret offset, and only then show it — so
// the intermediate size is never on screen.
ipcMain.on('pointer-size', (event, width, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win !== pointerWindow) return;
  const place = pointerPlacement(
    Math.min(Math.max(Math.round(width), 180), POINTER_MAX_WIDTH),
    Math.min(Math.max(Math.round(height), 72), POINTER_MAX_HEIGHT)
  );
  win.setBounds({ x: place.x, y: place.y, width: place.width, height: place.height });
  win.webContents.send('pointer-caret', place.caret);
  // showInactive: the reminder must never take focus from what the user is typing in.
  win.showInactive();
});

ipcMain.on('close-onboarding', () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
  }
});

ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

// ============================================
// Onboarding IPC Handlers
// ============================================

ipcMain.handle('check-microphone', async () => {
  if (DEMO) return { granted: true };
  try {
    // On macOS, check if we have microphone permission
    const status = systemPreferences.getMediaAccessStatus('microphone');
    return { granted: status === 'granted' };
  } catch (err) {
    return { granted: false, error: err.message };
  }
});

ipcMain.handle('request-microphone', async () => {
  if (DEMO) return { granted: true };
  try {
    // Request microphone permission on macOS
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { granted };
  } catch (err) {
    return { granted: false, error: err.message };
  }
});

ipcMain.handle('check-accessibility', () => {
  if (DEMO) return { granted: true };
  const granted = systemPreferences.isTrustedAccessibilityClient(false);
  return { granted };
});

ipcMain.handle('request-accessibility', () => {
  if (DEMO) return { prompted: true };
  // This will prompt the user to grant accessibility permission
  systemPreferences.isTrustedAccessibilityClient(true);
  return { prompted: true };
});

// Store test recording promise resolver
let testRecordingResolver = null;

ipcMain.handle('start-test-recording', async () => {
  isTestRecording = true;

  // Start recording
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('start-recording');
    return { success: true };
  } else {
    isTestRecording = false;
    return { success: false, error: 'Recorder not ready' };
  }
});

ipcMain.handle('stop-test-recording', async () => {
  return new Promise((resolve) => {
    testRecordingResolver = resolve;

    // Set up one-time listener for test recording result
    const resultHandler = (event, text) => {
      isTestRecording = false;
      testRecordingResolver = null;
      ipcMain.removeListener('transcription-error', errorHandler);
      resolve({ success: true, text });
    };

    const errorHandler = (event, error) => {
      isTestRecording = false;
      testRecordingResolver = null;
      ipcMain.removeListener('transcription-result', resultHandler);
      resolve({ success: false, error });
    };

    ipcMain.once('transcription-result', resultHandler);
    ipcMain.once('transcription-error', errorHandler);

    // Stop recording
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send('stop-recording');
    } else {
      isTestRecording = false;
      resolve({ success: false, error: 'Recorder not ready' });
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      isTestRecording = false;
      testRecordingResolver = null;
      ipcMain.removeListener('transcription-result', resultHandler);
      ipcMain.removeListener('transcription-error', errorHandler);
      resolve({ success: false, error: 'Transcription timed out' });
    }, 30000);
  });
});

ipcMain.handle('complete-onboarding', () => {
  config.onboardingComplete = true;
  saveConfig(config);
  if (app.dock) app.dock.hide();

  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
  }

  // The window the user was looking at just disappeared. Say where the app went.
  setTimeout(showTrayPointer, 300);

  return { success: true };
});

// ============================================
// App Lifecycle
// ============================================

app.whenReady().then(() => {
  applyAppearance();
  hydrateKeys();
  createRecorderWindow();
  createTray();

  // First launch: the app must be unmissable. The dock icon shows for the
  // duration of onboarding (it hides again after — menubar app otherwise),
  // the window comes to the front, and the accessibility prompt is NOT
  // fired here: onboarding introduces it before asking.
  if (!config.onboardingComplete) {
    if (app.dock) app.dock.show();
    createOnboardingWindow();
    app.focus({ steal: true });
    if (onboardingWindow) onboardingWindow.show();
  } else if (!hasActiveKey()) {
    createSettingsWindow();
    app.focus({ steal: true });
    restoreAccessory(settingsWindow);
  }

  if (DEMO) {
    console.log('\n  LEISE DEMO — fresh install every launch');
    console.log('  userData   ' + app.getPath('userData'));
    console.log('  record     ' + (config.shortcut || 'Control+Alt+Space') + '  (installed app keeps Control+Space)');
    console.log('  mic + accessibility granted, any API key accepted');
  }

  // Register global shortcut
  const shortcut = config.shortcut || 'Control+Space';
  const registered = globalShortcut.register(shortcut, () => {
    toggleRecording();
  });

  if (!registered) {
    console.error('Failed to register shortcut:', shortcut);
    new Notification({
      title: PRODUCT_NAME,
      body: `Failed to register ${shortcut}. It may be used by another app.`,
    }).show();
  }

  if (DEMO) {
    // Flip appearance live, so light and dark can be compared on the same
    // window without relaunching or changing System Settings.
    const CYCLE = ['system', 'light', 'dark'];
    globalShortcut.register('Control+Alt+L', () => {
      const next = CYCLE[(CYCLE.indexOf(config.appearance) + 1) % CYCLE.length];
      config.appearance = next;
      applyAppearance();
      console.log('[demo] appearance ->', next);
      new Notification({ title: PRODUCT_NAME, body: 'Appearance: ' + next }).show();
    });
    console.log('  appearance ' + config.appearance + '  (⌃⌥L cycles system / light / dark)');
    const bk = demoRealKeys();
    console.log('  key        ' + (bk.groqApiKey || bk.apiKey ? 'borrowed from the installed app' : 'none found — transcription will fail') + '\n');
  }

  // Hygiene timer for the scheduled self-relaunch. Probes quit on their own
  // schedules, and a relaunched test child must not relaunch again.
  const suppressRelaunch = process.env.WHISP_UITEST || process.env.LEISE_FOCUS_TEST ||
    process.env.LEISE_ONBOARD_TEST || process.env.LEISE_AUTOSTOP_TEST || process.env.LEISE_MENUBAR_TEST ||
    process.env.LEISE_RETRY_TEST || process.env.LEISE_CLEANUP_TEST || process.env.LEISE_CLEANUP_LIVE ||
    process.env.LEISE_FRESH || DEMO || process.argv.includes('--leise-relaunch-child');
  if (!suppressRelaunch) {
    setInterval(maybeSelfRelaunch, RELAUNCH_CHECK_MS);
  }

  // After Mac sleep/wake, the renderer's MediaRecorder + AudioContext can
  // hold onto stale audio device handles or end up in a state where onstop
  // never fires. Recycle the recorder window on resume so the next
  // recording starts from a clean slate.
  powerMonitor.on('resume', () => {
    clearWatchdog();
    if (isRecording) {
      // Active recording during sleep is unrecoverable; bail out cleanly.
      isRecording = false;
      wasCancelled = false;
      hideOverlay();
      resetToIdle();
    }
    recycleRecorderWindow('powerMonitor resume');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (!config.onboardingComplete) {
    createOnboardingWindow();
  } else if (!settingsWindow && !hasActiveKey()) {
    createSettingsWindow();
  } else {
    // Reopened while already running. Without this the double click looks
    // like nothing happened at all.
    showTrayPointer();
  }
});

// ============================================
// UI test drive (WHISP_UITEST=1) — opens every window, walks the overlay
// through its states with fake levels, captures PNGs, then quits. Lets a
// session verify the real rendered UI without touching the mic or the APIs.
// ============================================

if (process.env.LEISE_FOCUS_TEST) {
  app.whenReady().then(async () => {
    await new Promise((r) => setTimeout(r, 800));
    const before = app.isActive ? app.isActive() : 'n/a';
    createOverlayWindow();
    showOverlay('recording');
    await new Promise((r) => setTimeout(r, 900));
    const after = app.isActive ? app.isActive() : 'n/a';
    const focused = overlayWindow && overlayWindow.isFocused();
    console.log(`[focus-test] activeBefore=${before} activeAfter=${after} overlayFocused=${focused}`);
    app.quit();
  });
}

// Menu bar probe (LEISE_MENUBAR_TEST=1): first launch shows the Dock icon on purpose,
// so onboarding cannot be missed. This checks it goes away again when that
// window closes — whether the user pressed Done or just closed it, which used
// to leave the icon sitting there for the rest of the session. Prints three
// PASS/FAIL lines, then quits.
if (process.env.LEISE_MENUBAR_TEST) {
  app.whenReady().then(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const say = (label, ok) => console.log(`[menubar-test] ${ok ? 'PASS' : 'FAIL'} ${label}`);
    await tick(1800);

    const onboardingUp = !!(onboardingWindow && !onboardingWindow.isDestroyed());
    say('first launch shows the Dock icon', onboardingUp && app.dock.isVisible());

    // The close button, not Done: the path that used to strand the icon.
    if (onboardingUp) onboardingWindow.close();
    await tick(900);
    say('closing onboarding hides it again', !app.dock.isVisible());

    // And it stays hidden when a window opens later.
    createSettingsWindow();
    app.focus({ steal: true });
    restoreAccessory(settingsWindow);
    await tick(1200);
    say('a later window does not bring it back', !app.dock.isVisible());

    // The pointer that replaces the Dock icon as the way back to the app.
    const focusedBefore = BrowserWindow.getFocusedWindow();
    showTrayPointer();
    await tick(1400);
    const up = !!(pointerWindow && !pointerWindow.isDestroyed() && pointerWindow.isVisible());
    say('pointer opens', up);
    say('pointer takes no focus', up && !pointerWindow.isFocused() &&
      BrowserWindow.getFocusedWindow() === focusedBefore);

    if (up) {
      const b = pointerWindow.getBounds();
      const t = tray.getBounds();
      // The caret is drawn at the window-relative x the placement returned.
      const caretX = b.x + pointerPlacement(b.width, b.height).caret;
      const glyphX = t.x + t.width / 2;
      say(`caret sits under the glyph (off by ${Math.round(Math.abs(caretX - glyphX))}px)`,
        Math.abs(caretX - glyphX) <= 2);
      say('pointer hangs from the menu bar', Math.abs(b.y - (t.y + t.height)) <= 4);
    }

    dismissTrayPointer();
    await tick(900);
    say('pointer dismisses', !pointerWindow);

    app.quit();
  });
}

// Auto-stop probe (LEISE_AUTOSTOP_TEST=1): drives handleAudioLevels with
// synthetic frames against the real state machine — no mic, no API keys.
// Prints one PASS/FAIL line per scenario, then quits.
if (process.env.LEISE_AUTOSTOP_TEST) {
  app.whenReady().then(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const VOICED = Array.from({ length: 17 }, () => 0.4);
    const SILENT = Array.from({ length: 17 }, () => 0.03);
    const feedSilence = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        handleAudioLevels(SILENT);
        await tick(50);
      }
    };
    const beginFakeRecording = () => {
      isRecording = true;
      wasCancelled = false;
      userDismissed = false;
      resetAutoStop();
    };
    const results = [];

    await tick(600);

    // Toggle off (the default): speech then silence keeps recording.
    config.autoStopEnabled = false;
    beginFakeRecording();
    for (let i = 0; i < 5; i++) { handleAudioLevels(VOICED); await tick(50); }
    await feedSilence(2300);
    results.push(`defaultOff=${isRecording ? 'PASS' : 'FAIL'}`);
    resetToIdle();

    // Toggle on, transient only: a single voiced frame must not arm.
    config.autoStopEnabled = true;
    beginFakeRecording();
    handleAudioLevels(VOICED);
    await feedSilence(2300);
    results.push(`armGuard=${isRecording ? 'PASS' : 'FAIL'}`);
    resetToIdle();

    // Toggle on, sustained speech then silence: stops on its own.
    beginFakeRecording();
    for (let i = 0; i < 5; i++) { handleAudioLevels(VOICED); await tick(50); }
    await feedSilence(2300);
    results.push(`autoStop=${!isRecording ? 'PASS' : 'FAIL'}`);

    // Settings toggle: a real click lands in config through save-config.
    config.autoStopEnabled = false;
    createSettingsWindow();
    await tick(1400);
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById('tglAutoStop').click()`);
    await tick(400);
    const clickedOn = config.autoStopEnabled === true;
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById('tglAutoStop').click()`);
    await tick(400);
    results.push(`settingsToggle=${clickedOn && config.autoStopEnabled === false ? 'PASS' : 'FAIL'}`);

    clearWatchdog();
    console.log('[autostop-test]', results.join(' '));
    app.quit();
  });
}

// Self-relaunch probe (LEISE_RELAUNCH_TEST=1): shrinks the thresholds, proves
// the in-flight guard holds, then lets the real app.relaunch() fire. The
// relaunched child writes an invisibility report (dock, visible windows,
// activation) into the shared test userData for the runner to read, and quits.
if (process.env.LEISE_RELAUNCH_TEST) {
  app.whenReady().then(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const reportPath = path.join(app.getPath('userData'), 'relaunch-child-report.json');

    if (process.argv.includes('--leise-relaunch-child')) {
      await tick(1200);
      const report = {
        childPid: process.pid,
        dockVisible: app.dock ? app.dock.isVisible() : null,
        visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        active: app.isActive ? app.isActive() : null,
      };
      fs.writeFileSync(reportPath, JSON.stringify(report));
      console.log('[relaunch-test] child report written:', JSON.stringify(report));
      app.quit();
      return;
    }

    try { fs.unlinkSync(reportPath); } catch (e) {}
    // Guard phase: both thresholds exceeded while "recording" — must not fire.
    isRecording = true;
    await tick(RELAUNCH_UPTIME_MS + RELAUNCH_IDLE_MS + 1500);
    console.log('[relaunch-test] guard=PASS (still running while recording past thresholds), parent pid', process.pid);
    isRecording = false;
    lastActivityAt = Date.now() - RELAUNCH_IDLE_MS - 100;
    console.log('[relaunch-test] released — waiting for the hygiene tick to relaunch');
  });
}

// Retry-chain probe (LEISE_RETRY_TEST=1): arms the recorder's fault plan so
// attempt 1 hangs until its own budget aborts it and attempt 2 returns a
// canned transcript — no mic, no keys, no network. Asserts the retry
// delivered the result, the watchdog stayed quiet, and the budget curve
// scales for a 5-minute take.
if (process.env.LEISE_RETRY_TEST) {
  app.whenReady().then(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    await tick(1200);
    const FAKE = 'retry test transcript';
    let attempts = 0;
    let gotResult = null;
    let resolveResult;
    const resultSeen = new Promise((r) => { resolveResult = r; });
    ipcMain.on('transcription-attempt', () => { attempts += 1; });
    ipcMain.on('transcription-result', (event, text) => { gotResult = text; resolveResult(); });

    recorderWindow.webContents.send('set-groq-api-key', 'probe-key');
    recorderWindow.webContents.send('set-transcription-provider', 'groq');
    recorderWindow.webContents.send('test-transcription-plan', { failFirst: 1, fakeResult: FAKE, budgetOverrideMs: 1200 });
    await tick(200);

    // Route the result to history, never to a paste on the runner's machine.
    wasCancelled = true;
    startWatchdog(transcriptionBudgetMs(0) + 5000);
    recorderWindow.webContents.executeJavaScript(
      'transcribeAudio(new Blob([new Uint8Array(1500)]), recordingSessionId, 4000)');
    await Promise.race([resultSeen, tick(10000)]);

    const chain = gotResult === FAKE;
    const watchdogQuiet = chain && watchdogTimer === null;
    const recorderBudget = await recorderWindow.webContents.executeJavaScript('transcriptionBudgetMs(300000)');
    const budgetOk = recorderBudget === 35000 && transcriptionBudgetMs(300000) === 35000;
    console.log(`[retry-test] chain=${chain ? 'PASS' : 'FAIL (got ' + JSON.stringify(gotResult) + ')'} attempts=${attempts} watchdog=${watchdogQuiet ? 'quiet' : 'FIRED-or-armed'} budget5min=${budgetOk ? 'PASS' : 'FAIL (' + recorderBudget + ')'}`);
    clearWatchdog();
    app.quit();
  });
}

// Live cleanup driver (LEISE_CLEANUP_LIVE="text"): runs the real cleanup call
// with the real config and keys against the given text, prints the model's
// output, quits. Read-only — no recording, no config writes, no isolation
// (the point is the real key and the real request).
if (process.env.LEISE_CLEANUP_LIVE) {
  app.whenReady().then(async () => {
    await new Promise((r) => setTimeout(r, 1800));
    const text = process.env.LEISE_CLEANUP_LIVE;
    try {
      const out = await recorderWindow.webContents.executeJavaScript(
        `cleanupEnabled = true; cleanupTranscript(${JSON.stringify(text)})`);
      console.log('[cleanup-live] IN :', text);
      console.log('[cleanup-live] OUT:', out);
    } catch (e) {
      console.error('[cleanup-live] driver failed:', e.message);
    }
    app.quit();
  });
}

// Cleanup-pass probe (LEISE_CLEANUP_TEST=1): settings click lands in config,
// a cleaned transcript replaces the raw one on the happy path, and a hung
// cleanup call falls back to the raw transcript at the real 2.5s budget.
if (process.env.LEISE_CLEANUP_TEST) {
  app.whenReady().then(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    await tick(1200);
    const results = [];

    // Settings toggle wires to config through save-config.
    config.cleanupEnabled = false;
    createSettingsWindow();
    await tick(1400);
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById('tglCleanup').click()`);
    await tick(400);
    results.push(`settingsToggle=${config.cleanupEnabled === true ? 'PASS' : 'FAIL'}`);

    let lastResult = null;
    let resolveResult = null;
    ipcMain.on('transcription-result', (event, text) => {
      lastResult = text;
      if (resolveResult) resolveResult();
    });
    recorderWindow.webContents.send('set-groq-api-key', 'probe-key');
    recorderWindow.webContents.send('set-transcription-provider', 'groq');
    await recorderWindow.webContents.executeJavaScript('cleanupEnabled = true; 1');

    const drive = async (raw, cleanupPlan, waitMs) => {
      recorderWindow.webContents.send('test-transcription-plan', { failFirst: 0, fakeResult: raw });
      recorderWindow.webContents.send('test-cleanup-plan', cleanupPlan);
      await tick(200);
      lastResult = null;
      const seen = new Promise((r) => { resolveResult = r; });
      wasCancelled = true;
      startWatchdog(transcriptionBudgetMs(0) + 5000);
      recorderWindow.webContents.executeJavaScript(
        'transcribeAudio(new Blob([new Uint8Array(1500)]), recordingSessionId, 2000)');
      await Promise.race([seen, tick(waitMs)]);
      return lastResult;
    };

    const cleaned = await drive('okay okay okay raw', { mode: 'ok', cleaned: 'okay', delayMs: 150 }, 6000);
    results.push(`cleanApplied=${cleaned === 'okay' ? 'PASS' : 'FAIL (' + JSON.stringify(cleaned) + ')'}`);

    const fallback = await drive('raw text stays', { mode: 'hang' }, 8000);
    results.push(`budgetFallback=${fallback === 'raw text stays' ? 'PASS' : 'FAIL (' + JSON.stringify(fallback) + ')'}`);

    clearWatchdog();
    console.log('[cleanup-test]', results.join(' '));
    app.quit();
  });
}

// Fresh-install onboarding walkthrough: isolated userData, real first-run
// path, capture of every screen.
if (process.env.LEISE_ONBOARD_TEST) {
  app.whenReady().then(async () => {
    const outDir = process.env.WHISP_UITEST_DIR || app.getPath('temp');
    await new Promise((r) => setTimeout(r, 1500));
    const screens = ['s-welcome', 's-perms', 's-connect', 's-keys', 's-try', 's-guide'];
    for (const id of screens) {
      await onboardingWindow.webContents.executeJavaScript(`
        (() => {
          document.querySelectorAll('.screen').forEach(s => s.classList.toggle('visible', s.id === '${id}'));
          const s = document.querySelector('.screen.visible');
          window.electronAPI.reportHeight(s.scrollHeight + 56);
        })()`);
      await new Promise((r) => setTimeout(r, 450));
      const img = await onboardingWindow.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `onboard-${id}.png`), img.toPNG());
    }
    console.log('[onboard-test] captured', screens.length, 'screens; firstRun onboarding shown:', !!onboardingWindow);
    app.quit();
  });
}

if (process.env.WHISP_UITEST) {
  app.whenReady().then(() => {
    const outDir = process.env.WHISP_UITEST_DIR || app.getPath('temp');
    const shots = [];
    const snap = (win, name) => {
      if (!win || win.isDestroyed()) return Promise.resolve();
      return win.webContents.capturePage().then((img) => {
        const file = path.join(outDir, `uitest-${name}.png`);
        fs.writeFileSync(file, img.toPNG());
        shots.push(file);
      }).catch((err) => console.error('[uitest] capture failed:', name, err.message));
    };
    const fakeLevels = () => Array.from({ length: 17 }, (_, i) => {
      const c = Math.abs(i - 8) / 8;
      return Math.max(0.05, (0.85 - c * 0.6) * (0.4 + 0.6 * Math.random()));
    });

    setTimeout(async () => {
      try {
        createSettingsWindow();
        createOnboardingWindow();
        createOverlayWindow();
        await new Promise((r) => setTimeout(r, 1600));

        showOverlay('recording');
        const levelTimer = setInterval(() => {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('audio-levels', fakeLevels());
          }
        }, 50);
        await new Promise((r) => setTimeout(r, 900));
        await snap(overlayWindow, 'overlay-recording');

        clearInterval(levelTimer);
        showOverlay('transcribing');
        await new Promise((r) => setTimeout(r, 600));
        await snap(overlayWindow, 'overlay-transcribing');

        showOverlay('success');
        await new Promise((r) => setTimeout(r, 800));
        await snap(overlayWindow, 'overlay-success');

        showOverlay('error', { error: "Couldn't reach Groq. Check connection." });
        await new Promise((r) => setTimeout(r, 400));
        await snap(overlayWindow, 'overlay-error');

        showOverlay('copy');
        await new Promise((r) => setTimeout(r, 400));
        await snap(overlayWindow, 'overlay-copy');

        await snap(settingsWindow, 'settings');
        await snap(onboardingWindow, 'onboarding');

        // The menu bar pointer. It refuses to open while onboarding is up, so
        // that window closes first.
        if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
        await new Promise((r) => setTimeout(r, 200));
        showTrayPointer();
        // The panel measures itself and is placed before it shows, so give it
        // that round trip before capturing.
        await new Promise((r) => setTimeout(r, 1500));
        await snap(pointerWindow, 'pointer');

        // Light mode pass: flip the theme source and re-capture.
        nativeTheme.themeSource = 'light';
        showOverlay('recording');
        const lightLevels = setInterval(() => {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('audio-levels', fakeLevels());
          }
        }, 50);
        await new Promise((r) => setTimeout(r, 700));
        await snap(overlayWindow, 'overlay-recording-light');
        clearInterval(lightLevels);
        await snap(settingsWindow, 'settings-light');

        if (pointerWindow && !pointerWindow.isDestroyed()) pointerWindow.destroy();
        showTrayPointer();
        await new Promise((r) => setTimeout(r, 1500));
        await snap(pointerWindow, 'pointer-light');
        console.log('[uitest] captured:', JSON.stringify(shots));

        // Optional burst capture of the live overlay loop for the README GIF.
        if (process.env.WHISP_UITEST_GIF) {
          nativeTheme.themeSource = 'dark'; // the README hero is the dark capsule
          await new Promise((r) => setTimeout(r, 300));
          const frameDir = path.join(outDir, 'gif-frames');
          if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });
          let frame = 0;
          const grab = async () => {
            if (!overlayWindow || overlayWindow.isDestroyed()) return;
            const img = await overlayWindow.webContents.capturePage();
            fs.writeFileSync(path.join(frameDir, `f-${String(frame++).padStart(3, '0')}.png`), img.toPNG());
          };
          showOverlay('recording');
          const gifLevels = setInterval(() => {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('audio-levels', fakeLevels());
            }
          }, 50);
          const burst = setInterval(grab, 90);
          await new Promise((r) => setTimeout(r, 2100));
          clearInterval(gifLevels);
          showOverlay('transcribing');
          await new Promise((r) => setTimeout(r, 1300));
          showOverlay('success');
          await new Promise((r) => setTimeout(r, 1900));
          clearInterval(burst);
          console.log('[uitest] gif frames:', frame);
        }
      } catch (err) {
        console.error('[uitest] failed:', err);
      } finally {
        app.quit();
      }
    }, 1200);
  });
}
