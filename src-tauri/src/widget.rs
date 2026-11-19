//! The edge widget: a small frameless, always-on-top window docked to the right edge of the
//! primary monitor. It is created once, hidden, and shown or hidden on request; the main window
//! owns all state and talks to it through events (the widget holds no connection of its own).

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "widget";
const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 200.0;
const MARGIN: f64 = 8.0;

/// Physical (x, y) that centres a window of the given physical size on the right edge of a monitor.
pub fn dock_position(mon_pos: (i32, i32), mon_size: (u32, u32), win_size: (u32, u32), margin: i32) -> (i32, i32) {
    let x = mon_pos.0 + mon_size.0 as i32 - win_size.0 as i32 - margin;
    let y = mon_pos.1 + (mon_size.1 as i32 - win_size.1 as i32) / 2;
    (x, y.max(mon_pos.1))
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#widget".into()))
        .title("Hermate widget")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;
    dock(&window);
    Ok(())
}

fn dock(window: &WebviewWindow) {
    let _ = window.set_size(LogicalSize::new(WIDTH, HEIGHT));
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let (x, y) = dock_position(
            (monitor.position().x, monitor.position().y),
            (monitor.size().width, monitor.size().height),
            ((WIDTH * scale) as u32, (HEIGHT * scale) as u32),
            (MARGIN * scale) as i32,
        );
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// Show or hide the widget (re-docking when shown, in case the monitor layout changed).
pub fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or_else(|| "widget window is not available".to_string())?;
    if visible {
        dock(&window);
        window.show().map_err(|e| e.to_string())
    } else {
        window.hide().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docks_to_the_right_edge_and_centres_vertically() {
        assert_eq!(dock_position((0, 0), (1920, 1080), (300, 200), 8), (1612, 440));
    }

    #[test]
    fn respects_a_monitor_offset_and_scaling() {
        // A second monitor to the left (negative origin), 150% scale: window and margin are physical.
        assert_eq!(dock_position((-2560, 0), (2560, 1440), (450, 300), 12), (-2560 + 2560 - 450 - 12, 570));
    }

    #[test]
    fn never_places_the_window_above_the_monitor() {
        let (_, y) = dock_position((0, 0), (800, 100), (300, 200), 8);
        assert_eq!(y, 0);
    }
}
