import os
import ctypes
from ctypes import wintypes, c_void_p, c_ulonglong, c_uint, byref, POINTER, WINFUNCTYPE, c_long

# Win32 Constants
WM_COMMAND = 0x0111
WM_HOTKEY = 0x0312
IMAGE_ICON = 1
LR_LOADFROMFILE = 0x00000010

VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_PLAY_PAUSE = 0xB3

THB_ICON = 0x00000002
THB_TOOLTIP = 0x00000004
THB_FLAGS = 0x00000008

THBF_ENABLED = 0x00000000
THBF_DISABLED = 0x00000001

TBPF_NOPROGRESS = 0
TBPF_NORMAL = 2
TBPF_PAUSED = 8

class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', wintypes.DWORD),
        ('Data2', wintypes.WORD),
        ('Data3', wintypes.WORD),
        ('Data4', wintypes.BYTE * 8)
    ]

class THUMBBUTTON(ctypes.Structure):
    _fields_ = [
        ('dwMask', wintypes.DWORD),
        ('iId', wintypes.UINT),
        ('iBitmap', wintypes.UINT),
        ('hIcon', wintypes.HICON),
        ('szTip', wintypes.WCHAR * 260),
        ('dwFlags', wintypes.DWORD)
    ]

CLSID_TaskbarList = GUID(0x56FDF344, 0xFD6D, 0x11D0, (wintypes.BYTE * 8)(0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90))
IID_ITaskbarList3 = GUID(0xEA1AFB91, 0x9E28, 0x4B86, (wintypes.BYTE * 8)(0x90, 0xE9, 0x9E, 0x9F, 0x8A, 0x5E, 0xEF, 0xAF))

SUBCLASSPROC = WINFUNCTYPE(c_void_p, wintypes.HWND, c_uint, wintypes.WPARAM, wintypes.LPARAM, c_void_p, c_void_p)

