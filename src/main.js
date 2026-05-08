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
} = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// ============================================
// Startup banner — if you do NOT see this on `npm start`, you are running the
// wrong directory or the installed app is intercepting things.
// ============================================
console.log('═══════════════════════════════════════════════');
console.log('  Whisp DEV — diagnostic build  ' + new Date().toISOString());
console.log('  cwd:', process.cwd());
console.log('  __dirname:', __dirname);
console.log('═══════════════════════════════════════════════');

// ============================================
// Sound Feedback
// ============================================

function playSound(soundName) {
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

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  return { apiKey: '', groqApiKey: '', transcriptionProvider: 'openai', shortcut: 'Control+Space' };
}

function saveConfig(newConfig) {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
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
      showOverlay('error', { error: 'Transcription timed out — please try again' });
      scheduleOverlayHide(2500);
    } else {
      hideOverlay();
    }
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

function createTrayIcon(state) {
  // Use actual PNG files for reliable tray icon display on macOS
  let iconName = 'tray-idle.png';

  switch (state) {
    case 'recording':
      iconName = 'tray-recording.png';
      break;
    case 'transcribing':
      iconName = 'tray-transcribing.png';
      break;
  }

  // Handle both dev and packaged paths
  let iconPath = path.join(__dirname, 'icons', iconName);

  const image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    console.error('Failed to load icon from:', iconPath);
    // Return a simple colored icon as fallback
    return nativeImage.createEmpty();
  }

  // Resize to proper tray size (16x16 logical)
  const resized = image.resize({ width: 16, height: 16 });

  return resized;
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
    hasShadow: true,
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
    width: 420,
    height: 540,
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

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }

  onboardingWindow = new BrowserWindow({
    width: 420,
    height: 620,
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

  onboardingWindow.loadFile(path.join(__dirname, 'onboarding.html'));

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
    tray.setToolTip('Whisp');
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
    title: 'Whisp',
    body: 'Copied to clipboard',
  }).show();
}

function buildPerfLabel() {
  const stats = getPerfStats();
  if (!stats) return 'Performance: no data yet';
  return `Performance: avg ${stats.avg}ms · p95 ${stats.p95}ms · last ${stats.last}ms · n=${stats.n}`;
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      accelerator: 'Ctrl+Space',
      click: () => toggleRecording(),
    },
    { type: 'separator' },
    {
      label: 'Recent Transcriptions',
      submenu: buildHistorySubmenu(),
    },
    { label: buildPerfLabel(), enabled: false },
    { type: 'separator' },
    {
      label: 'Whisp Intro',
      click: () => createOnboardingWindow(),
    },
    {
      label: 'Settings...',
      click: () => createSettingsWindow(),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

function updateTrayIcon(state) {
  if (tray) {
    tray.setImage(createTrayIcon(state));
  }
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

  // Check for API key
  if (!config.apiKey) {
    createSettingsWindow();
    new Notification({
      title: 'Whisp',
      body: 'Please configure your OpenAI API key first',
    }).show();
    return;
  }

  isRecording = true;
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
        showOverlay('success', { text: 'Copied! Press Cmd+V to paste' });
      } else {
        showOverlay('success', { text });
      }

      scheduleOverlayHide(3000);
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
  config = { ...config, ...newConfig };
  const success = saveConfig(config);

  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('set-api-key', config.apiKey);
    recorderWindow.webContents.send('set-groq-api-key', config.groqApiKey);
    recorderWindow.webContents.send('set-transcription-provider', config.transcriptionProvider || 'openai');
  }

  return success;
});

ipcMain.handle('test-api-key', async (event, apiKey) => {
  try {
    const fetch = require('node-fetch');
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
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
    showOverlay('error', { error: 'No speech detected' });
    scheduleOverlayHide(2000);
    return;
  }

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
    return;
  }

  // Cancelled (Escape) recordings should also stay silent on errors.
  if (wasCancelled) {
    wasCancelled = false;
    resetToIdle();
    return;
  }

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

  // Not recording: either transcribing, or showing success/saved/error.
  // Mark as dismissed so any in-flight transcription result/error is ignored,
  // then ask the recorder to abort the request if one is running.
  userDismissed = true;
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

  createRecorderWindow();
  createTray();

  // Show onboarding if not completed, otherwise check for API key
  if (!config.onboardingComplete) {
    createOnboardingWindow();
  } else if (!config.apiKey) {
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
      title: 'Whisp',
      body: `Failed to register ${shortcut}. It may be used by another app.`,
    }).show();
  }

  // After Mac sleep/wake, the renderer's MediaRecorder + AudioContext can
  // hold onto stale audio device handles or end up in a state where onstop
  // never fires. Recycle the recorder window on resume so the next
  // recording starts from a clean slate.
  powerMonitor.on('resume', () => {
    console.log('[main] system resumed — recycling recorder window');
    clearWatchdog();
    if (isRecording) {
      // Active recording during sleep is unrecoverable; bail out cleanly.
      isRecording = false;
      wasCancelled = false;
      hideOverlay();
      resetToIdle();
    }
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.destroy();
    }
    recorderWindow = null;
    createRecorderWindow();
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
  } else if (!settingsWindow && !config.apiKey) {
    createSettingsWindow();
  }
});
