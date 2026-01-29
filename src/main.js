const { app, Tray, Menu, globalShortcut, nativeImage, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let tray = null;
let recorderWindow = null;
let isRecording = false;

// Icons for different states
const createIcon = (recording) => {
  // Create a simple 16x16 icon using native image
  const size = 16;
  const canvas = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" fill="${recording ? '#FF3B30' : '#007AFF'}" />
      ${recording ? '<circle cx="8" cy="8" r="3" fill="white" />' : ''}
    </svg>
  `;
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(canvas).toString('base64')}`
  );
};

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
  });
}

function createTray() {
  tray = new Tray(createIcon(false));
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Start Recording (⌘⇧Space)', 
      click: () => toggleRecording() 
    },
    { type: 'separator' },
    { 
      label: 'About Voice Dictation',
      click: () => {
        const { dialog } = require('electron');
        dialog.showMessageBox({
          type: 'info',
          title: 'Voice Dictation',
          message: 'Voice Dictation v1.0.0',
          detail: 'Press ⌘+Shift+Space to start/stop recording.\nTranscription powered by OpenAI Whisper.',
        });
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setToolTip('Voice Dictation - ⌘⇧Space to record');
  tray.setContextMenu(contextMenu);
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  if (isRecording) return;
  
  isRecording = true;
  tray.setImage(createIcon(true));
  tray.setToolTip('Recording... Press ⌘⇧Space to stop');
  
  recorderWindow.webContents.send('start-recording');
  console.log('Recording started');
}

function stopRecording() {
  if (!isRecording) return;
  
  isRecording = false;
  tray.setImage(createIcon(false));
  tray.setToolTip('Voice Dictation - ⌘⇧Space to record');
  
  recorderWindow.webContents.send('stop-recording');
  console.log('Recording stopped');
}

// Handle transcription result
ipcMain.on('transcription-result', (event, text) => {
  console.log('Transcription:', text);
  
  if (text && text.trim()) {
    // Use AppleScript to type the text at cursor position
    const { exec } = require('child_process');
    const escapedText = text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    
    const script = `
      tell application "System Events"
        keystroke "${escapedText}"
      end tell
    `;
    
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to insert text:', error);
        // Fallback: copy to clipboard
        const { clipboard } = require('electron');
        clipboard.writeText(text);
        
        // Notify user
        const { Notification } = require('electron');
        new Notification({
          title: 'Voice Dictation',
          body: 'Text copied to clipboard (accessibility permission needed for direct input)',
        }).show();
      }
    });
  }
});

ipcMain.on('transcription-error', (event, error) => {
  console.error('Transcription error:', error);
  
  const { Notification } = require('electron');
  new Notification({
    title: 'Voice Dictation Error',
    body: error,
  }).show();
});

ipcMain.on('recording-status', (event, status) => {
  console.log('Recording status:', status);
});

app.whenReady().then(() => {
  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Missing API Key',
      'Please set the OPENAI_API_KEY environment variable.\n\nExample:\nexport OPENAI_API_KEY=your-key-here'
    );
  }

  createRecorderWindow();
  createTray();

  // Register global shortcut: Cmd+Shift+Space
  const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    toggleRecording();
  });

  if (!ret) {
    console.error('Failed to register global shortcut');
  }

  console.log('Voice Dictation ready. Press ⌘+Shift+Space to record.');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Keep app running in background
app.on('window-all-closed', (e) => {
  e.preventDefault();
});