class TaskbarManager:
    def __init__(self, hwnd, on_command_callback, assets_dir=None):
        self.hwnd = hwnd
        self.on_command = on_command_callback
        self.assets_dir = assets_dir or os.path.join(os.path.dirname(__file__), "assets")
        self.thumbar_dir = os.path.join(self.assets_dir, "thumbar")
        self.taskbar = None
        self.buttons_added = False
        self.icons = {}
        self.subclass_proc = None

        self._init_taskbar()
        self._load_icons()
        self._setup_subclass()

    def _init_taskbar(self):
        try:
            ole32 = ctypes.windll.ole32
            ole32.CoInitialize(None)

            self.taskbar = c_void_p()
            hr = ole32.CoCreateInstance(
                byref(CLSID_TaskbarList), None, 1,
                byref(IID_ITaskbarList3), byref(self.taskbar)
            )
            if hr != 0 or not self.taskbar.value:
                self.taskbar = None
                return

            vtable = ctypes.cast(self.taskbar, POINTER(POINTER(c_void_p))).contents
            # Index 3: HrInit
            WINFUNCTYPE(c_long, c_void_p)(vtable[3])(self.taskbar)

            # Resolve function pointers
            self._fn_set_progress_value = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_ulonglong, c_ulonglong)(vtable[9])
            self._fn_set_progress_state = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_uint)(vtable[10])
            self._fn_thumb_bar_add = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_uint, c_void_p)(vtable[15])
            self._fn_thumb_bar_update = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_uint, c_void_p)(vtable[16])
        except Exception as e:
            print("[Taskbar] Init error:", e)
            self.taskbar = None

    def _load_icon_file(self, filename):
        path = os.path.join(self.thumbar_dir, filename)
        if not os.path.exists(path):
            return 0
        hicon = ctypes.windll.user32.LoadImageW(
            None, path, IMAGE_ICON, 16, 16, LR_LOADFROMFILE
        )
        return hicon or 0

    def _load_icons(self):
        self.icons = {
            "play": self._load_icon_file("play.ico"),
            "pause": self._load_icon_file("pause.ico"),
            "prev": self._load_icon_file("prev.ico"),
            "next": self._load_icon_file("next.ico"),
            "play_disabled": self._load_icon_file("play-disabled.ico"),
            "pause_disabled": self._load_icon_file("pause-disabled.ico"),
            "prev_disabled": self._load_icon_file("prev-disabled.ico"),
            "next_disabled": self._load_icon_file("next-disabled.ico"),
        }

    def _setup_subclass(self):
        # Register global media keys on hwnd
        try:
            ctypes.windll.user32.RegisterHotKey(self.hwnd, 201, 0, VK_MEDIA_PREV_TRACK)
            ctypes.windll.user32.RegisterHotKey(self.hwnd, 202, 0, VK_MEDIA_PLAY_PAUSE)
            ctypes.windll.user32.RegisterHotKey(self.hwnd, 203, 0, VK_MEDIA_NEXT_TRACK)
        except Exception:
            pass

        def _wnd_proc(hwnd, uMsg, wParam, lParam, uIdSubclass, dwRefData):
            if uMsg == WM_COMMAND:
                cmd_id = wParam & 0xFFFF
                if cmd_id in (101, 102, 103) and self.on_command:
                    try:
                        self.on_command(cmd_id)
                    except Exception as e:
                        print("[Taskbar] Command error:", e)
                    return 0
            elif uMsg == WM_HOTKEY:
                hotkey_id = wParam
                cmd_map = {201: 101, 202: 102, 203: 103}
                if hotkey_id in cmd_map and self.on_command:
                    try:
                        self.on_command(cmd_map[hotkey_id])
                    except Exception as e:
                        print("[Taskbar] Hotkey command error:", e)
                    return 0
            return ctypes.windll.comctl32.DefSubclassProc(hwnd, uMsg, wParam, lParam)

        self.subclass_proc = SUBCLASSPROC(_wnd_proc)
        ctypes.windll.comctl32.SetWindowSubclass(self.hwnd, self.subclass_proc, 1001, 0)

    def destroy(self):
        try:
            ctypes.windll.user32.UnregisterHotKey(self.hwnd, 201)
            ctypes.windll.user32.UnregisterHotKey(self.hwnd, 202)
            ctypes.windll.user32.UnregisterHotKey(self.hwnd, 203)
            if self.subclass_proc:
                ctypes.windll.comctl32.RemoveWindowSubclass(self.hwnd, self.subclass_proc, 1001)
        except Exception:
            pass

    def set_progress(self, progress_float, is_playing=True):
        if not self.taskbar:
            return
        try:
            if progress_float is None or progress_float <= 0:
                self._fn_set_progress_state(self.taskbar, self.hwnd, TBPF_NOPROGRESS)
            else:
                state = TBPF_NORMAL if is_playing else TBPF_PAUSED
                self._fn_set_progress_state(self.taskbar, self.hwnd, state)
                val = int(progress_float * 1000)
                self._fn_set_progress_value(self.taskbar, self.hwnd, val, 1000)
        except Exception:
            pass

    def update_thumbar(self, has_track, is_playing, can_prev=True, can_next=True):
        if not self.taskbar:
            return

        btn_array = (THUMBBUTTON * 3)()

        # Button 101: Previous
        btn_prev = btn_array[0]
        btn_prev.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
        btn_prev.iId = 101
        btn_prev.szTip = "Previous Track"
        if has_track and can_prev:
            btn_prev.hIcon = self.icons.get("prev", 0)
            btn_prev.dwFlags = THBF_ENABLED
        else:
            btn_prev.hIcon = self.icons.get("prev_disabled", 0) or self.icons.get("prev", 0)
            btn_prev.dwFlags = THBF_DISABLED

        # Button 102: Play / Pause
        btn_play = btn_array[1]
        btn_play.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
        btn_play.iId = 102
        if is_playing:
            btn_play.szTip = "Pause"
            btn_play.hIcon = self.icons.get("pause", 0)
            btn_play.dwFlags = THBF_ENABLED if has_track else THBF_DISABLED
        else:
            btn_play.szTip = "Play"
            btn_play.hIcon = self.icons.get("play", 0)
            btn_play.dwFlags = THBF_ENABLED if has_track else THBF_DISABLED

        # Button 103: Next
        btn_next = btn_array[2]
        btn_next.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
        btn_next.iId = 103
        btn_next.szTip = "Next Track"
        if has_track and can_next:
            btn_next.hIcon = self.icons.get("next", 0)
            btn_next.dwFlags = THBF_ENABLED
        else:
            btn_next.hIcon = self.icons.get("next_disabled", 0) or self.icons.get("next", 0)
            btn_next.dwFlags = THBF_DISABLED

        try:
            if not self.buttons_added:
                hr = self._fn_thumb_bar_add(self.taskbar, self.hwnd, 3, byref(btn_array))
                if hr == 0:
                    self.buttons_added = True
            else:
                self._fn_thumb_bar_update(self.taskbar, self.hwnd, 3, byref(btn_array))
        except Exception as e:
            print("[Taskbar] Update error:", e)
