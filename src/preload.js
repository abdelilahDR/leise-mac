const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods for renderer processes
contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  testApiKey: (apiKey) => ipcRenderer.invoke('test-api-key', apiKey),

  // Recording
  onStartRecording: (callback) => ipcRenderer.on('start-recording', callback),
  onStopRecording: (callback) => ipcRenderer.on('stop-recording', callback),
  onCancelRecording: (callback) => ipcRenderer.on('cancel-recording', callback),

  sendTranscriptionResult: (text) => ipcRenderer.send('transcription-result', text),
  sendTranscriptionError: (error) => ipcRenderer.send('transcription-error', error),
  sendRecordingStatus: (status) => ipcRenderer.send('recording-status', status),
  sendAudioLevel: (level) => ipcRenderer.send('audio-level', level),

  // Overlay
  onUpdateOverlay: (callback) => ipcRenderer.on('update-overlay', callback),
  onAudioLevels: (callback) => ipcRenderer.on('audio-levels', callback),
  closeOverlay: () => ipcRenderer.send('close-overlay'),

  // Settings window
  onShowSettings: (callback) => ipcRenderer.on('show-settings', callback),
  closeSettings: () => ipcRenderer.send('close-settings'),
});
