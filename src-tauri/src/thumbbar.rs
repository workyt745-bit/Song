//! Windows taskbar buttons: hover over Pulse in the taskbar and you get
//! "Start song again", Previous, Play / Pause, Next and Stop buttons.
//! The buttons are drawn here (no image files). Clicks are sent to the page as a "thumb-action" event.

#![cfg(windows)]

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use windows::core::{BOOL, IUnknown};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_ENABLED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
    THUMBBUTTONMASK,
};
use windows::Win32::UI::WindowsAndMessaging::{CreateIcon, RegisterWindowMessageW, HICON, WM_COMMAND};
use windows::core::w;

const ID_PREV: u32 = 1;
const ID_PLAY: u32 = 2;
const ID_NEXT: u32 = 3;
const ID_RESTART: u32 = 4;
const ID_STOP: u32 = 5;
/// HIWORD(wParam) of WM_COMMAND when a thumbnail button is clicked.
const THBN_CLICKED_CODE: usize = 0x1800;

static APP: OnceLock<AppHandle> = OnceLock::new();
static CREATED_MSG: AtomicU32 = AtomicU32::new(0);

struct Bar {
    list: ITaskbarList3,
    hwnd: HWND,
    play: HICON,
    pause: HICON,
}

thread_local! {
    static BAR: RefCell<Option<Bar>> = const { RefCell::new(None) };
    static PLAYING: RefCell<bool> = const { RefCell::new(false) };
}

/* ---------- Drawing the little icons ---------- */

const N: usize = 32;

#[derive(Clone, Copy)]
enum Glyph {
    Prev,
    Next,
    Play,
    Pause,
    Stop,
    Restart,
}

/// 1.0 when the point is inside the glyph.
fn inside(g: Glyph, x: f32, y: f32) -> bool {
    let (cx, cy) = (x - 16.0, y - 16.0);
    let tri = |x0: f32, x1: f32, h: f32, px: f32, py: f32| {
        // Right-pointing triangle from x0 (tall side) to x1 (tip).
        if px < x0 || px > x1 {
            return false;
        }
        let t = (px - x0) / (x1 - x0);
        py.abs() <= h * (1.0 - t)
    };
    match g {
        Glyph::Play => tri(-7.0, 9.0, 10.5, cx, cy),
        Glyph::Stop => cx.abs() <= 8.0 && cy.abs() <= 8.0,
        Glyph::Pause => (cy.abs() <= 9.5) && ((-8.0..=-2.5).contains(&cx) || (2.5..=8.0).contains(&cx)),
        Glyph::Next => tri(-9.0, 5.0, 9.0, cx, cy) || ((6.0..=9.0).contains(&cx) && cy.abs() <= 9.0),
        Glyph::Prev => tri(-9.0, 5.0, 9.0, -cx, cy) || ((-9.0..=-6.0).contains(&cx) && cy.abs() <= 9.0),
        Glyph::Restart => {
            let r = (cx * cx + cy * cy).sqrt();
            let ang = cy.atan2(cx).to_degrees(); // 0 = right, 90 = down
            // A ring with a gap at the top right, and an arrow head at the end of the gap.
            let ring = (8.0..=12.0).contains(&r) && !(-75.0..=-20.0).contains(&ang);
            // Arrow head: a small triangle pointing along the ring at the gap's edge (-20 degrees).
            let (hx, hy) = (cx - 10.0 * (-20.0f32).to_radians().cos(), cy - 10.0 * (-20.0f32).to_radians().sin());
            let head = (hx * hx + hy * hy).sqrt() <= 5.5 && hy < 1.5 && hx > -4.5;
            // Play-triangle in the middle so it reads as "start again".
            let mid = tri(-3.5, 5.0, 5.5, cx, cy);
            ring || head || mid
        }
    }
}

