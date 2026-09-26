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
pub fn ensure_main_window_visible(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        if !is_wsl() {
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
        if monitors.is_empty() {
            return;
        }

        let on_a_monitor = monitors.iter().any(|monitor| {
            let origin = monitor.position();
            let extent = monitor.size();
            let right = origin.x + extent.width as i32;
            let bottom = origin.y + extent.height as i32;
            let cx = position.x + (size.width as i32) / 2;
            let cy = position.y + (size.height as i32) / 2;
            cx >= origin.x && cx < right && cy >= origin.y && cy < bottom
        });
        if on_a_monitor {
            return;
        }

        let monitor = monitors
            .iter()
            .min_by_key(|monitor| {
                let pos = monitor.position();
                (pos.x, pos.y)
            })
            .expect("non-empty monitors");
        let origin = monitor.position();
        let x = origin.x + 80;
        let y = origin.y + 60;
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        eprintln!("[window_style] WSL: window was off-screen; moved to ({x}, {y})");
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "linux")]
fn is_wsl() -> bool {
    std::fs::read_to_string("/proc/version")
        .map(|text| text.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
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
