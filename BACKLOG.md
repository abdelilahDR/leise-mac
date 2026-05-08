# Whisp backlog

Ideas captured for later — not prioritized, not committed to.

## High-value next steps

- [ ] **LLM cleanup pass.** After Whisper returns text, optionally run it through a fast Groq LLM (e.g. `llama-3.3-70b-versatile`) to strip filler words ("um", "uh"), fix punctuation, and remove false starts. Toggle in settings; maybe a separate hotkey for "raw" vs "cleaned" output. Adds ~300–800ms latency. Trade-off: loses verbatim fidelity, so users who want exact-spoken output need to keep it off.
- [ ] **Custom prompt / vocabulary.** Pass a user-provided string via Whisper's `prompt` parameter listing proper nouns, jargon, code terms, names. One-line API change; dramatic accuracy improvement on names and domain words. UI: a multiline text field in Settings.
- [ ] **Reapply stashed WIP** (`stash@{0}` in main repo). Includes:
  - `WHISP_DEV=1` dev mode (renames app to "Whisp Dev", separate userData dir, auto-DevTools, seeds config from installed app). Would have saved us hours during v1.5.0 debugging.
  - `soundsEnabled` config + conditional `playSound` calls.
  - `autoPasteEnabled` config (currently insertText is unconditional).
  - `preferredInputDeviceId` for picking a specific microphone.
  - Settings window expanded to 620px to host these toggles.
  - Needs reconciliation with current v1.5.0 — `playSound` and IPC handlers moved.

## Medium-value

- [ ] **Local Whisper (whisper.cpp)** with Core ML on Apple Silicon. `base.en` is sub-second for short clips, fully offline. Adds binary/model bundling, audio format conversion (webm→wav), download UX. Worth doing if Groq ever goes down or feels slow.
- [ ] **Auto-stop on silence.** Detect end of utterance via VAD (already have `analyser` in recorder.html), stop recording automatically after N seconds of silence. Saves the second hotkey press.
- [ ] **Multiple shortcuts for modes.** e.g. `Ctrl+Space` = raw paste, `Ctrl+Alt+Space` = LLM-cleaned, `Ctrl+Shift+Space` = "format as email/bullets". Pairs naturally with the LLM cleanup item.
- [ ] **History search / export.** Tray submenu is fine for last 20, but full search + export-to-file would help when looking up something said weeks ago.

## Bugs

- [ ] **Transcription hangs after long uptime / Mac sleep.** After running for a while, recordings get stuck on "Transcribing…" forever and only restarting the app fixes it. Suspected cause: shared `AudioContext` ([src/recorder.html:19](src/recorder.html:19)) and long-lived hidden recorder `BrowserWindow` accumulate bad state — `MediaRecorder.onstop` silently never fires, so the fetch never starts (which is why the 10s fetch timeout doesn't help).
  - **Cheap mitigation:** watchdog timer in main.js — if overlay sits in `'transcribing'` for >15s with no result, force-reset state and show an error. ~20 lines.
  - **Cleaner fix:** fresh AudioContext + MediaRecorder per recording (don't share `sharedAudioContext`), plus subscribe to Electron's `powerMonitor` `suspend`/`resume` events and recycle the recorder window on wake.

## Lower priority

- [ ] Better waveform visualization in the overlay.
- [ ] Settings option to choose Whisper model variant explicitly (turbo vs v3 vs distil if it returns).
