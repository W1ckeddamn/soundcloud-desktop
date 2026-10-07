const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const discordRPC = require('./discord-rpc');

// Set Windows AppUserModelId for taskbar grouping and thumbnail toolbar
app.setAppUserModelId('com.soundcloud.desktop');

// Command line switches for optimal audio playback and no throttling
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const logFile = 'D:\\soundcloud-desktop\\launch.log';
function log(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}
log(`=== App starting ===`);
log(`argv: ${JSON.stringify(process.argv)}`);

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`unhandledRejection: ${err.stack || err}`);
});

// Ensure single instance
const isSingleInstance = app.requestSingleInstanceLock();
log(`isSingleInstance result: ${isSingleInstance}`);
if (!isSingleInstance) {
  log(`Exiting because isSingleInstance is false`);
  app.quit();
  process.exit(0);
}

// User Agent matching standard Google Chrome on Windows 10/11
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Modern Firefox User Agent for Google OAuth to avoid "disallowed_useragent" / "insecure browser" restrictions
const FIREFOX_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

// Set global user agent fallback so all webContents and popups use standard Chrome
app.userAgentFallback = USER_AGENT;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let thumbarInitialized = false;

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
function updateThumbar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { isPlaying, hasTrack, canNext, canPrev } = currentState;
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
    }
  } catch (err) {
    console.error('Error setting thumbar buttons:', err);
  }
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
function updateTray() {
  if (!tray) return;

  const trackLabel = currentState.title
    ? `${currentState.title} - ${currentState.artist || 'SoundCloud'}`
    : 'SoundCloud Desktop';

  tray.setToolTip(trackLabel);

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
      label: mainWindow && mainWindow.isVisible() ? 'Hide to Tray' : 'Show SoundCloud',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Close to Tray',
      type: 'checkbox',
      checked: appSettings.closeToTray,
      click: (menuItem) => {
        appSettings.closeToTray = menuItem.checked;
        saveSettings(appSettings);
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
      }
    },
    {
      label: 'Launch on Startup',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
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
  const isValidBounds = bounds &&
    typeof bounds.x === 'number' && typeof bounds.y === 'number' &&
    bounds.x >= 0 && bounds.y >= 0 &&
    typeof bounds.width === 'number' && bounds.width >= 400 &&
    typeof bounds.height === 'number' && bounds.height >= 400;

  log(`Step 1: Instantiating BrowserWindow, icon empty: ${appIcon ? appIcon.isEmpty() : 'null'}`);
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
  log(`Step 2: BrowserWindow instantiated successfully`);

  if (!isValidBounds) {
    mainWindow.center();
  }

  if (appSettings.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.show();
  mainWindow.focus();
  log(`Step 3: mainWindow shown and focused`);

  // Update thumbar when window is ready
  mainWindow.once('ready-to-show', () => {
    log(`mainWindow ready-to-show fired`);
    updateThumbar();
    setTimeout(updateThumbar, 1000);
    setTimeout(updateThumbar, 3000);
  });

  log(`Step 4: Loading SoundCloud URL`);
  mainWindow.loadURL('https://soundcloud.com/discover', {
    userAgent: USER_AGENT
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
            contextIsolation: true
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
            contextIsolation: true
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

    popupWin.webContents.setUserAgent(USER_AGENT);

    popupWin.webContents.on('will-navigate', (event, url) => {
      if (url.includes('accounts.google.com') || url.includes('google.com/signin')) {
        popupWin.webContents.setUserAgent(FIREFOX_USER_AGENT);
      } else {
        popupWin.webContents.setUserAgent(USER_AGENT);
      }
    });

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

  // Save window position and size on move or resize
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const b = mainWindow.getBounds();
      if (b.x >= 0 && b.y >= 0 && b.width >= 400 && b.height >= 400) {
        appSettings.windowBounds = b;
      }
    }
    appSettings.isMaximized = mainWindow.isMaximized();
    saveSettings(appSettings);
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Close to tray logic
  mainWindow.on('close', (event) => {
    if (!isQuitting && appSettings.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      updateTray();
    } else {
      mainWindow = null;
    }
  });

  mainWindow.on('focus', () => {
    if (!thumbarInitialized) updateThumbar();
  });

  // Create Application Menu
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Hide to Tray',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow.hide()
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
      if (!mainWindow) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
      updateTray();
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
ipcMain.on('player:state', (event, state) => {
  currentState = state;

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
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(true);
  }
});

// App Ready Lifecycle
app.on('before-quit', () => {
  log(`[EVENT] app before-quit fired, isQuitting=${isQuitting}`);
  isQuitting = true;
  if (tray) {
    try { tray.destroy(); } catch (e) {}
    tray = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.destroy(); } catch (e) {}
    mainWindow = null;
  }
  setTimeout(() => {
    log(`[EVENT] forcing process.exit(0) from before-quit timeout`);
    process.exit(0);
  }, 150);
});

app.whenReady().then(() => {
  log(`app.whenReady() resolved`);

  // Strip Chromium botguard headers and set Firefox User-Agent for Google OAuth
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || '';
    if (url.includes('accounts.google.com') || url.includes('google.com/signin') || url.includes('google.com/oauth')) {
      details.requestHeaders['User-Agent'] = FIREFOX_USER_AGENT;
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
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('will-quit', () => {
  log(`[EVENT] app will-quit fired`);
  try { discordRPC.destroy(); } catch (e) {}
  globalShortcut.unregisterAll();
  process.exit(0);
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
