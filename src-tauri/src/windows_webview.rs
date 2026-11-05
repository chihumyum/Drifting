//! WebView2 behaves like a browser unless told otherwise: F5 and Ctrl+R
//! reload the whole interface, Ctrl+P prints it, Alt+Left navigates back, and
//! right-click offers Back, Reload, Save as and Print. Reloading drops the
//! renderer's session in the middle of writing, so the browser shortcuts are
//! turned off (the keys still reach Drifting's own handlers), and the default
//! context menu keeps its editing items (cut, copy, paste, emoji, spelling)
//! but loses the browser's own.
//!
//! The native title bar goes too: the renderer draws the window buttons as a
//! glass pill in the top-left corner (WindowsCaption.tsx). Tauri keeps the
//! undecorated window resizable from its edges and keeps its shadow.

/// Default menu items that belong to a browser, not to a writing app.
#[cfg_attr(not(windows), allow(dead_code))]
const BROWSER_ITEMS: &[&str] = &[
    "back",
    "forward",
    "reload",
    "saveAs",
    "print",
    "share",
    "webCapture",
    "createQrCode",
    "inspectElement",
    "openLinkInNewWindow",
    "saveLinkAs",
    "saveImageAs",
    "saveMediaAs",
    "openImageInNewWindow",
    "sendTabToDevices",
];

/// Separators left at either end or next to another separator once the
/// browser items are gone, highest index first.
#[cfg_attr(not(windows), allow(dead_code))]
fn separators_to_drop(separators: &[bool]) -> Vec<usize> {
    let mut drop = Vec::new();
    let mut after_separator = true;
    for (index, &separator) in separators.iter().enumerate() {
        if separator && after_separator {
            drop.push(index);
        } else {
            after_separator = separator;
        }
    }
    let mut end = separators.len();
    while let Some(last) = end.checked_sub(1) {
        if drop.contains(&last) {
            end = last;
        } else if separators[last] {
            drop.push(last);
            end = last;
        } else {
            break;
        }
    }
    drop.sort_unstable_by(|a, b| b.cmp(a));
    drop
}

#[cfg(windows)]
pub(crate) fn configure(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::{
        ContextMenuRequestedEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3, ICoreWebView2_11},
    };
    use windows::core::Interface;

    window.set_decorations(false)?;
    window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        if let Ok(settings) = core
            .Settings()
            .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
        {
            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
        }
        if let Ok(core) = core.cast::<ICoreWebView2_11>() {
            let mut token = 0_i64;
            let _ = core.add_ContextMenuRequested(
                &ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        let _ = keep_editing_items(&args);
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    })
}

#[cfg(windows)]
unsafe fn keep_editing_items(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuRequestedEventArgs,
) -> windows::core::Result<()> {
    use webview2_com::{
        take_pwstr,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        },
    };
    use windows::core::PWSTR;

    let items = args.MenuItems()?;
    let mut count = 0_u32;
    items.Count(&mut count)?;
    for index in (0..count).rev() {
        let mut name = PWSTR::null();
        items.GetValueAtIndex(index)?.Name(&mut name)?;
        if BROWSER_ITEMS.contains(&take_pwstr(name).as_str()) {
            items.RemoveValueAtIndex(index)?;
        }
    }
    items.Count(&mut count)?;
    let mut separators = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        items.GetValueAtIndex(index)?.Kind(&mut kind)?;
        separators.push(kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR);
    }
    let drop = separators_to_drop(&separators);
    for &index in &drop {
        items.RemoveValueAtIndex(index as u32)?;
    }
    // Nothing left to offer (a right-click on empty paper): show no menu.
    if drop.len() == separators.len() {
        args.SetHandled(true)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::separators_to_drop;

    #[test]
    fn separators_survive_only_between_items() {
        let (item, separator) = (false, true);
        assert_eq!(separators_to_drop(&[]), Vec::<usize>::new());
        assert_eq!(
            separators_to_drop(&[item, separator, item]),
            Vec::<usize>::new()
        );
        assert_eq!(
            separators_to_drop(&[separator, item, separator, separator, item, separator]),
            vec![5, 3, 0]
        );
        assert_eq!(separators_to_drop(&[separator, separator]), vec![1, 0]);
        assert_eq!(
            separators_to_drop(&[item, separator, separator]),
            vec![2, 1]
        );
    }
}
