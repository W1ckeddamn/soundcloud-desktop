const electron = require('electron');

// Handle case where process is started with ELECTRON_RUN_AS_NODE=1 or via plain node
// In this mode, require('electron') returns the electron binary path string instead of the API object
if (!electron || typeof electron === 'string' || !electron.app) {
  const { spawn } = require('child_process');
  const path = require('path');
  const electronBinary = typeof electron === 'string' ? electron : require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [path.join(__dirname, '..')], {
    env,
    stdio: 'inherit',
    windowsHide: false
  });
  child.on('close', (code) => process.exit(code || 0));
  return;
}

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, globalShortcut, session, screen } = electron;
const path = require('path');
const fs = require('fs');
const discordRPC = require('./discord-rpc');

// Set Windows AppUserModelId for taskbar grouping and thumbnail toolbar
app.setAppUserModelId('com.soundcloud.desktop');

// Command line switches for optimal audio playback, security, and Google Sign-In compatibility
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Mask automation signals (prevents Google from detecting embedded automation context)
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const logFile = path.join(__dirname, '..', 'launch.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      fs.writeFileSync(logFile, `[${new Date().toISOString()}] [LOG ROTATED]\n`);
    }
    fs.appendFile(logFile, line, () => {});
  } catch (e) {}
  if (process.env.DEBUG_SOUNDCLOUD) {
    console.log(`[SoundCloud Desktop] ${msg}`);
  }
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err.stack || err);
});

// Ensure single instance
const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
  app.quit();
  process.exit(0);
}

// Clean standard Chrome User-Agent matching modern desktop Chrome on Windows 10/11
// Removing any Electron or custom token prevents Google from returning 'disallowed_useragent'
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Set global user agent fallback
app.userAgentFallback = CHROME_USER_AGENT;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let thumbarInitialized = false;
let isHiddenInTray = false;

function hideWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isHiddenInTray = true;
  mainWindow.setSkipTaskbar(true);
  mainWindow.minimize();
  updateTray(true);
  log('[Window] Hidden to tray (skipTaskbar + minimize)');
}

function showWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isHiddenInTray = false;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  updateTray(true);
  log('[Window] Restored from tray');
  refreshTaskbarState();
  setTimeout(refreshTaskbarState, 200);
}

function toggleWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isHiddenInTray || mainWindow.isMinimized() || !mainWindow.isVisible()) {
    showWindowFromTray();
  } else {
    hideWindowToTray();
  }
}

// Settings path
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  return {
    windowBounds: { width: 1280, height: 860 },
    isMaximized: false,
    closeToTray: true,
    minimizeToTray: false,
    discordRPC: true
  };
}

function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

function isBoundsOnScreen(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' || typeof bounds.height !== 'number' ||
      bounds.width < 400 || bounds.height < 400) {
    return false;
  }
  try {
    const displays = screen.getAllDisplays();
    return displays.some(display => {
      const { x, y, width, height } = display.bounds;
      return (
        bounds.x < x + width &&
        bounds.x + bounds.width > x &&
        bounds.y < y + height &&
        bounds.y + bounds.height > y
      );
    });
  } catch (e) {
    return bounds.width >= 400 && bounds.height >= 400;
  }
}

const appSettings = loadSettings();

// Player State
let currentState = {
  isPlaying: false,
  hasTrack: false,
  title: '',
  artist: '',
  artwork: '',
  trackUrl: '',
  progress: 0,
  timePassed: '',
  duration: '',
  currentSeconds: 0,
  durationSeconds: 0,
  canPrev: false,
  canNext: false,
  isLiked: false
};

// Paths to icons
const ASSETS_PATH = path.join(__dirname, '..', 'assets');
const THUMBAR_PATH = path.join(ASSETS_PATH, 'thumbar');

const thumbarIcons = {
  play: nativeImage.createFromPath(path.join(THUMBAR_PATH, 'play.png')),
  pause: nativeImage.createFromPath(path.join(THUMBAR_PATH, 'pause.png')),
  prev: nativeImage.createFromPath(path.join(THUMBAR_PATH, 'prev.png')),
  next: nativeImage.createFromPath(path.join(THUMBAR_PATH, 'next.png'))
};

