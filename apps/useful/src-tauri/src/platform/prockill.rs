//! 首发版本仅提供只读进程监控；结束进程/进程树始终 fail closed。

pub const PROCESS_CONTROL_DISABLED: &str =
    "当前版本仅支持只读进程监控，不提供结束进程或结束进程树能力";

pub fn kill_process_checked(_pid: u32, _expected_start: u64, _tree: bool) -> Result<(), String> {
    Err(PROCESS_CONTROL_DISABLED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_and_tree_termination_are_stably_disabled() {
        assert_eq!(
            kill_process_checked(42, 1_000, false),
            Err(PROCESS_CONTROL_DISABLED.into())
        );
        assert_eq!(
            kill_process_checked(42, 1_000, true),
            Err(PROCESS_CONTROL_DISABLED.into())
        );
    }
}
