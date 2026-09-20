// winfsp_init() (called at process start, see main.rs) only resolves
// "winfsp-x64.dll" via LoadLibraryW's bare-name search order (app
// directory / PATH / System32) -- it does NOT consult the registry for
// WinFsp's actual install location unless the winfsp crate's "system"
// feature is enabled, which pulls in bindgen and requires libclang (not
// available in every build environment). Simpler, equally correct fix:
// copy winfsp-x64.dll into OUT_DIR's target directory at build time, so
// it's sitting right next to the produced exe -- "the directory from
// which the application loaded" is the FIRST place LoadLibraryW looks.
// This is also exactly what real deployment needs anyway: inaya-desktop's
// Tauri packaging has to ship this DLL alongside the helper exe as an
// externalBin resource regardless.
fn main() {
    winfsp::build::winfsp_link_delayload();
    copy_winfsp_dll_next_to_exe();
}

fn copy_winfsp_dll_next_to_exe() {
    use std::path::PathBuf;

    let candidates = [
        r"C:\Program Files (x86)\WinFsp\bin\winfsp-x64.dll",
        r"C:\Program Files\WinFsp\bin\winfsp-x64.dll",
    ];
    let Some(src) = candidates.iter().find(|p| std::path::Path::new(p).exists()) else {
        println!("cargo:warning=winfsp-x64.dll not found at a known WinFsp install location; the built exe may fail at startup with ERROR_DELAY_LOAD_FAILED unless it's on PATH.");
        return;
    };

    // OUT_DIR is target/<profile>/build/<pkg>-<hash>/out -- the actual
    // exe lands three directories up, at target/<profile>/.
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR set by cargo");
    let exe_dir: PathBuf = PathBuf::from(&out_dir).join("../../..");
    let dest = exe_dir.join("winfsp-x64.dll");

    if let Err(e) = std::fs::copy(src, &dest) {
        println!("cargo:warning=failed to copy winfsp-x64.dll next to the built exe: {e}");
    } else {
        println!("cargo:rerun-if-changed={src}");
    }
}
