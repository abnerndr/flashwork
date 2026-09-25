//! Platform window chrome helpers.
//!
//! On macOS we make the window transparent and clip the contentView with a
//! corner radius for a rounded look. On Linux/WSL we only ensure the main
//! window is visible and on-screen.

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

/// On WSL, undecorated GTK windows can map off the primary monitor or stay
/// unfocused. Bring the main window on-screen and focused at startup.
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
        let (x, y) = match window.available_monitors() {
            Ok(monitors) if !monitors.is_empty() => {
                let monitor = monitors
                    .iter()
                    .min_by_key(|monitor| {
                        let pos = monitor.position();
                        (pos.x, pos.y)
                    })
                    .expect("non-empty monitors");
                let pos = monitor.position();
                (pos.x + 80, pos.y + 60)
            }
            _ => match window.primary_monitor() {
                Ok(Some(monitor)) => {
                    let pos = monitor.position();
                    (pos.x + 80, pos.y + 60)
                }
                _ => (80, 60),
            },
        };
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        let _ = window.set_focus();
        eprintln!("[window_style] WSL: main window moved to ({x}, {y})");
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
