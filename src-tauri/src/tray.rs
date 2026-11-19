//! System tray icon with five activity states. Icons are drawn in code (no assets), and each
//! state has its own shape as well as its own colour, so colour is never the only signal.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "main";
const SIZE: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityState {
    Idle,
    Working,
    NeedsYou,
    Finished,
    Offline,
}

impl ActivityState {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "idle" => Self::Idle,
            "working" => Self::Working,
            "needs-you" => Self::NeedsYou,
            "finished" => Self::Finished,
            "offline" => Self::Offline,
            _ => return None,
        })
    }

    pub fn tooltip(self) -> &'static str {
        match self {
            Self::Idle => "Hermate: idle",
            Self::Working => "Hermate: working",
            Self::NeedsYou => "Hermate: needs you",
            Self::Finished => "Hermate: finished",
            Self::Offline => "Hermate: offline",
        }
    }

    fn color(self) -> [u8; 3] {
        match self {
            Self::Idle => [0x8a, 0x8a, 0x99],
            Self::Working => [0x3b, 0x82, 0xf6],
            Self::NeedsYou => [0xf5, 0x9e, 0x0b],
            Self::Finished => [0x22, 0xc5, 0x5e],
            Self::Offline => [0xef, 0x44, 0x44],
        }
    }

    /// 32x32 RGBA pixels.
    pub fn icon_rgba(self) -> Vec<u8> {
        let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
        let [r, g, b] = self.color();
        let c = (SIZE as f32 - 1.0) / 2.0;
        for y in 0..SIZE {
            for x in 0..SIZE {
                let (fx, fy) = (x as f32, y as f32);
                let d = ((fx - c).powi(2) + (fy - c).powi(2)).sqrt();
                let (inside, white) = match self {
                    // small solid dot
                    Self::Idle => (d <= 9.0, false),
                    // big solid disc
                    Self::Working => (d <= 14.5, false),
                    // disc with a white "!"
                    Self::NeedsYou => (
                        d <= 14.5,
                        (fx - c).abs() <= 2.0 && ((fy >= 7.0 && fy <= 18.0) || (fy >= 22.0 && fy <= 25.0)),
                    ),
                    // disc with a white tick
                    Self::Finished => (
                        d <= 14.5,
                        near_segment(fx, fy, (9.0, 16.5), (14.0, 21.5), 2.0) || near_segment(fx, fy, (14.0, 21.5), (23.0, 10.5), 2.0),
                    ),
                    // ring only (hollow)
                    Self::Offline => (d <= 14.5 && d >= 10.5, false),
                };
                if inside {
                    let i = ((y * SIZE + x) * 4) as usize;
                    let (pr, pg, pb) = if white { (255, 255, 255) } else { (r, g, b) };
                    px[i..i + 4].copy_from_slice(&[pr, pg, pb, 255]);
                }
            }
        }
        px
    }

    pub fn icon(self) -> Image<'static> {
        Image::new_owned(self.icon_rgba(), SIZE, SIZE)
    }
}

/// True when (x, y) is within `half_width` of the segment a-b.
fn near_segment(x: f32, y: f32, a: (f32, f32), b: (f32, f32), half_width: f32) -> bool {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = (((x - a.0) * dx + (y - a.1) * dy) / len2).clamp(0.0, 1.0);
    let (px, py) = (a.0 + t * dx, a.1 + t * dy);
    ((x - px).powi(2) + (y - py).powi(2)).sqrt() <= half_width
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Create the tray icon (offline until the frontend reports a state).
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Hermate", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(ActivityState::Offline.icon())
        .tooltip(ActivityState::Offline.tooltip())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Switch the tray icon and tooltip.
pub fn set_state(app: &AppHandle, state: ActivityState) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(|| "tray icon is not available".to_string())?;
    tray.set_icon(Some(state.icon())).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(state.tooltip())).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [ActivityState; 5] =
        [ActivityState::Idle, ActivityState::Working, ActivityState::NeedsYou, ActivityState::Finished, ActivityState::Offline];

    fn px(rgba: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn parses_the_five_state_names_and_rejects_others() {
        assert_eq!(ActivityState::parse("needs-you"), Some(ActivityState::NeedsYou));
        for s in ["idle", "working", "finished", "offline"] {
            assert!(ActivityState::parse(s).is_some());
        }
        for s in ["", "Idle", "needs_you", "busy"] {
            assert_eq!(ActivityState::parse(s), None);
        }
    }

    #[test]
    fn icons_are_the_right_size_and_every_state_looks_different() {
        let icons: Vec<Vec<u8>> = ALL.iter().map(|s| s.icon_rgba()).collect();
        for i in &icons {
            assert_eq!(i.len(), (SIZE * SIZE * 4) as usize);
            assert!(i.chunks(4).any(|p| p[3] == 255), "icon is not blank");
        }
        for a in 0..icons.len() {
            for b in a + 1..icons.len() {
                assert_ne!(icons[a], icons[b], "{:?} and {:?} must differ", ALL[a], ALL[b]);
            }
        }
    }

    #[test]
    fn shapes_differ_not_just_colours() {
        let opaque = |s: ActivityState| s.icon_rgba().chunks(4).filter(|p| p[3] == 255).count();
        // Idle is a small dot, Offline a hollow ring, Working a full disc.
        assert!(opaque(ActivityState::Idle) < opaque(ActivityState::Working));
        assert!(opaque(ActivityState::Offline) < opaque(ActivityState::Working));
        // The centre of the ring is transparent; the centre of the disc is not.
        assert_eq!(px(&ActivityState::Offline.icon_rgba(), 16, 16)[3], 0);
        assert_eq!(px(&ActivityState::Working.icon_rgba(), 16, 16)[3], 255);
    }

    #[test]
    fn corners_are_transparent_and_marks_are_white() {
        for s in ALL {
            assert_eq!(px(&s.icon_rgba(), 0, 0)[3], 0);
        }
        // The "!" bar is white on the amber disc; the tick is white on the green one.
        assert_eq!(px(&ActivityState::NeedsYou.icon_rgba(), 16, 12), [255, 255, 255, 255]);
        assert_eq!(px(&ActivityState::Finished.icon_rgba(), 14, 21), [255, 255, 255, 255]);
        assert_eq!(px(&ActivityState::Working.icon_rgba(), 16, 16), [0x3b, 0x82, 0xf6, 255]);
    }

    #[test]
    fn tooltips_name_the_state() {
        for s in ALL {
            assert!(s.tooltip().starts_with("Hermate: "));
        }
    }
}
