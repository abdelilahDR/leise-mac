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
  shortcut: 'Control+Space',
  soundsEnabled: true,
  autoPasteEnabled: true,
  preferredInputDeviceId: '',
  appearance: 'system', // system | light | dark, drives nativeTheme.themeSource
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
function hasActiveKey() {
  return (config.transcriptionProvider === 'openai') ? !!config.apiKey : !!config.groqApiKey;
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
    if (enc && !config[field]) config[field] = decryptKey(enc);
    delete config[field + 'Enc'];
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
let isRecording = false;
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

function startWatchdog() {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    console.warn(`[main] watchdog fired — transcription stuck >${WATCHDOG_MS}ms, force-resetting`);
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
      recorderWindow.webContents.send('set-api-key', config.apiKey);
    }
    if (config.groqApiKey) {
      recorderWindow.webContents.send('set-groq-api-key', config.groqApiKey);
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  forwardRendererConsole('overlay', overlayWindow);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
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
    titleBarStyle: 'hiddenInset',
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
  });
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
  // A dismiss/cancel from a PREVIOUS overlay must never bleed into this
  // recording. If userDismissed stayed true, this recording's result would be
  // silently dropped and the overlay would hang on "Transcribing…" forever.
  userDismissed = false;
  wasCancelled = false;
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
  updateTrayIcon(wasCancelled ? 'idle' : 'transcribing');
  updateTrayMenu();
  playSound('Tink'); // Audio feedback for recording stop
  startWatchdog();

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
    recorderWindow.webContents.send('set-api-key', config.apiKey);
    recorderWindow.webContents.send('set-groq-api-key', config.groqApiKey);
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

ipcMain.on('get-product-name', (event) => {
  event.returnValue = PRODUCT_NAME;
});

ipcMain.handle('test-api-key', async (event, apiKey) => {
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

ipcMain.on('audio-levels', (event, levels) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('audio-levels', levels);
  }
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

ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

// ============================================
// Onboarding IPC Handlers
// ============================================

ipcMain.handle('check-microphone', async () => {
  try {
    // On macOS, check if we have microphone permission
    const status = systemPreferences.getMediaAccessStatus('microphone');
    return { granted: status === 'granted' };
  } catch (err) {
    return { granted: false, error: err.message };
  }
});

ipcMain.handle('request-microphone', async () => {
  try {
    // Request microphone permission on macOS
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { granted };
  } catch (err) {
    return { granted: false, error: err.message };
  }
});

ipcMain.handle('check-accessibility', () => {
  const granted = systemPreferences.isTrustedAccessibilityClient(false);
  return { granted };
});

ipcMain.handle('request-accessibility', () => {
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

  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
  }

  return { success: true };
});

// ============================================
// App Lifecycle
// ============================================

app.whenReady().then(() => {
  // Check Accessibility permission
  systemPreferences.isTrustedAccessibilityClient(true);

  applyAppearance();
  hydrateKeys();
  createRecorderWindow();
  createTray();

  // Show onboarding if not completed, otherwise check for the active key
  if (!config.onboardingComplete) {
    createOnboardingWindow();
  } else if (!hasActiveKey()) {
    createSettingsWindow();
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
  }
});

// ============================================
// UI test drive (WHISP_UITEST=1) — opens every window, walks the overlay
// through its states with fake levels, captures PNGs, then quits. Lets a
// session verify the real rendered UI without touching the mic or the APIs.
// ============================================

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
        console.log('[uitest] captured:', JSON.stringify(shots));
      } catch (err) {
        console.error('[uitest] failed:', err);
      } finally {
        app.quit();
      }
    }, 1200);
  });
}