const appIcon = nativeImage.createFromPath(path.join(ASSETS_PATH, 'icon.ico'));
const trayIcon = nativeImage.createFromPath(path.join(ASSETS_PATH, 'icon.ico'));


// Send player command to renderer
function sendPlayerCommand(cmd, arg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:command', cmd, arg);
  }
}

// Update Windows Taskbar Thumbnail Toolbar (ThumbarButtons)
let lastThumbarKey = '';
function updateThumbar(force = false) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || isHiddenInTray) return;

  const { isPlaying, hasTrack, canNext, canPrev } = currentState;
  const thumbarKey = `${isPlaying}_${hasTrack}_${canNext}_${canPrev}`;
  if (!force && thumbarInitialized && thumbarKey === lastThumbarKey) {
    return;
  }

  const playPauseTooltip = isPlaying ? 'Pause' : 'Play';
  const playPauseIcon = isPlaying ? thumbarIcons.pause : thumbarIcons.play;

  const prevFlags = (hasTrack && canPrev) ? [] : ['disabled'];
  const nextFlags = (hasTrack && canNext) ? [] : ['disabled'];
  const playFlags = hasTrack ? [] : ['disabled'];

  const buttons = [
    {
      tooltip: 'Previous Track',
      icon: thumbarIcons.prev,
      flags: prevFlags,
      click() {
        sendPlayerCommand('prev');
      }
    },
    {
      tooltip: playPauseTooltip,
      icon: playPauseIcon,
      flags: playFlags,
      click() {
        sendPlayerCommand('togglePlay');
      }
    },
    {
      tooltip: 'Next Track',
      icon: thumbarIcons.next,
      flags: nextFlags,
      click() {
        sendPlayerCommand('next');
      }
    }
  ];

  try {
    const success = mainWindow.setThumbarButtons(buttons);
    if (success) {
      thumbarInitialized = true;
      lastThumbarKey = thumbarKey;
      log(`[Thumbar] setThumbarButtons succeeded (${thumbarKey})`);
    } else {
      log(`[Thumbar] setThumbarButtons returned false, scheduling retry`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          const retrySuccess = mainWindow.setThumbarButtons(buttons);
          if (retrySuccess) {
            thumbarInitialized = true;
            lastThumbarKey = thumbarKey;
            log(`[Thumbar] Retry setThumbarButtons succeeded`);
          }
        }
      }, 200);
    }
  } catch (err) {
    log(`[Thumbar] Error setting thumbar buttons: ${err.message}`);
  }
}

function refreshTaskbarState() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  lastThumbarKey = '';
  updateThumbar(true);
  updateProgressBar();
}

// Update Windows Taskbar Progress Bar
function updateProgressBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (currentState.hasTrack && currentState.progress > 0) {
    mainWindow.setProgressBar(currentState.progress, {
      mode: currentState.isPlaying ? 'normal' : 'paused'
    });
  } else {
    mainWindow.setProgressBar(-1);
  }
}

