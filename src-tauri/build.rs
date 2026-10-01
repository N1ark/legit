fn main() {
    // The app's own commands get `allow-*` permissions, so capabilities/default.json can grant
    // them to the repo windows (whose pages come from the local server, a remote origin).
    let manifest = tauri_build::AppManifest::new().commands(&["recent_repos", "open_repo", "pick_repo", "forget_repo"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("failed to run tauri-build");
}
