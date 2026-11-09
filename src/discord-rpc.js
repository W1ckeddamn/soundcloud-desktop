const DiscordRPC = require('discord-rpc');
const path = require('path');
const fs = require('fs');

const logFile = path.join(__dirname, '..', 'launch.log');
function log(msg) {
  try {
    fs.appendFile(logFile, `[${new Date().toISOString()}] [Discord RPC] ${msg}\n`, () => {});
  } catch (e) {}
  if (process.env.DEBUG_SOUNDCLOUD) {
    console.log('[Discord RPC]', msg);
  }
}

// Official PreMiD / Community SoundCloud Discord Application
const CLIENT_ID = '802958833214423081';

let rpcClient = null;
let isConnected = false;
let isConnecting = false;
let rpcEnabled = true;
let reconnectTimer = null;
let idleClearTimer = null;
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
      log(`Connected to Discord as ${rpcClient.user ? rpcClient.user.username : 'User'}`);
      if (lastActivity) {
        setActivity(lastActivity);
      }
    });

    rpcClient.on('error', () => {
      // Discord IPC errors are expected if Discord is closed/restarting
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
      type: 2, // 2 = Listening to
      details: activity.details,
      state: activity.state,
      instance: false
    };

    if (activity.timestamps) {
      rawActivity.timestamps = activity.timestamps;
    } else if (activity.startTimestamp || activity.endTimestamp) {
      rawActivity.timestamps = {
        start: activity.startTimestamp,
        end: activity.endTimestamp
      };
    }

    if (activity.assets) {
      rawActivity.assets = activity.assets;
    }

    if (activity.buttons && activity.buttons.length > 0) {
      rawActivity.buttons = activity.buttons;
    }

    log(`SET_ACTIVITY: "${rawActivity.details}" by ${rawActivity.state || 'SoundCloud'}`);

    rpcClient.request('SET_ACTIVITY', {
      pid: process.pid,
      activity: rawActivity
    }).catch((err) => {
      log(`SET_ACTIVITY error: ${err ? err.message : err}`);
    });
  } catch (err) {
    log(`setActivity exception: ${err ? err.message : err}`);
  }
}

function clearActivity() {
  if (idleClearTimer) {
    clearTimeout(idleClearTimer);
    idleClearTimer = null;
  }
  const hadActivity = lastActivity !== null || lastTrackKey !== '';
  lastActivity = null;
  lastTrackKey = '';
  lastPlayingState = false;

  if (!hadActivity) return;
  if (!isConnected || !rpcClient) return;

  try {
    rpcClient.clearActivity().catch(() => {});
    log('Cleared Rich Presence (idle/paused)');
  } catch (err) {}
}

function updateState(state) {
  if (!rpcEnabled) return;

  // When nothing is playing (idle, paused, or no track), clear presence so Discord doesn't broadcast in idle
  if (!state || !state.hasTrack || !state.title || !state.isPlaying) {
    if (lastActivity) {
      // Grace period (1.2s) avoids flickering when skipping tracks or scrubbing
      if (!idleClearTimer) {
        idleClearTimer = setTimeout(() => {
          idleClearTimer = null;
          clearActivity();
        }, 1200);
      }
    } else {
      if (idleClearTimer) {
        clearTimeout(idleClearTimer);
        idleClearTimer = null;
      }
    }
    return;
  }

  // Playback is active: cancel any pending idle clear timer
  if (idleClearTimer) {
    clearTimeout(idleClearTimer);
    idleClearTimer = null;
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
    type: 2, // 2 = Listening to
    details: title,
    state: artist,
    assets: {
      large_image: artwork,
      large_text: title,
      small_image: 'play',
      small_text: 'Playing'
    },
    instance: false
  };

  // Add Listen on SoundCloud button if URL is valid
  if (state.trackUrl && state.trackUrl.startsWith('http')) {
    activity.buttons = [
      { label: 'Listen on SoundCloud', url: state.trackUrl }
    ];
  }

  const currentTrackTimeInSeconds = Number(state.currentSeconds);
  const totalTrackDurationInSeconds = Number(state.durationSeconds);
  const hasValidDuration = Number.isFinite(totalTrackDurationInSeconds) && totalTrackDurationInSeconds > 0;
  const validCurrentSeconds = (Number.isFinite(currentTrackTimeInSeconds) && currentTrackTimeInSeconds >= 0) ? currentTrackTimeInSeconds : 0;

  if (hasValidDuration) {
    const start = Math.round(now - (validCurrentSeconds * 1000));
    const end = Math.round(start + (totalTrackDurationInSeconds * 1000));

    activity.startTimestamp = start;
    activity.endTimestamp = end;
    activity.timestamps = {
      start,
      end
    };
  } else {
    activity.startTimestamp = now;
    activity.timestamps = {
      start: now
    };
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
  if (idleClearTimer) {
    clearTimeout(idleClearTimer);
    idleClearTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (rpcClient) {
    try {
      if (isConnected) {
        rpcClient.clearActivity().catch(() => {});
      }
      rpcClient.destroy();
    } catch (e) {}
    rpcClient = null;
  }
  isConnected = false;
  isConnecting = false;
  lastActivity = null;
  lastTrackKey = '';
  lastPlayingState = false;
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
