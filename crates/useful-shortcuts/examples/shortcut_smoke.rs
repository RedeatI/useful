use std::ffi::OsString;
use std::path::{Path, PathBuf};
use useful_shortcuts::{
    create_shortcut, delete_shortcut, read_shortcut_details, repair_shortcut, sanitize_filename,
    ShortcutSpec,
};

fn value(args: &mut impl Iterator<Item = OsString>, name: &str) -> PathBuf {
    PathBuf::from(args.next().unwrap_or_else(|| panic!("missing {name}")))
}

fn text(args: &mut impl Iterator<Item = OsString>, name: &str) -> String {
    args.next()
        .unwrap_or_else(|| panic!("missing {name}"))
        .to_string_lossy()
        .into_owned()
}

fn spec(exe: PathBuf, lnk: PathBuf, action_id: String, display_name: String) -> ShortcutSpec {
    let working_dir = exe.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
    ShortcutSpec {
        target_exe: exe.clone(),
        args: vec!["--open-action".into(), action_id],
        working_dir,
        lnk_path: lnk,
        icon_path: Some(exe),
        description: format!("Useful native smoke - {display_name}"),
    }
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let command = text(&mut args, "command");
    match command.as_str() {
        "create" => {
            let exe = value(&mut args, "exe");
            let desktop = value(&mut args, "desktop");
            let action_id = text(&mut args, "action-id");
            let display_name = text(&mut args, "display-name");
            let lnk = desktop.join(format!("{}.lnk", sanitize_filename(&display_name)));
            create_shortcut(&spec(exe, lnk.clone(), action_id, display_name))
                .expect("create shortcut");
            println!("{}", lnk.display());
        }
        "repair" => {
            let exe = value(&mut args, "exe");
            let lnk = value(&mut args, "lnk");
            let action_id = text(&mut args, "action-id");
            let display_name = text(&mut args, "display-name");
            repair_shortcut(&spec(exe, lnk.clone(), action_id, display_name))
                .expect("repair shortcut");
            println!("{}", lnk.display());
        }
        "inspect" => {
            let lnk = value(&mut args, "lnk");
            let expected_exe = value(&mut args, "expected-exe");
            let expected_action = text(&mut args, "expected-action");
            let details = read_shortcut_details(&lnk).expect("inspect shortcut");
            assert_eq!(details.target_exe, expected_exe, "target path mismatch");
            assert_eq!(
                details.args,
                format!("--open-action {expected_action}"),
                "arguments mismatch"
            );
            assert_eq!(
                details.working_dir,
                expected_exe.parent().unwrap_or_else(|| Path::new(".")),
                "working directory mismatch"
            );
            assert_eq!(details.icon_path.as_deref(), Some(expected_exe.as_path()));
            assert!(!details.description.is_empty(), "description is empty");
            println!("ok");
        }
        "delete" => {
            let lnk = value(&mut args, "lnk");
            delete_shortcut(&lnk).expect("delete shortcut");
            assert!(!lnk.exists(), "shortcut still exists after delete");
            println!("ok");
        }
        _ => panic!("unknown command: {command}"),
    }
}
