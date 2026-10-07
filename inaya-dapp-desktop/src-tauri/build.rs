// The website loaded in the desktop window is a REMOTE origin, and Tauri v2 refuses every app command from a remote origin unless a capability names it.
// Declaring the commands here makes Tauri generate an `allow-<command>` permission for each, which capabilities/default.json then grants to the site's own origin.
// Each sensitive command still verifies the calling window's origin itself (verify_trusted_origin in src/lib.rs). Same fix as inaya-desktop (the sibling
// Business Workspace wrapper)'s build.rs -- see that file's comment for the full reasoning.
const COMMANDS: &[&str] = &[
    "store_passkey_secure",
    "retrieve_passkey_secure",
    "clear_passkey_secure",
    "open_module_window",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("failed to run the Tauri build script");
}
