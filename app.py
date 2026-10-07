import os
import sys
import json
import time
import ctypes
import threading
from ctypes import wintypes
from PIL import Image
import pystray
import webview
from webview.platforms.winforms import BrowserView

from discord_rpc import DiscordRPCManager
from taskbar import TaskbarManager

# Set Windows AppUserModelId for taskbar grouping and thumbnail toolbar
try:
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("com.soundcloud.desktop.py")
except Exception:
    pass

# User Agent matching standard Google Chrome on Windows 10/11
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Paths
APP_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(APP_DIR, "assets")
ICON_ICO = os.path.join(ASSETS_DIR, "icon.ico")
TRAY_PNG = os.path.join(ASSETS_DIR, "tray.png")

SETTINGS_DIR = os.path.join(os.getenv("APPDATA", APP_DIR), "SoundCloudDesktopPy")
SETTINGS_FILE = os.path.join(SETTINGS_DIR, "settings.json")
STORAGE_PATH = os.path.join(SETTINGS_DIR, "web_cache")

# Default settings
DEFAULT_SETTINGS = {
    "window_bounds": {"width": 1280, "height": 860},
    "is_maximized": False,
    "close_to_tray": True,
    "discord_rpc": True
}

def load_settings():
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {**DEFAULT_SETTINGS, **data}
    except Exception as e:
        print(f"[Settings] Error loading: {e}")
    return dict(DEFAULT_SETTINGS)

def save_settings(settings):
    try:
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
    except Exception as e:
        print(f"[Settings] Error saving: {e}")

# Single instance lock using Win32 Mutex
ERROR_ALREADY_EXISTS = 183
mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "SoundCloudDesktopPySingleInstanceMutex")
if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
    hwnd = ctypes.windll.user32.FindWindowW(None, "SoundCloud")
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        ctypes.windll.user32.SetForegroundWindow(hwnd)
    sys.exit(0)

