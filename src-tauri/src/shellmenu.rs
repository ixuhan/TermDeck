//! The real Windows Explorer context menu.
//!
//! `IContextMenu` is what Explorer itself uses, so the menu contains everything
//! the user actually has installed — "打开方式", 7-Zip, TortoiseGit, "发送到",
//! 属性 — instead of a hand-written approximation. Verb handling (rename,
//! delete to the recycle bin, properties, copy) is delegated to the shell, so
//! behaviour matches Explorer exactly.

#![cfg(windows)]

use std::ffi::c_void;
use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::Shell::{
    IContextMenu, IShellItem, SHCreateItemFromParsingName, BHID_SFUIObject,
    CMINVOKECOMMANDINFOEX, CMF_NORMAL,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, SW_SHOWNORMAL, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON,
    TPM_TOPALIGN, TrackPopupMenu,
};

// Not exposed by the windows crate at these paths; values from shellapi.h.
const CMIC_MASK_UNICODE: u32 = 0x0000_4000;
const CMIC_MASK_ASYNCOK: u32 = 0x0010_0000;

/// Menu ids must start at 1 so 0 can mean "dismissed".
const ID_FIRST: u32 = 1;
const ID_LAST: u32 = 0x7FFF;

/// Shows the shell context menu for `path` at the given client coordinates.
///
/// Blocking: returns once the user picks an item or dismisses the menu. Must be
/// called on a thread that owns a message loop (the window thread), hence the
/// `run_on_main_thread` hop in the command.
pub fn show(path: &str, hwnd: HWND, x: i32, y: i32) -> Result<(), String> {
    unsafe {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
            .map_err(|e| format!("解析路径失败: {e}"))?;
        let ctx: IContextMenu = item
            .BindToHandler(None, &BHID_SFUIObject)
            .map_err(|e| format!("获取上下文菜单失败: {e}"))?;

        let menu = CreatePopupMenu().map_err(|e| format!("创建菜单失败: {e}"))?;

        let mut pt = POINT { x, y };
        if !ClientToScreen(hwnd, &mut pt).as_bool() {
            let _ = DestroyMenu(menu);
            return Err("坐标转换失败".into());
        }

        let added = ctx.QueryContextMenu(menu, 0, ID_FIRST, ID_LAST, CMF_NORMAL);
        if added.is_err() {
            let _ = DestroyMenu(menu);
            return Err(format!("填充菜单失败: {added:?}"));
        }

        let picked = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            None,
            hwnd,
            None,
        );
        let _ = DestroyMenu(menu);

        let cmd = picked.0 as u32;
        if cmd < ID_FIRST {
            // Dismissed without a choice.
            return Ok(());
        }

        // Verb ids are offsets from idCmdFirst, passed through MAKEINTRESOURCE.
        let offset = cmd - ID_FIRST;
        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_UNICODE | CMIC_MASK_ASYNCOK,
            hwnd,
            lpVerb: PCSTR(offset as usize as *const u8),
            lpVerbW: PCWSTR(offset as usize as *const u16),
            nShow: SW_SHOWNORMAL.0 as i32,
            ptInvoke: pt,
            ..Default::default()
        };

        ctx.InvokeCommand(&info as *const _ as *const _)
            .map_err(|e| format!("执行菜单命令失败: {e}"))?;
    }
    Ok(())
}

/// Rebuilds an `HWND` from the raw handle Tauri hands out, which may come from
/// a different `windows` crate version than ours.
pub fn hwnd_from_raw(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}
