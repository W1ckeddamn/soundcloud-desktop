const { ipcRenderer } = require('electron');

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

// Store MediaSession action handlers if registered by SoundCloud
const mediaSessionHandlers = {};

// Hook navigator.mediaSession
if (typeof navigator !== 'undefined' && navigator.mediaSession) {
  const origSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (action, handler) => {
    mediaSessionHandlers[action] = handler;
    return origSetActionHandler(action, handler);
  };
}

// Function to extract current state
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

  // Extract metadata
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

  // Upgrade SoundCloud thumbnail to high-res (500x500)
  if (artwork && artwork.includes('-t50x50.')) {
    artwork = artwork.replace('-t50x50.', '-t500x500.');
  }

  // Extract track URL
  let trackUrl = '';
  const titleLink = badge ? badge.querySelector('a.playbackSoundBadge__titleLink, a.playbackSoundBadge__title') : null;
  if (titleLink && titleLink.href) {
    trackUrl = titleLink.href;
  }

  // Calculate progress
  let progress = 0;
  if (progressWrapper && progressWrapper.hasAttribute('aria-valuenow')) {
    const now = parseFloat(progressWrapper.getAttribute('aria-valuenow') || '0');
    const max = parseFloat(progressWrapper.getAttribute('aria-valuemax') || '1');
    if (max > 0) progress = Math.min(1, Math.max(0, now / max));
  }

  const timePassed = timePassedEl ? timePassedEl.innerText.trim() : '';
  const duration = durationEl ? durationEl.innerText.trim() : '';

  // Parse time format ("01:23", "01:23:45", "-00:45") into seconds
  function parseSeconds(str) {
    if (!str || typeof str !== 'string') return 0;
    const clean = str.replace(/^-/, '').trim();
    const parts = clean.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

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

// Check and emit state update
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
      ipcRenderer.send('player:state', state);
    }
  } catch (err) {
    console.error('[Preload] Error checking state:', err);
  }
}

// Handle playback commands from main process
ipcRenderer.on('player:command', (event, cmd, arg) => {
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
          // Space key fallback
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
          // Shift + ArrowRight fallback
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
          // Shift + ArrowLeft fallback
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', keyCode: 37, which: 37, shiftKey: true, bubbles: true }));
        }
        break;
      }
      case 'like': {
        const likeBtn = document.querySelector('.playbackSoundBadge__like');
        if (likeBtn) likeBtn.click();
        break;
      }
      case 'seek': {
        if (typeof arg === 'number' && mediaSessionHandlers.seekto) {
          mediaSessionHandlers.seekto({ seekTime: arg });
        }
        break;
      }
    }
  } catch (err) {
    console.error('[Preload] Error executing command:', cmd, err);
  }
  setTimeout(checkState, 100);
});

// Safely dismiss cookie banner and remove dark filter
function removeOneTrust() {
  try {
    const cookieBtn = document.querySelector('#onetrust-accept-btn-handler');
    if (cookieBtn) {
      cookieBtn.click();
    }
    const filter = document.querySelector('.onetrust-pc-dark-filter');
    if (filter) {
      filter.remove();
    }
    if (document.body && document.body.classList.contains('ot-overlay-open')) {
      document.body.classList.remove('ot-overlay-open');
    }
  } catch (e) {}
}

// Auto-accept cookie banner and clean up clutter on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  removeOneTrust();

  // Setup MutationObserver on document body
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

  // Inject sleek dark styling for native desktop feel and hiding dark filter
  const style = document.createElement('style');
  style.id = 'soundcloud-desktop-style';
  style.textContent = `
    /* Custom sleek dark scrollbar */
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
    /* Hide OneTrust dark filter backdrop only */
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
});

// Periodic check interval
setInterval(checkState, 250);
