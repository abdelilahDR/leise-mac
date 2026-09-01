const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods for renderer processes
// Sandboxed preloads cannot require local modules; the name comes from main.
contextBridge.exposeInMainWorld('electronAPI', {
  productName: ipcRenderer.sendSync('get-product-name'),
  // Settings
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  testApiKey: (apiKey) => ipcRenderer.invoke('test-api-key', apiKey),
  testGroqApiKey: (apiKey) => ipcRenderer.invoke('test-groq-api-key', apiKey),

  // Recording - receive commands (wrap callbacks for contextBridge compatibility)
  onStartRecording: (callback) => ipcRenderer.on('start-recording', () => callback()),
  onStopRecording: (callback) => ipcRenderer.on('stop-recording', () => callback()),
  onCancelRecording: (callback) => ipcRenderer.on('cancel-recording', () => callback()),
  onAbortTranscription: (callback) => ipcRenderer.on('abort-transcription', () => callback()),
  onSetApiKey: (callback) => ipcRenderer.on('set-api-key', (_event, value) => callback(value)),
  onSetGroqApiKey: (callback) => ipcRenderer.on('set-groq-api-key', (_event, value) => callback(value)),
  onSetTranscriptionProvider: (callback) => ipcRenderer.on('set-transcription-provider', (_event, value) => callback(value)),

  // Recording - send results
  sendTranscriptionResult: (text, elapsedMs) => ipcRenderer.send('transcription-result', text, elapsedMs),
  sendTranscriptionError: (error) => ipcRenderer.send('transcription-error', error),
  sendRecordingStatus: (status) => ipcRenderer.send('recording-status', status),
  sendAudioLevels: (levels) => ipcRenderer.send('audio-levels', levels),
  notifyNetworkChange: (state) => ipcRenderer.send('network-changed', state),
  notifyTranscriptionAttempt: (info) => ipcRenderer.send('transcription-attempt', info),
  flushNetwork: (reason) => ipcRenderer.send('flush-network', reason),
  onTestTranscriptionPlan: (callback) => ipcRenderer.on('test-transcription-plan', (_event, plan) => callback(plan)),
  onTestCleanupPlan: (callback) => ipcRenderer.on('test-cleanup-plan', (_event, plan) => callback(plan)),

  // Overlay (wrap callbacks for contextBridge compatibility)
  onUpdateOverlay: (callback) => ipcRenderer.on('update-overlay', (_event, data) => callback(data)),
  onAudioLevels: (callback) => ipcRenderer.on('audio-levels', (_event, levels) => callback(levels)),
  closeOverlay: () => ipcRenderer.send('close-overlay'),

  // Settings window
  onShowSettings: (callback) => ipcRenderer.on('show-settings', () => callback()),
  closeSettings: () => ipcRenderer.send('close-settings'),

  // Onboarding - Permission checks
  checkMicrophone: () => ipcRenderer.invoke('check-microphone'),
  requestMicrophone: () => ipcRenderer.invoke('request-microphone'),
  checkAccessibility: () => ipcRenderer.invoke('check-accessibility'),
  requestAccessibility: () => ipcRenderer.invoke('request-accessibility'),

  // Onboarding - Test recording
  startTestRecording: () => ipcRenderer.invoke('start-test-recording'),
  stopTestRecording: () => ipcRenderer.invoke('stop-test-recording'),

  // Onboarding - Complete
  completeOnboarding: () => ipcRenderer.invoke('complete-onboarding'),

  // Links + window hops
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openSettingsWindow: () => ipcRenderer.send('open-settings'),
  reportHeight: (height) => ipcRenderer.send('content-height', height),
});
