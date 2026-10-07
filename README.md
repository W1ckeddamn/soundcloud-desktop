# SoundCloud Desktop (Python Edition)

[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-black?style=flat-square)](https://www.microsoft.com/windows)
[![Framework: Python WebView2](https://img.shields.io/badge/Framework-Python%20%2F%20WebView2-black?style=flat-square)](https://pywebview.flowrl.com/)
[![Vibecoded](https://img.shields.io/badge/Project-Vibecoded-black?style=flat-square)](#)

> **Notice**: This project is vibecoded. Developed through AI-assisted pair programming and iterative implementation.

A lightweight Windows desktop client for SoundCloud built with Python and Microsoft Edge WebView2. This edition replaces the Electron framework to reduce system memory overhead (~150-230 MB total combined footprint) while maintaining full feature parity with the native desktop experience.

---

## Features

### Windows Taskbar Thumbnail Toolbar
- Native thumbnail toolbar controls directly inside the Windows taskbar hover preview:
  - Previous Track
  - Play / Pause (dynamically synchronized with playback state)
  - Next Track
- Implemented via Win32 `ITaskbarList3` COM interface with subclassed window procedure handling.
- Automatic button state synchronization (buttons disable when actions are unavailable).

### Taskbar Playback Progress
- Real-time track progress displayed on the taskbar icon via `ITaskbarList3::SetProgressValue`.
- State indication (`TBPF_NORMAL` green during active playback, `TBPF_PAUSED` yellow when paused, hidden when inactive).

### Hardware Media Keys Support
- Global keyboard media keys (`MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack`) hooked via Win32 `RegisterHotKey`.
- Functions globally even when the window is minimized or unfocused.

### Discord Rich Presence (RPC)
- Broadcasts current playback state to Discord as **Listening to SoundCloud** (`ActivityType.LISTENING`).
- Includes:
  - Track title and artist name
  - High-resolution album artwork (500x500)
  - Real-time animated duration progress bar (elapsed and remaining time)
  - Direct "Listen on SoundCloud" button linking to the playing track
  - Play and Pause status indicators
- Configurable directly from the System Tray context menu.

### System Tray Integration
- Notification area presence using `pystray` and official SoundCloud iconography.
- Context menu capabilities:
  - Currently playing track information
  - Play / Pause, Next Track, and Previous Track controls
  - Show / Hide window toggle (default click action)
  - Close to Tray behavior configuration
  - Discord Rich Presence toggle
  - Clean application termination
- Persistent background operation when minimized or closed to tray.

### Performance and Memory Optimization
- Utilizes the operating system's shared Microsoft Edge WebView2 Evergreen runtime.
- Eliminates bundled Chromium and Node.js runtimes, reducing working memory usage.
- Persistent session storage for cookies, preferences, and authentication tokens in `%APPDATA%\SoundCloudDesktopPy`.

### UI Adjustments
- Automated suppression of OneTrust cookie banners and modal overlays.
- Elimination of `.onetrust-pc-dark-filter` backdrop layers.
- Custom dark scrollbar styling.
- Window bounds, state, and coordinates saved across sessions.

---

## Requirements

- Windows 10 or Windows 11 (64-bit)
- Python 3.10 or later
- Microsoft Edge WebView2 Runtime (installed by default on Windows 10/11)

---

## Installation

1. Clone or checkout the `feature/python-webview` branch:
   ```bash
   git checkout feature/python-webview
   ```

2. Install the required Python packages:
   ```bash
   pip install -r requirements.txt
   ```

3. Launch the application:
   ```bash
   python app.py
   ```
   Or use the included launcher script:
   ```bash
   run_python.bat
   ```

---

## Dependencies

- `pywebview`: High-level desktop GUI wrapper around Microsoft Edge WebView2.
- `pythonnet`: Common Language Runtime (.NET) bridge for Windows Forms control access.
- `pypresence`: Discord Rich Presence client library.
- `pystray`: System tray icon and context menu implementation.
- `Pillow`: Image processing library for icon rendering.
- `comtypes`: Component Object Model (COM) interoperability for Win32 API calls.

---

## Project Structure

```text
├── assets/
│   ├── icon.ico               # Multi-resolution application icon
│   ├── icon.png               # High-resolution logo
│   ├── tray.png               # System tray icon
│   └── thumbar/               # Taskbar thumbnail button icon assets
├── app.py                     # Main application entry point (webview, tray, lifecycle)
├── discord_rpc.py             # Discord Rich Presence manager
├── taskbar.py                 # Win32 ITaskbarList3 and media hotkeys implementation
├── requirements.txt           # Python package requirements
├── run_python.bat             # Silent launcher batch script
└── README.md                  # Project documentation
```

---

## License

This project is licensed under the MIT License. SoundCloud is a registered trademark of SoundCloud Global Limited & Co. KG. This application is an unofficial, community-developed client.
