//! 媒体 sidecar 的统一资源边界。

use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const MAX_CONCURRENT_SIDECARS: usize = 4;
pub const SIDECAR_SLOT_WAIT_DEADLINE: Duration = Duration::from_secs(5);
pub const CHILD_REAP_DEADLINE: Duration = Duration::from_secs(3);
pub const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub const PROBE_DEADLINE: Duration = Duration::from_secs(20);
pub const ENCODER_DETECT_DEADLINE: Duration = Duration::from_secs(15);
pub const THUMBNAIL_DEADLINE: Duration = Duration::from_secs(30);
// 允许超长源与软件编码，但仍设置不可无限占用的硬边界。
pub const EXPORT_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);

pub const MAX_CAPTURE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PROGRESS_LINE_BYTES: usize = 64 * 1024;
pub const MAX_THUMBNAIL_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_EXPORT_BYTES: u64 = 256 * 1024 * 1024 * 1024;

fn sidecar_slots() -> &'static Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_SIDECARS)))
}

pub async fn acquire_sidecar_slot() -> Result<OwnedSemaphorePermit, &'static str> {
    tokio::time::timeout(
        SIDECAR_SLOT_WAIT_DEADLINE,
        sidecar_slots().clone().acquire_owned(),
    )
    .await
    .map_err(|_| "等待媒体 sidecar 资源槽超时")?
    .map_err(|_| "媒体 sidecar 资源槽已关闭")
}

pub fn try_acquire_sidecar_slot() -> Result<OwnedSemaphorePermit, &'static str> {
    sidecar_slots()
        .clone()
        .try_acquire_owned()
        .map_err(|_| "媒体 sidecar 并发已达上限")
}

/// Windows sidecar 进程树的 kill-on-close Job Object。
#[cfg(windows)]
pub struct WindowsSidecarJob(windows::Win32::Foundation::HANDLE);

// Job handles are kernel objects and may be managed by the dedicated background reaper.
#[cfg(windows)]
unsafe impl Send for WindowsSidecarJob {}

#[cfg(windows)]
impl WindowsSidecarJob {
    pub fn attach_std(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|error| format!("无法创建 sidecar Job Object: {error}"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .and_then(|_| AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())))
            {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                return Err(format!("无法把 sidecar 放入受控进程树: {error}"));
            }
            Ok(Self(job))
        }
    }

    pub fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsSidecarJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_finite_and_keep_long_exports_reasonable() {
        assert!((2..=8).contains(&MAX_CONCURRENT_SIDECARS));
        assert!(SIDECAR_SLOT_WAIT_DEADLINE <= Duration::from_secs(10));
        assert!(CHILD_REAP_DEADLINE <= Duration::from_secs(5));
        assert!(PROBE_DEADLINE < THUMBNAIL_DEADLINE);
        assert!(EXPORT_DEADLINE >= Duration::from_secs(12 * 60 * 60));
        assert_eq!(MAX_CAPTURE_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_PROGRESS_LINE_BYTES, 64 * 1024);
        assert_eq!(MAX_THUMBNAIL_BYTES, 32 * 1024 * 1024);
    }
}
