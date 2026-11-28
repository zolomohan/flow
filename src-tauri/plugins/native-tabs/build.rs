const COMMANDS: &[&str] = &[
    "show",
    "set_selected",
    "set_hidden",
    "set_badge",
    "set_tint",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