// Update System Tray Menu and Tooltip
let lastTrayKey = '';
function updateTray(force = false) {
  if (!tray) return;

  const trackLabel = currentState.title
    ? `${currentState.title} - ${currentState.artist || 'SoundCloud'}`
    : 'SoundCloud Desktop';

  tray.setToolTip(trackLabel);

  const isWinVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && !isHiddenInTray && !mainWindow.isMinimized() && mainWindow.isVisible());
  const trayKey = `${currentState.title}_${currentState.artist}_${currentState.isPlaying}_${currentState.hasTrack}_${currentState.canNext}_${currentState.canPrev}_${appSettings.closeToTray}_${appSettings.minimizeToTray}_${appSettings.discordRPC}_${isWinVisible}`;

  if (!force && trayKey === lastTrayKey) {
    return;
  }
  lastTrayKey = trayKey;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: currentState.title ? currentState.title : 'No track playing',
      sublabel: currentState.artist || undefined,
      enabled: false
    },
    { type: 'separator' },
    {
      label: currentState.isPlaying ? 'Pause' : 'Play',
      enabled: currentState.hasTrack,
      click: () => sendPlayerCommand('togglePlay')
    },
    {
      label: 'Next Track',
      enabled: currentState.hasTrack && currentState.canNext,
      click: () => sendPlayerCommand('next')
    },
    {
      label: 'Previous Track',
      enabled: currentState.hasTrack && currentState.canPrev,
      click: () => sendPlayerCommand('prev')
    },
    { type: 'separator' },
    {
      label: isWinVisible ? 'Hide to Tray' : 'Show SoundCloud',
      click: () => {
        toggleWindowFromTray();
      }
    },
    {
      label: 'Close to Tray',
      type: 'checkbox',
      checked: appSettings.closeToTray,
      click: (menuItem) => {
        appSettings.closeToTray = menuItem.checked;
        saveSettings(appSettings);
        updateTray(true);
      }
    },
    {
      label: 'Minimize to Tray',
      type: 'checkbox',
      checked: Boolean(appSettings.minimizeToTray),
      click: (menuItem) => {
        appSettings.minimizeToTray = menuItem.checked;
        saveSettings(appSettings);
        updateTray(true);
      }
    },
    {
      label: 'Discord Rich Presence',
      type: 'checkbox',
      checked: appSettings.discordRPC !== false,
      click: (menuItem) => {
        appSettings.discordRPC = menuItem.checked;
        saveSettings(appSettings);
        discordRPC.setEnabled(menuItem.checked);
        if (menuItem.checked) {
          discordRPC.updateState(currentState);
        }
        updateTray(true);
      }
    },
    {
      label: 'Launch on Startup',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
        updateTray(true);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createWindow() {
  log(`createWindow() called`);
  const bounds = appSettings.windowBounds || { width: 1280, height: 860 };
  const isValidBounds = isBoundsOnScreen(bounds);

  mainWindow = new BrowserWindow({
    x: isValidBounds ? bounds.x : undefined,
    y: isValidBounds ? bounds.y : undefined,
    width: (bounds && bounds.width) || 1280,
    height: (bounds && bounds.height) || 860,
    minWidth: 800,
    minHeight: 600,
    icon: appIcon,
    title: 'SoundCloud',
    backgroundColor: '#121212',
    show: true,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  if (!isValidBounds) {
    mainWindow.center();
  }

  if (appSettings.isMaximized) {
    mainWindow.maximize();
  }

  // Prevent page title changes from overriding desktop client window title
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  mainWindow.show();
  mainWindow.focus();

  // Update thumbar when window is ready
  mainWindow.once('ready-to-show', () => {
    log(`mainWindow ready-to-show fired`);
    setTimeout(refreshTaskbarState, 300);
  });

  log(`Step 4: Loading SoundCloud URL`);
  mainWindow.loadURL('https://soundcloud.com/discover', {
    userAgent: CHROME_USER_AGENT
  });
  log(`Step 5: loadURL returned`);

  // External link and OAuth popup handling
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Never pass internal/about/blob/javascript URLs to shell.openExternal
    if (!url || url === 'about:blank' || url.startsWith('about:') || url.startsWith('javascript:') || url.startsWith('blob:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          minWidth: 400,
          minHeight: 500,
          icon: appIcon,
          autoHideMenuBar: true,
          backgroundColor: '#121212',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
          }
        }
      };
    }

    const isAuthOrApp =
      url.includes('soundcloud.com') ||
      url.includes('sndcdn.com') ||
      url.includes('accounts.google.com') ||
      url.includes('google.com') ||
      url.includes('appleid.apple.com') ||
      url.includes('apple.com') ||
      url.includes('facebook.com') ||
      url.includes('fb.com');

    if (isAuthOrApp) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          minWidth: 400,
          minHeight: 500,
          icon: appIcon,
          autoHideMenuBar: true,
          backgroundColor: '#121212',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
          }
        }
      };
    }

    // Only open actual external http/https links in the system browser
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (popupWin) => {
    try {
      popupWin.setIcon(appIcon);
    } catch (e) {}

    popupWin.webContents.setUserAgent(CHROME_USER_AGENT);

    popupWin.webContents.setWindowOpenHandler(({ url }) => {
      if (!url || url.startsWith('about:') || url.startsWith('javascript:') || url.startsWith('blob:') ||
          url.includes('facebook.com') || url.includes('google.com') || url.includes('soundcloud.com') || url.includes('apple.com')) {
        return { action: 'allow' };
      }
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url || url.startsWith('about:') || url.startsWith('javascript:') || url.startsWith('blob:')) {
      return;
    }

    const isAllowed =
      url.includes('soundcloud.com') ||
      url.includes('sndcdn.com') ||
      url.includes('accounts.google.com') ||
      url.includes('google.com') ||
      url.includes('appleid.apple.com') ||
      url.includes('apple.com') ||
      url.includes('facebook.com') ||
      url.includes('fb.com');

    if (!isAllowed) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
    }
  });

  // Inject CSS to eliminate OneTrust dark filter
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.insertCSS(`
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
    `);
  });

  // Right-click context menu with Inspect Element & navigation
  mainWindow.webContents.on('context-menu', (event, params) => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Back',
        enabled: mainWindow.webContents.canGoBack(),
        click: () => mainWindow.webContents.goBack()
      },
      {
        label: 'Forward',
        enabled: mainWindow.webContents.canGoForward(),
        click: () => mainWindow.webContents.goForward()
      },
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => mainWindow.webContents.reload()
      },
      { type: 'separator' },
      {
        label: 'Inspect Element (DevTools)',
        accelerator: 'F12',
        click: () => {
          mainWindow.webContents.inspectElement(params.x, params.y);
          if (!mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.openDevTools();
          }
        }
      }
    ]);
    contextMenu.popup();
  });

  // Save window position and size on move or resize (debounced to prevent disk thrashing)
  let saveBoundsTimer = null;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
        const b = mainWindow.getBounds();
        if (isBoundsOnScreen(b)) {
          appSettings.windowBounds = b;
        }
      }
      appSettings.isMaximized = mainWindow.isMaximized();
      saveSettings(appSettings);
    }, 500);
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Minimize to tray logic
  mainWindow.on('minimize', (event) => {
    if (appSettings.minimizeToTray) {
      event.preventDefault();
      hideWindowToTray();
    }
  });

  // Close to tray logic
  mainWindow.on('close', (event) => {
    if (!isQuitting && appSettings.closeToTray) {
      event.preventDefault();
      hideWindowToTray();
    } else {
      mainWindow = null;
    }
  });

  // When window is restored from minimized or tray, refresh taskbar state
  mainWindow.on('restore', () => {
    if (isHiddenInTray) {
      isHiddenInTray = false;
      mainWindow.setSkipTaskbar(false);
      updateTray(true);
    }
    log('[Window] Restored: restoring thumbnail toolbar buttons');
    refreshTaskbarState();
    setTimeout(refreshTaskbarState, 200);
  });

  mainWindow.on('show', () => {
    log('[Window] Shown: refreshing taskbar state');
    refreshTaskbarState();
    setTimeout(refreshTaskbarState, 200);
  });

  mainWindow.on('focus', () => {
    if (!thumbarInitialized && !isHiddenInTray) {
      log('[Window] Focus: thumbnail toolbar not initialized, refreshing');
      refreshTaskbarState();
    }
  });

  // Create Application Menu
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Hide to Tray',
          accelerator: 'CmdOrCtrl+W',
          click: () => hideWindowToTray()
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Playback',
      submenu: [
        {
          label: 'Play / Pause',
          accelerator: 'Space',
          click: () => sendPlayerCommand('togglePlay')
        },
        {
          label: 'Next Track',
          accelerator: 'CmdOrCtrl+Right',
          click: () => sendPlayerCommand('next')
        },
        {
          label: 'Previous Track',
          accelerator: 'CmdOrCtrl+Left',
          click: () => sendPlayerCommand('prev')
        },
        {
          label: 'Like Track',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendPlayerCommand('like')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow.reload()
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'F12',
          click: () => mainWindow.webContents.toggleDevTools()
        },
        {
          label: 'Developer Tools (Alt)',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow.webContents.toggleDevTools()
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open SoundCloud Website',
          click: () => shell.openExternal('https://soundcloud.com')
        },
        {
          label: 'About SoundCloud Desktop',
          click: () => {
            shell.openExternal('https://github.com');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

// Create System Tray
function createTray() {
  try {
    tray = new Tray(trayIcon);
    updateTray();

    tray.on('click', () => {
      toggleWindowFromTray();
    });
  } catch (err) {
    console.warn('Tray creation warning:', err);
  }
}

// Setup Global Media Keys
function registerMediaShortcuts() {
  try {
    globalShortcut.register('MediaPlayPause', () => sendPlayerCommand('togglePlay'));
    globalShortcut.register('MediaNextTrack', () => sendPlayerCommand('next'));
    globalShortcut.register('MediaPreviousTrack', () => sendPlayerCommand('prev'));
  } catch (err) {
    console.error('Failed to register global media shortcuts:', err);
  }
}

// IPC handler for player state updates from preload
let lastLoggedTitle = '';
let lastLoggedPlaying = null;

ipcMain.on('player:state', (event, state) => {
  currentState = state;

  if (state.title !== lastLoggedTitle || state.isPlaying !== lastLoggedPlaying) {
    lastLoggedTitle = state.title;
    lastLoggedPlaying = state.isPlaying;
    log(`[player:state] isPlaying=${state.isPlaying}, title="${state.title}", artist="${state.artist}"`);
  }

  // Update window title with now playing
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (state.hasTrack && state.title) {
      mainWindow.setTitle(`${state.title} - ${state.artist || 'SoundCloud'}`);
    } else {
      mainWindow.setTitle('SoundCloud');
    }
  }

  updateThumbar();
  updateProgressBar();
  updateTray();
  discordRPC.updateState(currentState);
});

// Second instance focus
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindowFromTray();
    mainWindow.flashFrame(true);
  }
});

