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
THBF_NOBACKGROUND = 0x00000004

TBPF_NOPROGRESS = 0
TBPF_NORMAL = 2
TBPF_PAUSED = 8

# Register the TaskbarButtonCreated message — must call ThumbBarAddButtons ONLY after this
_WM_TASKBARBUTTONCREATED = ctypes.windll.user32.RegisterWindowMessageW("TaskbarButtonCreated")
# Allow TaskbarButtonCreated to be received by non-elevated windows
try:
    MSGFLT_ALLOW = 1
    ctypes.windll.user32.ChangeWindowMessageFilterEx(
        None, _WM_TASKBARBUTTONCREATED, MSGFLT_ALLOW, None
    )
except Exception:
    pass


class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', wintypes.DWORD),
        ('Data2', wintypes.WORD),
        ('Data3', wintypes.WORD),
        ('Data4', wintypes.BYTE * 8)
    ]


class THUMBBUTTON(ctypes.Structure):
    _pack_ = 8  # pshpack8.h — matches Windows SDK layout
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
        # Pending state to apply once TaskbarButtonCreated fires
        self._pending_state = None
        # Cached last args for deferred add
        self._last_update_args = (False, False, True, True)

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
                print(f"[Taskbar] CoCreateInstance failed hr=0x{hr & 0xFFFFFFFF:08X}")
                self.taskbar = None
                return

            vtable = ctypes.cast(self.taskbar, POINTER(POINTER(c_void_p))).contents
            # Index 3: HrInit
            hr_init = WINFUNCTYPE(c_long, c_void_p)(vtable[3])(self.taskbar)
            print(f"[Taskbar] HrInit hr=0x{hr_init & 0xFFFFFFFF:08X}")

            # Resolve function pointers by vtable index
            # ITaskbarList:  3=HrInit, 4=AddTab, 5=DeleteTab, 6=ActivateTab, 7=SetActiveAlt
            # ITaskbarList2: 8=MarkFullscreenWindow
            # ITaskbarList3: 9=SetProgressValue, 10=SetProgressState, 11=RegisterTab,
            #                12=UnregisterTab, 13=SetTabOrder, 14=SetTabActive,
            #                15=ThumbBarAddButtons, 16=ThumbBarUpdateButtons, ...
            self._fn_set_progress_value = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_ulonglong, c_ulonglong)(vtable[9])
            self._fn_set_progress_state = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_uint)(vtable[10])
            self._fn_thumb_bar_add = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_uint, c_void_p)(vtable[15])
            self._fn_thumb_bar_update = WINFUNCTYPE(c_long, c_void_p, wintypes.HWND, c_uint, c_void_p)(vtable[16])
            print("[Taskbar] COM initialized successfully")
        except Exception as e:
            print("[Taskbar] Init error:", e)
            self.taskbar = None

    def _load_icon_file(self, filename):
        path = os.path.join(self.thumbar_dir, filename)
        if not os.path.exists(path):
            print(f"[Taskbar] Icon not found: {path}")
            return 0
        hicon = ctypes.windll.user32.LoadImageW(
            None, path, IMAGE_ICON, 20, 20, LR_LOADFROMFILE
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
        print(f"[Taskbar] Icons loaded: { {k: bool(v) for k, v in self.icons.items()} }")

    def _setup_subclass(self):
        # Allow TaskbarButtonCreated for this specific HWND
        try:
            MSGFLT_ALLOW = 1
            ctypes.windll.user32.ChangeWindowMessageFilterEx(
                self.hwnd, _WM_TASKBARBUTTONCREATED, MSGFLT_ALLOW, None
            )
        except Exception:
            pass

        # Register global media keys on hwnd
        try:
            ctypes.windll.user32.RegisterHotKey(self.hwnd, 201, 0, VK_MEDIA_PREV_TRACK)
            ctypes.windll.user32.RegisterHotKey(self.hwnd, 202, 0, VK_MEDIA_PLAY_PAUSE)
            ctypes.windll.user32.RegisterHotKey(self.hwnd, 203, 0, VK_MEDIA_NEXT_TRACK)
        except Exception:
            pass

        wm_tbc = _WM_TASKBARBUTTONCREATED

        def _wnd_proc(hwnd, uMsg, wParam, lParam, uIdSubclass, dwRefData):
            if uMsg == wm_tbc:
                # TaskbarButtonCreated — now safe to add thumb buttons
                print("[Taskbar] TaskbarButtonCreated received, adding buttons...")
                self.buttons_added = False  # Reset so next update does Add, not Update
                has_track, is_playing, can_prev, can_next = self._last_update_args
                self._do_add_buttons(has_track, is_playing, can_prev, can_next)
                return 0
            elif uMsg == WM_COMMAND:
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
        print("[Taskbar] Window subclassed, waiting for TaskbarButtonCreated...")

    def _build_button_array(self, has_track, is_playing, can_prev, can_next):
        btn_array = (THUMBBUTTON * 3)()

        # Button 101: Previous
        btn_array[0].dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
        btn_array[0].iId = 101
        btn_array[0].szTip = "Previous Track"
        if has_track and can_prev:
            btn_array[0].hIcon = self.icons.get("prev") or 0
            btn_array[0].dwFlags = THBF_ENABLED | THBF_NOBACKGROUND
        else:
            btn_array[0].hIcon = self.icons.get("prev_disabled") or self.icons.get("prev") or 0
            btn_array[0].dwFlags = THBF_DISABLED | THBF_NOBACKGROUND

        # Button 102: Play / Pause
        btn_array[1].dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
        btn_array[1].iId = 102
        if is_playing:
            btn_array[1].szTip = "Pause"
            btn_array[1].hIcon = self.icons.get("pause") or 0
        else:
            btn_array[1].szTip = "Play"
            btn_array[1].hIcon = self.icons.get("play") or 0
        btn_array[1].dwFlags = (THBF_ENABLED if has_track else THBF_DISABLED) | THBF_NOBACKGROUND

        # Button 103: Next
        btn_array[2].dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS
        btn_array[2].iId = 103
        btn_array[2].szTip = "Next Track"
        if has_track and can_next:
            btn_array[2].hIcon = self.icons.get("next") or 0
            btn_array[2].dwFlags = THBF_ENABLED | THBF_NOBACKGROUND
        else:
            btn_array[2].hIcon = self.icons.get("next_disabled") or self.icons.get("next") or 0
            btn_array[2].dwFlags = THBF_DISABLED | THBF_NOBACKGROUND

        return btn_array

    def _do_add_buttons(self, has_track, is_playing, can_prev, can_next):
        if not self.taskbar:
            return
        try:
            btn_array = self._build_button_array(has_track, is_playing, can_prev, can_next)
            ptr = ctypes.cast(btn_array, c_void_p)
            hr = self._fn_thumb_bar_add(self.taskbar, self.hwnd, 3, ptr)
            print(f"[Taskbar] ThumbBarAddButtons hr=0x{hr & 0xFFFFFFFF:08X}")
            if hr == 0:
                self.buttons_added = True
        except Exception as e:
            print("[Taskbar] ThumbBarAddButtons error:", e)

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
        # Save latest state for deferred add after TaskbarButtonCreated
        self._last_update_args = (has_track, is_playing, can_prev, can_next)

        if not self.taskbar:
            return

        if not self.buttons_added:
            # Don't call Add yet — wait for TaskbarButtonCreated in WndProc
            # (unless we already received it earlier and it was reset)
            return

        try:
            btn_array = self._build_button_array(has_track, is_playing, can_prev, can_next)
            ptr = ctypes.cast(btn_array, c_void_p)
            hr = self._fn_thumb_bar_update(self.taskbar, self.hwnd, 3, ptr)
            if hr != 0:
                print(f"[Taskbar] ThumbBarUpdateButtons hr=0x{hr & 0xFFFFFFFF:08X}")
        except Exception as e:
            print("[Taskbar] Update error:", e)
