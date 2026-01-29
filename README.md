# Voice Dictation for Mac

A lightweight macOS menubar app that transcribes your voice to text using OpenAI's Whisper API.

![Voice Dictation](https://img.shields.io/badge/macOS-10.15+-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🎤 **Global Hotkey**: Press `⌘+Shift+Space` anywhere to start/stop recording
- 📝 **Auto-Insert**: Transcribed text is automatically typed at your cursor position
- 🔵 **Menubar Icon**: Visual indicator shows recording status (blue = idle, red = recording)
- ⚡ **Powered by Whisper**: Uses OpenAI's state-of-the-art speech recognition

## Installation

### Prerequisites

1. **Node.js 18+** - [Download](https://nodejs.org/)
2. **OpenAI API Key** - [Get one here](https://platform.openai.com/api-keys)

### Setup

```bash
# Clone the repository
git clone https://github.com/abdelilahDR/voice-dictation-mac.git
cd voice-dictation-mac

# Install dependencies
npm install

# Set your OpenAI API key
export OPENAI_API_KEY=sk-your-key-here

# Run the app
npm start
```

### Build for Distribution

```bash
npm run build
```

This creates a `.dmg` file in the `dist/` folder.

## Usage

1. **Start the app** - A microphone icon appears in your menubar
2. **Press `⌘+Shift+Space`** - The icon turns red, indicating recording
3. **Speak your text** - Talk naturally
4. **Press `⌘+Shift+Space` again** - Recording stops, text is transcribed
5. **Text appears at cursor** - The transcription is typed wherever your cursor is

## Permissions

On first run, macOS will ask for:

- **Microphone Access** - Required for recording
- **Accessibility Access** - Required for typing text at cursor (System Preferences → Security & Privacy → Accessibility)

## Configuration

The app reads the `OPENAI_API_KEY` from your environment. Add it to your shell profile for persistence:

```bash
# ~/.zshrc or ~/.bashrc
export OPENAI_API_KEY=sk-your-key-here
```

## How It Works

1. **Recording**: Uses the Web Audio API via Electron to capture microphone input
2. **Transcription**: Sends audio to OpenAI's Whisper API (`whisper-1` model)
3. **Text Insertion**: Uses AppleScript to simulate keystrokes at the current cursor position

## Troubleshooting

### "Text not appearing"
- Grant Accessibility permission in System Preferences → Security & Privacy → Accessibility
- As a fallback, the app copies text to clipboard

### "Microphone access denied"
- Grant Microphone permission in System Preferences → Security & Privacy → Microphone

### "API error"
- Verify your `OPENAI_API_KEY` is set correctly
- Check you have credits on your OpenAI account

## License

MIT © Moonsight

## Credits

- [OpenAI Whisper](https://openai.com/research/whisper) - Speech recognition
- [Electron](https://electronjs.org/) - Desktop framework
