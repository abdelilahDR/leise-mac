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
    focusable: false,
    type: 'panel', // macOS: doesn't activate app when shown
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

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

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      accelerator: 'Ctrl+Space',
      click: () => toggleRecording(),
    },
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
  // Copy to clipboard
  clipboard.writeText(text);

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
        showOverlay('success', { text });
      }

      setTimeout(() => {
        hideOverlay();
        resetToIdle();
      }, 3000);
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

ipcMain.on('transcription-result', (event, text) => {
  // Skip normal processing if this is a test recording from onboarding
  if (isTestRecording) {
    return;
  }

  if (text && text.trim()) {
    insertText(text);
  } else {
    showOverlay('error', { error: 'No speech detected' });
    setTimeout(() => {
      hideOverlay();
      resetToIdle();
    }, 2000);
  }
});

ipcMain.on('transcription-error', (event, error) => {
  console.error('Transcription error:', error);

  // Skip normal processing if this is a test recording from onboarding
  if (isTestRecording) {
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
  // Status received from recorder (started, stopped, cancelled)
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
