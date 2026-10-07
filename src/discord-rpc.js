const DiscordRPC = require('discord-rpc');

// Official PreMiD / Community SoundCloud Discord Application
const CLIENT_ID = '802958833214423081';

let rpcClient = null;
let isConnected = false;
let isConnecting = false;
let rpcEnabled = true;
let reconnectTimer = null;
let lastTrackKey = '';
let lastPlayingState = null;
let lastUpdateTime = 0;
let lastActivity = null;

function connectRPC() {
  if (!rpcEnabled || isConnected || isConnecting) return;

  isConnecting = true;
  try {
    rpcClient = new DiscordRPC.Client({ transport: 'ipc' });

    rpcClient.on('ready', () => {
      isConnected = true;
      isConnecting = false;
      console.log(`[Discord RPC] Connected to Discord as ${rpcClient.user ? rpcClient.user.username : 'User'}`);
      if (lastActivity) {
        setActivity(lastActivity);
      }
    });

    rpcClient.on('error', (err) => {
      // Discord IPC errors are expected if Discord is closed/restarting
      // Do not crash the application
    });

    rpcClient.transport.on('close', () => {
      isConnected = false;
      isConnecting = false;
      rpcClient = null;
      scheduleReconnect();
    });

    rpcClient.login({ clientId: CLIENT_ID }).catch(() => {
      isConnecting = false;
      isConnected = false;
      rpcClient = null;
      scheduleReconnect();
    });
  } catch (err) {
    isConnecting = false;
    isConnected = false;
    rpcClient = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!rpcEnabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRPC();
  }, 15000);
}

function setActivity(activity) {
  lastActivity = activity;
  if (!rpcEnabled || !isConnected || !rpcClient) return;

  try {
    const rawActivity = {
      type: 2, // 2 = Listening to (Слушает)
      details: activity.details,
      state: activity.state,
      instance: false
    };

    if (activity.timestamps) {
      rawActivity.timestamps = activity.timestamps;
    }

    if (activity.assets) {
      rawActivity.assets = activity.assets;
    }

    if (activity.buttons && activity.buttons.length > 0) {
      rawActivity.buttons = activity.buttons;
    }

    rpcClient.request('SET_ACTIVITY', {
      pid: process.pid,
      activity: rawActivity
    }).catch(() => {});
  } catch (err) {}
}

function clearActivity() {
  lastActivity = null;
  lastTrackKey = '';
  lastPlayingState = null;
  if (!isConnected || !rpcClient) return;
  try {
    rpcClient.request('SET_ACTIVITY', {
      pid: process.pid
    }).catch(() => {});
  } catch (err) {}
}

function updateState(state) {
  if (!rpcEnabled) return;

  if (!state || !state.hasTrack || !state.title) {
    if (lastTrackKey) {
      clearActivity();
    }
    return;
  }

  const trackKey = `${state.title}__${state.artist || ''}`;
  const now = Date.now();
  const trackChanged = trackKey !== lastTrackKey;
  const playStateChanged = state.isPlaying !== lastPlayingState;
  const timeSinceLastUpdate = now - lastUpdateTime;

  // Discord RPC rate limits updates (max ~1 per 2-5 seconds).
  // We only update if track changed, play/pause toggled, or > 20s have passed.
  if (!trackChanged && !playStateChanged && timeSinceLastUpdate < 20000) {
    return;
  }

  lastTrackKey = trackKey;
  lastPlayingState = state.isPlaying;
  lastUpdateTime = now;

  const title = (state.title || 'SoundCloud').slice(0, 128);
  const artist = (state.artist || 'SoundCloud').slice(0, 128);
  const artwork = (state.artwork && state.artwork.startsWith('http')) ? state.artwork : 'soundcloud';

  const activity = {
    type: 2, // 2 = Listening to (Слушает)
    details: title,
    state: artist,
    assets: {
      large_image: artwork,
      large_text: title,
      small_image: state.isPlaying ? 'play' : 'pause',
      small_text: state.isPlaying ? 'Playing' : 'Paused'
    },
    instance: false
  };

  // Add Listen on SoundCloud button if URL is valid
  if (state.trackUrl && state.trackUrl.startsWith('http')) {
    activity.buttons = [
      { label: 'Listen on SoundCloud', url: state.trackUrl }
    ];
  }

  if (state.isPlaying) {
    // Discord smoothly animates elapsed/remaining time when start and end timestamps are provided
    if (state.durationSeconds && state.durationSeconds > 0) {
      const elapsedMs = (state.currentSeconds || 0) * 1000;
      const startMs = now - elapsedMs;
      const endMs = startMs + state.durationSeconds * 1000;
      activity.timestamps = {
        start: Math.round(startMs),
        end: Math.round(endMs)
      };
    } else {
      activity.timestamps = {
        start: Math.round(now)
      };
    }
  }

  setActivity(activity);
}

function setEnabled(enabled) {
  rpcEnabled = Boolean(enabled);
  if (!rpcEnabled) {
    clearActivity();
    destroy();
  } else {
    connectRPC();
  }
}

function isRPCConnected() {
  return isConnected;
}

function isRPCEnabled() {
  return rpcEnabled;
}

function destroy() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (rpcClient) {
    try { rpcClient.destroy(); } catch (e) {}
    rpcClient = null;
  }
  isConnected = false;
  isConnecting = false;
  lastActivity = null;
}

module.exports = {
  connectRPC,
  updateState,
  clearActivity,
  setEnabled,
  isRPCConnected,
  isRPCEnabled,
  destroy
};
