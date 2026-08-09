#[cfg(windows)]
use std::{env, path::Path};

#[cfg(windows)]
const ICON_PATH: &str = "../../apps/useful/src-tauri/icons/icon.ico";

#[cfg(windows)]
fn main() -> std::io::Result<()> {
    println!("cargo:rerun-if-changed={ICON_PATH}");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }

    let icon_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(ICON_PATH);
    let mut resource = tauri_winres::WindowsResource::new();
    resource
        .set("ProductName", "Useful")
        .set("FileDescription", "Useful Update Bootstrap")
        .set("OriginalFilename", "useful-bootstrap.exe")
        .set("InternalName", "useful-bootstrap.exe")
        .set_icon(&icon_path.to_string_lossy());
    resource.compile()
}

#[cfg(not(windows))]
fn main() {}
