# SoundCloud Desktop

[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-black?style=flat-square)](https://www.microsoft.com/windows)
[![Built with Electron](https://img.shields.io/badge/Framework-Electron-black?style=flat-square)](https://www.electronjs.org)
[![Vibecoded](https://img.shields.io/badge/Project-Vibecoded-black?style=flat-square)](#)

> **Notice**: This project is vibecoded. Developed through AI-assisted pair programming and iterative implementation.

A standalone Windows desktop client for SoundCloud built on Electron. It provides native operating system integration, including Windows Taskbar Thumbnail Toolbar controls, live taskbar playback progress indicators, system tray management, and Discord Rich Presence.

---

## Features

### Windows Taskbar Thumbnail Toolbar
- Native thumbnail toolbar controls directly inside the Windows taskbar hover preview:
  - Previous Track
  - Play / Pause (toggles icon and tooltip dynamically according to playback state)
  - Next Track
- Automatic button state synchronization (buttons disable when actions are unavailable).

### Taskbar Playback Progress
- Real-time track progress displayed directly on the application taskbar icon.
- Progress state tracking (active progress bar during playback, paused state when halted).

### Discord Rich Presence (RPC)
- Broadcasts current playback state to Discord as **Listening to SoundCloud**.
- Includes:
  - Track title and artist name
  - High-resolution album artwork (500x500)
  - Real-time animated duration progress bar (elapsed and remaining time)
  - Direct "Listen on SoundCloud" button linking to the playing track
  - Play and Pause status indicators
- Can be toggled on or off at any time via the System Tray menu.

### System Tray Integration
- Runs in the Windows notification area with the official SoundCloud icon.
- Context menu capabilities:
  - Currently playing track information
  - Play / Pause, Next, and Previous controls
  - Show / Hide main window toggle
  - Close to Tray behavior configuration
  - Launch on Windows Startup toggle
  - Discord Rich Presence toggle
  - Clean application termination
- Single-clicking the tray icon toggles window visibility.

### Authentication and Navigation Handling
- Internal popup window management for third-party OAuth providers:
  - Google Sign-In (configured with sanitized request headers and user agent fallback to prevent embedded browser blocks)
  - Facebook Login
  - Apple ID
- Explicit handling of internal and protocol-less requests (`about:blank`, `blob:`, `javascript:`) to eliminate external application handler prompts.
- Outbound hyperlinks (such as artist links in track descriptions) open in the user's default external browser.

### Audio Continuity and UI Adjustments
- Automated suppression of OneTrust cookie banners and modal overlays without modifying document structure.
- Disabled Chromium background timer and renderer throttling to ensure continuous, stutter-free audio when minimized.
- Hardware media keys support (`MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack`).
- Window size, coordinates, and maximize status saved across restarts.
- Custom dark scrollbar styling.

---

## Requirements

- Windows 10 or Windows 11 (64-bit)
- Node.js 18.0.0 or later
- npm 9.0.0 or later

---

## Getting Started

### Development

1. Navigate to the project root:
   ```bash
   cd D:\soundcloud-desktop
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Launch the application:
   ```bash
   npm start
   ```

---

## Packaging

To package the application into a standalone Windows executable:

```bash
npm run dist
```

The packaged distribution will be located at:
```text
dist/SoundCloud-win32-x64/SoundCloud.exe
```

To regenerate multi-resolution application icons and thumbnail toolbar buttons:
```bash
npm run build:assets
```

---

## Project Structure

```text
├── assets/
│   ├── icon.ico               # Multi-resolution executable icon (16x16 to 256x256)
│   ├── icon.png               # High-resolution application logo
│   ├── tray.png               # System tray icon
│   └── thumbar/               # Taskbar thumbnail button assets
├── scripts/
│   ├── build-official-icon.js # High-quality asset scaling script
│   └── setup-shortcut.js      # Windows desktop shortcut utility
├── src/
│   ├── main.js                # Main Electron process (lifecycle, window, tray, taskbar)
│   ├── preload.js             # DOM bridge, state observation, and media IPC
│   └── discord-rpc.js         # Discord Rich Presence IPC client
├── package.json
└── run.bat                    # Quick launch batch script
```

---

## License

This project is licensed under the MIT License. SoundCloud is a registered trademark of SoundCloud Global Limited & Co. KG. This application is an unofficial, community-developed client.