# JavaScript Injected Script
INJECTED_JS = r"""
(function() {
    if (window.__sc_desktop_injected) return;
    window.__sc_desktop_injected = true;

    // MediaSession action handlers hook
    const mediaSessionHandlers = {};
    if (typeof navigator !== 'undefined' && navigator.mediaSession) {
        const origSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
        navigator.mediaSession.setActionHandler = (action, handler) => {
            mediaSessionHandlers[action] = handler;
            return origSetActionHandler(action, handler);
        };
    }

    // Auto-dismiss OneTrust banner and eliminate dark overlay
    function removeOneTrust() {
        try {
            const cookieBtn = document.querySelector('#onetrust-accept-btn-handler');
            if (cookieBtn) cookieBtn.click();
            const filter = document.querySelector('.onetrust-pc-dark-filter');
            if (filter) filter.remove();
            if (document.body && document.body.classList.contains('ot-overlay-open')) {
                document.body.classList.remove('ot-overlay-open');
            }
        } catch (e) {}
    }

    // Parse time strings into seconds
    function parseSeconds(str) {
        if (!str || typeof str !== 'string') return 0;
        const clean = str.replace(/^-/, '').trim();
        const parts = clean.split(':').map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0] || 0;
    }

    let lastState = {
        isPlaying: false,
        hasTrack: false,
        title: '',
        artist: '',
        artwork: '',
        progress: 0,
        timePassed: '',
        duration: '',
        canPrev: false,
        canNext: false,
        isLiked: false
    };

    function getPlayerState() {
        const playBtn = document.querySelector('.playControl, .playControls__play');
        const nextBtn = document.querySelector('.skipControl__next, .playControls__next');
        const prevBtn = document.querySelector('.skipControl__previous, .playControls__prev');
        const badge = document.querySelector('.playbackSoundBadge');
        const titleEl = badge ? badge.querySelector('.playbackSoundBadge__titleLink, .playbackSoundBadge__title, a.playbackSoundBadge__lightLink + a') : null;
        const artistEl = badge ? badge.querySelector('.playbackSoundBadge__lightLink') : null;
        const avatarEl = badge ? badge.querySelector('.playbackSoundBadge__avatar') : null;
        const likeBtn = badge ? badge.querySelector('.playbackSoundBadge__like') : null;
        const timePassedEl = document.querySelector('.playbackTimeline__timePassed > span[aria-hidden="true"], .playbackTimeline__timePassed');
        const durationEl = document.querySelector('.playbackTimeline__duration > span[aria-hidden="true"], .playbackTimeline__duration');
        const progressWrapper = document.querySelector('.playbackTimeline__progressWrapper');

        const isPlaying = playBtn ? (playBtn.classList.contains('playing') || (playBtn.title && (playBtn.title.toLowerCase().includes('pause') || playBtn.title.toLowerCase().includes('приостанов')))) : false;
        const isDisabled = playBtn ? playBtn.classList.contains('disabled') : true;

        let title = '';
        let artist = '';
        let artwork = '';

        if (navigator.mediaSession && navigator.mediaSession.metadata) {
            const meta = navigator.mediaSession.metadata;
            title = meta.title || '';
            artist = meta.artist || '';
            if (meta.artwork && meta.artwork.length > 0) {
                artwork = meta.artwork[meta.artwork.length - 1].src || '';
            }
        }

        if (!title && titleEl) {
            title = (titleEl.innerText || titleEl.getAttribute('title') || '').trim();
        }
        if (!artist && artistEl) {
            artist = (artistEl.innerText || artistEl.getAttribute('title') || '').trim();
        }

        if (!artwork && avatarEl) {
            const img = avatarEl.querySelector('img');
            if (img && img.src) {
                artwork = img.src;
            } else {
                const bgSpan = avatarEl.querySelector('span[style*="background-image"]');
                if (bgSpan) {
                    const match = bgSpan.style.backgroundImage.match(/url\(["']?([^"']*)["']?\)/);
                    if (match) artwork = match[1];
                }
            }
        }

        // Upgrade thumbnail to 500x500 high-res
        if (artwork && artwork.includes('-t50x50.')) {
            artwork = artwork.replace('-t50x50.', '-t500x500.');
        }

        let trackUrl = '';
        const titleLink = badge ? badge.querySelector('a.playbackSoundBadge__titleLink, a.playbackSoundBadge__title') : null;
        if (titleLink && titleLink.href) {
            trackUrl = titleLink.href;
        }

        let progress = 0;
        if (progressWrapper && progressWrapper.hasAttribute('aria-valuenow')) {
            const now = parseFloat(progressWrapper.getAttribute('aria-valuenow') || '0');
            const max = parseFloat(progressWrapper.getAttribute('aria-valuemax') || '1');
            if (max > 0) progress = Math.min(1, Math.max(0, now / max));
        }

        const timePassed = timePassedEl ? timePassedEl.innerText.trim() : '';
        const duration = durationEl ? durationEl.innerText.trim() : '';

        const currentSeconds = parseSeconds(timePassed);
        let durationSeconds = parseSeconds(duration);
        if (duration.startsWith('-')) {
            durationSeconds = currentSeconds + durationSeconds;
        }

        const hasTrack = !isDisabled || Boolean(title);
        const canNext = nextBtn ? !nextBtn.classList.contains('disabled') : false;
        const canPrev = prevBtn ? !prevBtn.classList.contains('disabled') : false;
        const isLiked = likeBtn ? likeBtn.classList.contains('sc-button-selected') : false;

        return {
            isPlaying,
            hasTrack,
            title,
            artist,
            artwork,
            trackUrl,
            progress,
            timePassed,
            duration,
            currentSeconds,
            durationSeconds,
            canPrev,
            canNext,
            isLiked
        };
    }

    function checkState() {
        try {
            const state = getPlayerState();
            const changed =
                state.isPlaying !== lastState.isPlaying ||
                state.hasTrack !== lastState.hasTrack ||
                state.title !== lastState.title ||
                state.artist !== lastState.artist ||
                state.canNext !== lastState.canNext ||
                state.canPrev !== lastState.canPrev ||
                Math.abs(state.progress - lastState.progress) > 0.01;

            if (changed) {
                lastState = state;
                if (window.pywebview && window.pywebview.api && window.pywebview.api.on_player_state) {
                    window.pywebview.api.on_player_state(state);
                }
            }
        } catch (e) {}
    }

    // Playback control interface
    window.__sc_command = function(cmd, arg) {
        try {
            switch (cmd) {
                case 'togglePlay': {
                    const playBtn = document.querySelector('.playControl, .playControls__play');
                    if (playBtn) {
                        playBtn.click();
                    } else if (mediaSessionHandlers.play || mediaSessionHandlers.pause) {
                        if (lastState.isPlaying && mediaSessionHandlers.pause) mediaSessionHandlers.pause();
                        else if (!lastState.isPlaying && mediaSessionHandlers.play) mediaSessionHandlers.play();
                    } else {
                        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', keyCode: 32, which: 32, bubbles: true }));
                    }
                    break;
                }
                case 'play': {
                    if (!lastState.isPlaying) {
                        const playBtn = document.querySelector('.playControl, .playControls__play');
                        if (playBtn) playBtn.click();
                        else if (mediaSessionHandlers.play) mediaSessionHandlers.play();
                    }
                    break;
                }
                case 'pause': {
                    if (lastState.isPlaying) {
                        const playBtn = document.querySelector('.playControl, .playControls__play');
                        if (playBtn) playBtn.click();
                        else if (mediaSessionHandlers.pause) mediaSessionHandlers.pause();
                    }
                    break;
                }
                case 'next': {
                    const nextBtn = document.querySelector('.skipControl__next, .playControls__next');
                    if (nextBtn) {
                        nextBtn.click();
                    } else if (mediaSessionHandlers.nexttrack) {
                        mediaSessionHandlers.nexttrack();
                    } else {
                        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', keyCode: 39, which: 39, shiftKey: true, bubbles: true }));
                    }
                    break;
                }
                case 'prev': {
                    const prevBtn = document.querySelector('.skipControl__previous, .playControls__prev');
                    if (prevBtn) {
                        prevBtn.click();
                    } else if (mediaSessionHandlers.previoustrack) {
                        mediaSessionHandlers.previoustrack();
                    } else {
                        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', keyCode: 37, which: 37, shiftKey: true, bubbles: true }));
                    }
                    break;
                }
                case 'like': {
                    const likeBtn = document.querySelector('.playbackSoundBadge__like');
                    if (likeBtn) likeBtn.click();
                    break;
                }
            }
        } catch (e) {
            console.error('[SC] Command error:', e);
        }
        setTimeout(checkState, 100);
    };

    // Inject styles for dark scrollbar and dark filter suppression
    const style = document.createElement('style');
    style.id = 'sc-desktop-style';
    style.textContent = `
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: #111111;
        }
        ::-webkit-scrollbar-thumb {
            background: #333333;
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #ff5500;
        }
        .onetrust-pc-dark-filter,
        div[class*="onetrust-pc-dark-filter"] {
            display: none !important;
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
            z-index: -999999 !important;
        }
        body.ot-overlay-open {
            overflow: auto !important;
        }
    `;
    document.head.appendChild(style);

    removeOneTrust();
    checkState();

    // DOM Observer
    const observer = new MutationObserver(() => {
        checkState();
        removeOneTrust();
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'title', 'aria-valuenow']
    });

    // Event listener when pywebview is ready
    window.addEventListener('pywebviewready', () => {
        checkState();
    });

    setInterval(checkState, 250);
})();
"""

