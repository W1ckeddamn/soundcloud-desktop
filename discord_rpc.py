import time
import threading
from pypresence import Presence, ActivityType

CLIENT_ID = "802958833214423081"

class DiscordRPCManager:
    def __init__(self, client_id=CLIENT_ID):
        self.client_id = client_id
        self.rpc = None
        self.connected = False
        self.enabled = True
        self.last_track_key = ""
        self.last_playing_state = None
        self.last_update_time = 0
        self.lock = threading.Lock()

    def connect(self):
        if not self.enabled or self.connected:
            return
        try:
            self.rpc = Presence(self.client_id)
            self.rpc.connect()
            self.connected = True
            print("[Discord RPC] Connected successfully")
        except Exception as e:
            self.connected = False
            self.rpc = None

    def update_state(self, state):
        if not self.enabled:
            return

        with self.lock:
            if not self.connected:
                self.connect()
            if not self.connected or not self.rpc:
                return

            if not state or not state.get("hasTrack") or not state.get("title"):
                if self.last_track_key:
                    self.clear()
                return

            title = (state.get("title") or "SoundCloud")[:128]
            artist = (state.get("artist") or "SoundCloud")[:128]
            is_playing = bool(state.get("isPlaying", False))
            track_url = state.get("trackUrl", "")
            artwork = state.get("artwork", "")
            duration_sec = state.get("durationSeconds", 0)
            current_sec = state.get("currentSeconds", 0)

            track_key = f"{title}__{artist}"
            now = time.time()
            track_changed = (track_key != self.last_track_key)
            play_changed = (is_playing != self.last_playing_state)
            time_since_last = now - self.last_update_time

            # Rate limit: only update if track/state changed or > 20s
            if not track_changed and not play_changed and time_since_last < 20:
                return

            self.last_track_key = track_key
            self.last_playing_state = is_playing
            self.last_update_time = now

            large_img = artwork if (artwork and artwork.startswith("http")) else "soundcloud"
            small_img = "play" if is_playing else "pause"
            small_text = "Playing" if is_playing else "Paused"

            payload = {
                "activity_type": ActivityType.LISTENING,
                "details": title,
                "state": artist,
                "large_image": large_img,
                "large_text": title,
                "small_image": small_img,
                "small_text": small_text,
                "instance": False
            }

            if track_url and track_url.startswith("http"):
                payload["buttons"] = [
                    {"label": "Listen on SoundCloud", "url": track_url}
                ]

            try:
                current_track_time_in_sec = float(current_sec) if current_sec is not None else 0.0
            except (ValueError, TypeError):
                current_track_time_in_sec = 0.0

            try:
                total_track_duration_in_sec = float(duration_sec) if duration_sec is not None else 0.0
            except (ValueError, TypeError):
                total_track_duration_in_sec = 0.0

            has_valid_duration = (total_track_duration_in_sec > 0)

            if is_playing:
                if has_valid_duration:
                    start_ts = int(now - current_track_time_in_sec)
                    end_ts = int(start_ts + total_track_duration_in_sec)
                    payload["start"] = start_ts
                    payload["end"] = end_ts
                    print(f"[Discord RPC] Listening timestamps (sec): current={current_track_time_in_sec}, duration={total_track_duration_in_sec}, start={start_ts}, end={end_ts}")
                else:
                    payload["start"] = int(now)
            else:
                # When paused, no start/end timestamps so Discord does not keep counting
                payload["start"] = None
                payload["end"] = None

            try:
                self.rpc.update(**payload)
            except Exception as e:
                # Disconnected
                self.connected = False
                self.rpc = None

    def clear(self):
        with self.lock:
            self.last_track_key = ""
            self.last_playing_state = None
            if self.connected and self.rpc:
                try:
                    self.rpc.clear()
                except Exception:
                    self.connected = False
                    self.rpc = None

    def set_enabled(self, enabled):
        self.enabled = bool(enabled)
        if not self.enabled:
            self.clear()
            self.close()
        else:
            self.connect()

    def close(self):
        with self.lock:
            if self.rpc:
                try:
                    self.rpc.close()
                except Exception:
                    pass
                self.rpc = None
            self.connected = False
