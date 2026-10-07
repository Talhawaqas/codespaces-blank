// The website loaded in the desktop window is a REMOTE origin, and Tauri v2 refuses every app command from a remote origin unless a capability names it.
// Declaring the commands here makes Tauri generate an `allow-<command>` permission for each, which capabilities/default.json then grants to the site's own origin.
// Each sensitive command still verifies the calling window's origin itself (verify_trusted_origin in src/lib.rs).
const COMMANDS: &[&str] = &[
    "notify_pending_approvals",
    "notify_security_event",
    "notify_chat_message",
    "set_chat_unread",
    "block_ip",
    "unblock_ip",
    "store_passkey_secure",
    "retrieve_passkey_secure",
    "clear_passkey_secure",
    "open_module_window",
    "mount_inaya_drive",
    "unmount_inaya_drive",
    "directsync_store_credential",
    "directsync_credential_configured",
    "directsync_clear_credential",
    "directsync_pick_folder",
    "directsync_add_folder",
    "directsync_remove_folder",
    "directsync_pause_folder",
    "directsync_resume_folder",
    "directsync_list_folders",
    "directsync_list_queue",
    "directsync_retry_failed",
    "directsync_create_secure_link",
    "cleaner_scan",
    "cleaner_cleanup",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("failed to run the Tauri build script");
}