fn make_icon(g: Glyph) -> Option<HICON> {
    // Supersample 4x4 for smooth edges; a dark halo keeps the white shape visible on light and dark taskbars.
    let mut cover = vec![0f32; N * N];
    for y in 0..N {
        for x in 0..N {
            let mut c = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    if inside(g, x as f32 + (sx as f32 + 0.5) / 4.0, y as f32 + (sy as f32 + 0.5) / 4.0) {
                        c += 1;
                    }
                }
            }
            cover[y * N + x] = c as f32 / 16.0;
        }
    }
    let mut bgra = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            let mut halo = 0f32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (xx, yy) = (x as i32 + dx, y as i32 + dy);
                    if xx >= 0 && yy >= 0 && (xx as usize) < N && (yy as usize) < N {
                        halo = halo.max(cover[yy as usize * N + xx as usize]);
                    }
                }
            }
            let f = cover[y * N + x];
            let a_halo = halo * 0.55;
            // white glyph over a dark halo
            let a = f + a_halo * (1.0 - f);
            let v = if a > 0.0 { (255.0 * f / a).round() as u8 } else { 0 };
            let i = (y * N + x) * 4;
            let pm = |c: u8| ((c as f32) * a).round() as u8; // premultiplied
            bgra[i] = pm(v);
            bgra[i + 1] = pm(v);
            bgra[i + 2] = pm(v);
            bgra[i + 3] = (a * 255.0).round() as u8;
        }
    }
    let and_mask = vec![0u8; N * N / 8];
    unsafe { CreateIcon(None, N as i32, N as i32, 1, 32, and_mask.as_ptr(), bgra.as_ptr()).ok() }
}

/* ---------- Buttons ---------- */

fn tip(s: &str) -> [u16; 260] {
    let mut t = [0u16; 260];
    for (i, c) in s.encode_utf16().take(259).enumerate() {
        t[i] = c;
    }
    t
}

fn button(id: u32, icon: HICON, tooltip: &str) -> THUMBBUTTON {
    THUMBBUTTON {
        dwMask: THUMBBUTTONMASK(THB_ICON.0 | THB_TOOLTIP.0 | THB_FLAGS.0),
        iId: id,
        iBitmap: 0,
        hIcon: icon,
        szTip: tip(tooltip),
        dwFlags: THBF_ENABLED,
    }
}

fn add_buttons(hwnd: HWND) {
    BAR.with(|b| {
        if b.borrow().is_some() {
            return;
        }
        let (Some(prev), Some(next), Some(play), Some(pause), Some(restart), Some(stop)) = (
            make_icon(Glyph::Prev),
            make_icon(Glyph::Next),
            make_icon(Glyph::Play),
            make_icon(Glyph::Pause),
            make_icon(Glyph::Restart),
            make_icon(Glyph::Stop),
        ) else {
            return;
        };
        unsafe {
            let Ok(list) = CoCreateInstance::<Option<&IUnknown>, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) else { return };
            if list.HrInit().is_err() {
                return;
            }
            let playing = PLAYING.with(|p| *p.borrow());
            let buttons = [
                button(ID_RESTART, restart, "Start song again"),
                button(ID_PREV, prev, "Previous"),
                button(ID_PLAY, if playing { pause } else { play }, if playing { "Pause" } else { "Play" }),
                button(ID_NEXT, next, "Next"),
                button(ID_STOP, stop, "Stop"),
            ];
            if list.ThumbBarAddButtons(hwnd, &buttons).is_ok() {
                *b.borrow_mut() = Some(Bar { list, hwnd, play, pause });
            }
        }
    });
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    if msg != 0 && msg == CREATED_MSG.load(Ordering::Relaxed) {
        add_buttons(hwnd);
    } else if msg == WM_COMMAND && (wparam.0 >> 16) & 0xffff == THBN_CLICKED_CODE {
        let action = match (wparam.0 & 0xffff) as u32 {
            ID_PREV => Some("prev"),
            ID_PLAY => Some("toggle"),
            ID_NEXT => Some("next"),
            ID_RESTART => Some("restart"),
            ID_STOP => Some("stop"),
            _ => None,
        };
        if let (Some(a), Some(app)) = (action, APP.get()) {
            let _ = app.emit("thumb-action", a);
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Call once, on the main thread, after the window exists.
pub fn install(app: &AppHandle, hwnd_raw: isize) {
    let _ = APP.set(app.clone());
    let hwnd = HWND(hwnd_raw as *mut c_void);
    unsafe {
        CREATED_MSG.store(RegisterWindowMessageW(w!("TaskbarButtonCreated")), Ordering::Relaxed);
        let ok: BOOL = SetWindowSubclass(hwnd, Some(proc), 0x50554C53, 0);
        let _ = ok;
    }
    // If the taskbar button already exists we won't get the message again, so try now too.
    add_buttons(hwnd);
}

/// Swaps the middle button between Play and Pause. Call on the main thread.
pub fn set_playing(playing: bool) {
    PLAYING.with(|p| *p.borrow_mut() = playing);
    BAR.with(|b| {
        if let Some(bar) = b.borrow().as_ref() {
            let btn = button(ID_PLAY, if playing { bar.pause } else { bar.play }, if playing { "Pause" } else { "Play" });
            unsafe {
                let _ = bar.list.ThumbBarUpdateButtons(bar.hwnd, &[btn]);
            }
        }
    });
}
