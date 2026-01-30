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
} = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================
// Configuration Management
// ============================================

const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  return { apiKey: '', shortcut: 'Control+Space' };
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

let config = loadConfig();

// ============================================
// Global State
// ============================================

let tray = null;
let recorderWindow = null;
let overlayWindow = null;
let settingsWindow = null;
let isRecording = false;
let escapeRegistered = false;

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

  const iconPath = path.join(__dirname, 'icons', iconName);
  const image = nativeImage.createFromPath(iconPath);

  // Resize to proper tray size (16x16 logical)
  const resized = image.resize({ width: 16, height: 16 });

  // For idle state, make it a template so it adapts to dark/light menu bar
  if (state === 'idle') {
    resized.setTemplateImage(true);
  }

  return resized;
}

// ============================================
// Windows
// ============================================

function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));

  recorderWindow.webContents.on('did-finish-load', () => {
    console.log('Recorder window loaded');
    // Open DevTools for debugging (can be removed later)
    // recorderWindow.webContents.openDevTools({ mode: 'detach' });
    // Send API key to recorder
    if (config.apiKey) {
      console.log('Sending API key to recorder');
      recorderWindow.webContents.send('set-api-key', config.apiKey);
    }
  });

  // Forward console logs from recorder window
  recorderWindow.webContents.on('console-message', (event, level, message) => {
    console.log('[Recorder]', message);
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

  // Small overlay at bottom center
  const overlayWidth = 280;
  const overlayHeight = 70;
  const x = Math.floor((screenWidth - overlayWidth) / 2);
  const y = screenHeight - overlayHeight - 100; // 100px from bottom

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
    hasShadow: true,
    focusable: false,
    type: 'panel', // macOS: doesn't activate app when shown
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true);

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
    width: 480,
    height: 580,
    resizable: false,
    useContentSize: true,
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

function showOverlay(state, data = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    overlayWindow.webContents.on('did-finish-load', () => {
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

// ============================================
// Tray Menu
// ============================================

function createTray() {
  const icon = createTrayIcon('idle');
  tray = new Tray(icon);

  updateTrayMenu();
  tray.setToolTip('Whisp');

  console.log('Tray created');
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
  if (isRecording) return;

  // Check for API key
  if (!config.apiKey) {
    createSettingsWindow();
    new Notification({
      title: 'Whisp',
      body: 'Please configure your OpenAI API key first',
    }).show();
    return;
  }

  console.log('Starting recording...');
  isRecording = true;
  updateTrayIcon('recording');
  updateTrayMenu();

  // Show overlay
  showOverlay('recording');

  // Register Escape key to cancel
  if (!escapeRegistered) {
    globalShortcut.register('Escape', () => {
      cancelRecording();
    });
    escapeRegistered = true;
  }

  // Start recording in recorder window
  recorderWindow.webContents.send('start-recording');
}

function stopRecording() {
  if (!isRecording) return;

  console.log('Stopping recording, starting transcription...');
  isRecording = false;
  updateTrayIcon('transcribing');
  updateTrayMenu();

  // Update overlay
  showOverlay('transcribing');

  // Unregister Escape key
  if (escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }

  // Stop recording in recorder window
  recorderWindow.webContents.send('stop-recording');
}

function cancelRecording() {
  console.log('Cancelling recording...');

  if (!isRecording) {
    hideOverlay();
    return;
  }

  isRecording = false;
  updateTrayIcon('idle');
  updateTrayMenu();

  if (escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }

  recorderWindow.webContents.send('cancel-recording');
  hideOverlay();
}

function resetToIdle() {
  isRecording = false;
  updateTrayIcon('idle');
  updateTrayMenu();

  if (escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }
}

// ============================================
// Text Insertion
// ============================================

function insertText(text) {
  console.log('Inserting text:', text.substring(0, 50) + '...');

  // Copy to clipboard
  clipboard.writeText(text);
  console.log('Text copied to clipboard');

  const { exec } = require('child_process');

  // Small delay to ensure clipboard is ready, then paste
  // The paste will go to whatever app/field was last active before our overlay
  setTimeout(() => {
    const script = `tell application "System Events" to keystroke "v" using command down`;
    exec(`osascript -e '${script}'`, (error) => {
      if (error) {
        console.error('Failed to paste via AppleScript:', error.message);
        showOverlay('success', { text: 'Copied! Press Cmd+V to paste' });
      } else {
        console.log('Text pasted successfully');
        showOverlay('success', { text });
      }

      setTimeout(() => {
        hideOverlay();
        resetToIdle();
      }, 1500);
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
    console.log('Updating recorder with new API key');
    recorderWindow.webContents.send('set-api-key', config.apiKey);
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

ipcMain.on('transcription-result', (event, text) => {
  console.log('Received transcription:', text);

  if (text && text.trim()) {
    insertText(text);
  } else {
    console.log('No speech detected');
    showOverlay('error', { error: 'No speech detected' });
    setTimeout(() => {
      hideOverlay();
      resetToIdle();
    }, 2000);
  }
});

ipcMain.on('transcription-error', (event, error) => {
  console.error('Transcription error:', error);

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
  console.log('Recording status:', status);
});

ipcMain.on('audio-levels', (event, levels) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('audio-levels', levels);
  }
});

ipcMain.on('close-overlay', () => {
  // If recording, cancel it; otherwise just hide overlay
  if (isRecording) {
    cancelRecording();
  } else {
    hideOverlay();
    resetToIdle();
  }
});

ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

// ============================================
// App Lifecycle
// ============================================

app.whenReady().then(() => {
  console.log('App ready, initializing...');

  // Check Accessibility permission
  const trusted = systemPreferences.isTrustedAccessibilityClient(true);
  console.log('Accessibility permission:', trusted ? 'granted' : 'not granted');

  createRecorderWindow();
  createTray();

  // Show settings if no API key
  if (!config.apiKey) {
    console.log('No API key configured, showing settings');
    createSettingsWindow();
  } else {
    console.log('API key found in config');
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
  } else {
    console.log('Shortcut registered:', shortcut);
  }

  console.log('Whisp ready');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (!settingsWindow && !config.apiKey) {
    createSettingsWindow();
  }
});
