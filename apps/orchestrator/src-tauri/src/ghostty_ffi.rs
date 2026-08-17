//! FFI para o shim C do libghostty (`ghostty_shim.m`).
//!

//!

#![cfg(all(target_os = "macos", ghostty_linked))]

use std::os::raw::{c_char, c_void};

pub type FlashworkSurface = *mut c_void;

#[allow(dead_code)]
extern "C" {
    pub fn flashwork_ghostty_ensure_app() -> bool;
    pub fn flashwork_ghostty_surface_new(
        nsview: *mut c_void,
        cwd: *const c_char,
        command: *const c_char,
        scale_factor: f64,
    ) -> FlashworkSurface;
    pub fn flashwork_ghostty_surface_set_frame(surface: FlashworkSurface, x: f64, y: f64, w: f64, h: f64);
    pub fn flashwork_ghostty_surface_set_hidden(surface: FlashworkSurface, hidden: bool);
    pub fn flashwork_ghostty_surface_set_size(surface: FlashworkSurface, width_px: u32, height_px: u32);
    pub fn flashwork_ghostty_surface_set_content_scale(surface: FlashworkSurface, x: f64, y: f64);
    pub fn flashwork_ghostty_surface_set_focus(surface: FlashworkSurface, focused: bool);
    pub fn flashwork_ghostty_surface_process_exited(surface: FlashworkSurface) -> bool;
    pub fn flashwork_ghostty_surface_draw(surface: FlashworkSurface);
    pub fn flashwork_ghostty_surface_free(surface: FlashworkSurface);
    pub fn flashwork_ghostty_app_tick();
    pub fn flashwork_ghostty_kill_all();
    pub fn flashwork_ghostty_surface_send_text(
        surface: FlashworkSurface,
        utf8: *const c_char,
        len: usize,
    );
    pub fn flashwork_ghostty_surface_read_screen(
        surface: FlashworkSurface,
        out: *mut c_char,
        cap: usize,
    ) -> usize;
    pub fn flashwork_ghostty_draw_count() -> u64;
    pub fn flashwork_ghostty_test_ime_compose(
        surface: FlashworkSurface,
        marked: *const c_char,
        final_: *const c_char,
    ) -> bool;
    pub fn flashwork_ghostty_test_type_key(
        surface: FlashworkSurface,
        characters: *const c_char,
        keycode: u16,
    ) -> bool;
    pub fn flashwork_ghostty_test_last_key_text() -> *const c_char;
    pub fn flashwork_ghostty_test_last_key_composing() -> bool;
}
