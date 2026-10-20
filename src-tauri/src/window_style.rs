//! Platform window chrome helpers.
//!
//! On macOS we make the window transparent and clip the contentView with a
//! corner radius for a rounded look. On Linux/WSL we only nudge the window
//! on-screen when it would otherwise open off the visible displays.

use tauri::Manager;

/// (Sequoia/Tahoe ~10pt) for a more rounded look.
#[cfg(target_os = "macos")]
const CORNER_RADIUS: f64 = 16.0;

pub fn apply_rounded_corners(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Err(e) = round_macos_window(&window) {
            eprintln!("[window_style] falha ao arredondar a janela: {e}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// On WSL, only move the window if it is clearly off every known monitor.
/// Always repositioning fought maximize/restore and left a floating frame.
/// The fallback monitor is the one under the center of the desktop, which on a
/// typical WSLg layout is the Windows primary — not the leftmost output.
pub fn ensure_main_window_visible(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        if !crate::wsl::is_wsl() {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        let Ok(position) = window.outer_position() else {
            return;
        };
        let Ok(size) = window.outer_size() else {
            return;
        };
        let Ok(monitors) = window.available_monitors() else {
            return;
        };
        let monitors: Vec<MonitorRect> = monitors
            .iter()
            .map(|monitor| {
                let origin = monitor.position();
                let extent = monitor.size();
                MonitorRect {
                    x: origin.x,
                    y: origin.y,
                    width: extent.width,
                    height: extent.height,
                }
            })
            .collect();
        if window_center_on_any_monitor((position.x, position.y), (size.width, size.height), &monitors) {
            return;
        }
        let Some(monitor) = pick_home_monitor(&monitors) else {
            return;
        };
        let (x, y) = place_on_monitor(monitor, (size.width, size.height));
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        eprintln!(
            "[window_style] WSL: window was off-screen; moved to ({x}, {y}) on monitor ({}, {})",
            monitor.x, monitor.y
        );
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MonitorRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn contains_point(monitor: MonitorRect, x: i32, y: i32) -> bool {
    x >= monitor.x
        && y >= monitor.y
        && x < monitor.x.saturating_add(monitor.width as i32)
        && y < monitor.y.saturating_add(monitor.height as i32)
}

/// A zero-sized window has no real center yet, so it does not count as on-screen.
fn window_center_on_any_monitor(
    position: (i32, i32),
    size: (u32, u32),
    monitors: &[MonitorRect],
) -> bool {
    if size.0 < 200 || size.1 < 200 {
        return false;
    }
    let cx = position.0 + (size.0 as i32) / 2;
    let cy = position.1 + (size.1 as i32) / 2;
    monitors.iter().copied().any(|monitor| contains_point(monitor, cx, cy))
}

/// Monitor that contains the center of the bounding box, else the largest one.
fn pick_home_monitor(monitors: &[MonitorRect]) -> Option<MonitorRect> {
    let min_x = monitors.iter().map(|monitor| monitor.x).min()?;
    let min_y = monitors.iter().map(|monitor| monitor.y).min()?;
    let max_x = monitors
        .iter()
        .map(|monitor| monitor.x.saturating_add(monitor.width as i32))
        .max()?;
    let max_y = monitors
        .iter()
        .map(|monitor| monitor.y.saturating_add(monitor.height as i32))
        .max()?;
    let cx = min_x + (max_x - min_x) / 2;
    let cy = min_y + (max_y - min_y) / 2;
    monitors
        .iter()
        .copied()
        .find(|monitor| contains_point(*monitor, cx, cy))
        .or_else(|| {
            monitors
                .iter()
                .copied()
                .max_by_key(|monitor| monitor.width as u64 * monitor.height as u64)
        })
}

fn place_on_monitor(monitor: MonitorRect, size: (u32, u32)) -> (i32, i32) {
    let width = if size.0 >= 200 { size.0 as i32 } else { 1280 };
    let height = if size.1 >= 200 { size.1 as i32 } else { 800 };
    let x = monitor.x + ((monitor.width as i32 - width) / 2).max(40);
    let y = monitor.y + ((monitor.height as i32 - height) / 2).max(40);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This machine: left 1080p, primary 1080p, portrait on the right.
    /// WSLg shifts the origin so the left monitor is x=0 and the portrait top is y=0.
    fn wsl_layout() -> Vec<MonitorRect> {
        vec![
            MonitorRect { x: 1920, y: 313, width: 1920, height: 1080 },
            MonitorRect { x: 0, y: 313, width: 1920, height: 1080 },
            MonitorRect { x: 3840, y: 0, width: 1080, height: 1920 },
        ]
    }

    #[test]
    fn home_monitor_is_under_the_desktop_center_not_the_leftmost_output() {
        let home = pick_home_monitor(&wsl_layout()).expect("layout");
        assert_eq!((home.x, home.y), (1920, 313));
    }

    #[test]
    fn a_degenerate_window_at_the_origin_is_not_on_screen() {
        assert!(!window_center_on_any_monitor((0, 0), (0, 0), &wsl_layout()));
    }

    #[test]
    fn placement_keeps_the_window_on_the_home_monitor() {
        let home = pick_home_monitor(&wsl_layout()).expect("layout");
        let (x, y) = place_on_monitor(home, (1280, 800));
        assert!(window_center_on_any_monitor((x, y), (1280, 800), &wsl_layout()));
        assert!(x >= 1920 && x < 1920 + 1920);
        assert!(y >= 313 && y < 313 + 1080);
    }
}

#[cfg(target_os = "macos")]
fn round_macos_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2::runtime::AnyObject;

    let ns_window_ptr = window
        .ns_window()
        .map_err(|e| format!("ns_window indisponível: {e}"))?;
    if ns_window_ptr.is_null() {
        return Err("ns_window retornou ponteiro nulo".into());
    }

    // Setup runs on the main thread; these AppKit messages are safe here.
    unsafe {
        let ns_window: &AnyObject = &*(ns_window_ptr as *const AnyObject);

        let _: () = objc2::msg_send![ns_window, setOpaque: false];
        let clear: *mut AnyObject = objc2::msg_send![objc2::class!(NSColor), clearColor];
        let _: () = objc2::msg_send![ns_window, setBackgroundColor: clear];

        let content: *mut AnyObject = objc2::msg_send![ns_window, contentView];
        if content.is_null() {
            return Err("contentView nula".into());
        }
        let _: () = objc2::msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = objc2::msg_send![content, layer];
        if layer.is_null() {
            return Err("layer do contentView nula".into());
        }
        let _: () = objc2::msg_send![layer, setCornerRadius: CORNER_RADIUS];
        let _: () = objc2::msg_send![layer, setMasksToBounds: true];
    }

    Ok(())
}