// App Ready Lifecycle
app.on('before-quit', () => {
  log(`[EVENT] app before-quit fired, isQuitting=${isQuitting}`);
  isQuitting = true;
  try { discordRPC.destroy(); } catch (e) {}
  if (tray) {
    try { tray.destroy(); } catch (e) {}
    tray = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.destroy(); } catch (e) {}
    mainWindow = null;
  }
});

app.whenReady().then(() => {
  log(`app.whenReady() resolved`);

  // Ensure defaultSession uses clean standard Chrome User-Agent
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);

  // Filter requests to remove any Electron / automation leaks
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    const url = details.url || '';
    if (url.includes('accounts.google.com') || url.includes('google.com/signin') || url.includes('google.com/oauth')) {
      delete details.requestHeaders['Sec-Ch-Ua'];
      delete details.requestHeaders['Sec-Ch-Ua-Mobile'];
      delete details.requestHeaders['Sec-Ch-Ua-Platform'];
    }
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  createWindow();
  log(`createWindow() completed`);
  createTray();
  log(`createTray() completed`);
  registerMediaShortcuts();
  log(`registerMediaShortcuts() completed`);

  if (appSettings.discordRPC !== false) {
    try {
      discordRPC.connectRPC();
      log(`discordRPC.connectRPC() called`);
    } catch (e) {
      log(`discordRPC error: ${e.message}`);
    }
  }

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    log(`[EVENT] render-process-gone: ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    log(`[EVENT] did-fail-load: ${code} ${desc} ${url}`);
  });
  mainWindow.on('close', (e) => {
    log(`[EVENT] mainWindow close event, isQuitting=${isQuitting}, closeToTray=${appSettings.closeToTray}`);
  });
  mainWindow.on('closed', () => {
    log(`[EVENT] mainWindow closed event`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      showWindowFromTray();
    }
  });
});

app.on('will-quit', () => {
  log(`[EVENT] app will-quit fired`);
  try { discordRPC.destroy(); } catch (e) {}
  globalShortcut.unregisterAll();
});

app.on('quit', (e, code) => {
  log(`[EVENT] app quit event fired, code=${code}`);
});

app.on('window-all-closed', () => {
  log(`[EVENT] app window-all-closed fired, isQuitting=${isQuitting}, closeToTray=${appSettings.closeToTray}`);
  if (isQuitting || !appSettings.closeToTray) {
    if (tray) {
      try { tray.destroy(); } catch (e) {}
      tray = null;
    }
    app.quit();
  }
});