class SoundCloudApp:
    def __init__(self):
        self.settings = load_settings()
        self.window = None
        self.form = None
        self.hwnd = None
        self.taskbar = None
        self.tray = None
        self.discord = DiscordRPCManager()
        self.is_quitting = False
        self.current_state = {
            "isPlaying": False,
            "hasTrack": False,
            "title": "",
            "artist": "",
            "artwork": "",
            "trackUrl": "",
            "progress": 0,
            "canPrev": False,
            "canNext": False
        }

        if self.settings.get("discord_rpc", True):
            threading.Thread(target=self.discord.connect, daemon=True).start()

    def send_command(self, cmd):
        def _exec():
            try:
                if self.window:
                    self.window.evaluate_js(f"window.__sc_command && window.__sc_command('{cmd}');")
            except Exception as e:
                print(f"[App] Command execute error: {e}")
        threading.Thread(target=_exec, daemon=True).start()

    def on_player_state(self, state):
        self.current_state = state or {}
        title = self.current_state.get("title", "")
        artist = self.current_state.get("artist", "")
        is_playing = bool(self.current_state.get("isPlaying", False))
        has_track = bool(self.current_state.get("hasTrack", False))
        can_prev = bool(self.current_state.get("canPrev", False))
        can_next = bool(self.current_state.get("canNext", False))
        progress = float(self.current_state.get("progress", 0))

        # 1. Update Window Title
        if self.window:
            if has_track and title:
                self.window.set_title(f"{title} - {artist or 'SoundCloud'}")
            else:
                self.window.set_title("SoundCloud")

        # 2. Update Taskbar
        if self.taskbar:
            self.taskbar.update_thumbar(has_track, is_playing, can_prev, can_next)
            self.taskbar.set_progress(progress if has_track else 0, is_playing)

        # 3. Update Discord RPC
        if self.settings.get("discord_rpc", True):
            self.discord.update_state(self.current_state)

        # 4. Update Tray Tooltip & Menu
        self.update_tray_menu()

    def on_taskbar_command(self, cmd_id):
        # 101: Prev, 102: Play/Pause, 103: Next
        if cmd_id == 101:
            self.send_command("prev")
        elif cmd_id == 102:
            self.send_command("togglePlay")
        elif cmd_id == 103:
            self.send_command("next")

    def toggle_window(self):
        if not self.window:
            return
        if not self.form:
            self.form = BrowserView.instances.get(self.window.uid)
        if self.form:
            if self.form.Visible:
                self.window.hide()
            else:
                self.window.show()
                try:
                    ctypes.windll.user32.SetForegroundWindow(self.hwnd)
                except Exception:
                    pass

    def toggle_discord_rpc(self, icon, item):
        new_val = not self.settings.get("discord_rpc", True)
        self.settings["discord_rpc"] = new_val
        save_settings(self.settings)
        self.discord.set_enabled(new_val)
        if new_val:
            self.discord.update_state(self.current_state)

    def toggle_close_to_tray(self, icon, item):
        self.settings["close_to_tray"] = not self.settings.get("close_to_tray", True)
        save_settings(self.settings)

    def update_tray_menu(self):
        if not self.tray:
            return
        title = self.current_state.get("title", "")
        artist = self.current_state.get("artist", "")
        is_playing = bool(self.current_state.get("isPlaying", False))
        has_track = bool(self.current_state.get("hasTrack", False))

        tooltip = f"{title} - {artist}" if (has_track and title) else "SoundCloud Desktop"
        self.tray.title = tooltip[:63]

        header_label = f"{title} - {artist}" if (has_track and title) else "No track playing"

        menu = pystray.Menu(
            pystray.MenuItem(header_label, lambda: None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Pause" if is_playing else "Play", lambda: self.send_command("togglePlay"), enabled=has_track),
            pystray.MenuItem("Next Track", lambda: self.send_command("next"), enabled=has_track),
            pystray.MenuItem("Previous Track", lambda: self.send_command("prev"), enabled=has_track),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Show / Hide SoundCloud", lambda: self.toggle_window(), default=True),
            pystray.MenuItem("Close to Tray", self.toggle_close_to_tray, checked=lambda item: self.settings.get("close_to_tray", True)),
            pystray.MenuItem("Discord Rich Presence", self.toggle_discord_rpc, checked=lambda item: self.settings.get("discord_rpc", True)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda: self.quit())
        )
        self.tray.menu = menu

    def setup_tray(self):
        try:
            tray_img = Image.open(TRAY_PNG) if os.path.exists(TRAY_PNG) else Image.open(ICON_ICO)
            self.tray = pystray.Icon("SoundCloud", tray_img, "SoundCloud Desktop")
            self.update_tray_menu()
            self.tray.run_detached()
        except Exception as e:
            print(f"[Tray] Init error: {e}")

    def on_closing(self):
        if self.settings.get("close_to_tray", True) and not self.is_quitting:
            self.window.hide()
            return False
        self.cleanup()
        return True

    def cleanup(self):
        self.is_quitting = True
        try:
            if self.taskbar:
                self.taskbar.destroy()
        except Exception:
            pass
        try:
            self.discord.close()
        except Exception:
            pass
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass

    def quit(self):
        self.is_quitting = True
        self.cleanup()
        if self.window:
            self.window.destroy()
        sys.exit(0)

    def on_loaded(self):
        # Inject script on page load
        def _inject():
            time.sleep(0.5)
            try:
                self.window.evaluate_js(INJECTED_JS)
            except Exception as e:
                print(f"[App] JS inject error: {e}")
        threading.Thread(target=_inject, daemon=True).start()

    def run(self):
        class JsApi:
            def __init__(self, app):
                self.app = app
            def on_player_state(self, state):
                self.app.on_player_state(state)
                return True

        js_api = JsApi(self)

        bounds = self.settings.get("window_bounds", {"width": 1280, "height": 860})
        width = max(800, bounds.get("width", 1280))
        height = max(600, bounds.get("height", 860))

        self.window = webview.create_window(
            title="SoundCloud",
            url="https://soundcloud.com/discover",
            js_api=js_api,
            width=width,
            height=height,
            min_size=(800, 600),
            background_color="#121212"
        )

        self.window.events.closing += self.on_closing
        self.window.events.loaded += self.on_loaded

        def on_started(w):
            time.sleep(1)
            self.form = BrowserView.instances.get(w.uid)
            if self.form:
                self.hwnd = self.form.Handle.ToInt64()
                # Initialize Windows Taskbar Manager
                self.taskbar = TaskbarManager(self.hwnd, self.on_taskbar_command, assets_dir=ASSETS_DIR)
                # Maximize if previously saved
                if self.settings.get("is_maximized", False):
                    try:
                        self.window.maximize()
                    except Exception:
                        pass

            # Setup Tray Icon
            self.setup_tray()

            # Ensure JS injection periodically if page reloads
            def _keep_injected():
                while not self.is_quitting:
                    time.sleep(4)
                    try:
                        is_inj = self.window.evaluate_js("Boolean(window.__sc_desktop_injected);")
                        if not is_inj:
                            self.window.evaluate_js(INJECTED_JS)
                    except Exception:
                        pass
            threading.Thread(target=_keep_injected, daemon=True).start()

        webview.start(
            on_started,
            self.window,
            user_agent=USER_AGENT,
            private_mode=False,
            storage_path=STORAGE_PATH,
            icon=ICON_ICO
        )

if __name__ == "__main__":
    app = SoundCloudApp()
    app.run()
