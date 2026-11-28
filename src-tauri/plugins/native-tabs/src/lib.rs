//! The phone's tab bar, drawn by UIKit rather than by the page.
//!
//! A `UITabBar` on iOS 26 and later is Liquid Glass by itself; nothing drawn
//! in a web view can be, since the material samples what is behind it in the
//! compositor. So the bar is native and the page only listens to it: every
//! command is handled in Swift (`ios/Sources/NativeTabsPlugin.swift`) and
//! reaches it through Tauri's forwarding of plugin commands it has no Rust
//! handler for. Everywhere but iOS the plugin registers nothing, the commands
//! fail, and the page keeps drawing its own bar.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_tabs);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-tabs")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_native_tabs)?;
            Ok(())
        })
        .build()
}
