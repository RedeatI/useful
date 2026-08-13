fn main() {
    // Integration-test executables are not the Tauri app binary, so they do
    // not inherit its Windows manifest. tauri-plugin-dialog links
    // TaskDialogIndirect; without a Common Controls v6 activation context the
    // Windows loader selects the legacy comctl32 surface and exits before the
    // Rust test harness starts (STATUS_ENTRYPOINT_NOT_FOUND).
    #[cfg(target_os = "windows")]
    {
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
        )
        .join("tests/windows-test.manifest");

        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
    tauri_build::build()
}
