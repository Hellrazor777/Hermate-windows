//! A Windows job object that kills a process and everything it started when the handle closes.
//!
//! `Child::kill` only ends the process we spawned. `hermes.exe` may be a launcher whose real server
//! is a descendant, and none of it is stopped if Hermate is force-quit or crashes. A job created
//! with KILL_ON_JOB_CLOSE fixes both: the OS closes the handle when Hermate dies for any reason,
//! and dropping the `Job` ends the whole tree. No-op on other platforms.

use std::process::Child;

pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The handle is only closed on drop; it is safe to move between threads.
unsafe impl Send for Job {}

#[cfg(windows)]
impl Job {
    /// Put `child` (and its future descendants) in a new kill-on-close job. Returns None if the
    /// OS refuses; callers then fall back to killing the child directly.
    pub fn adopt(child: &Child) -> Option<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;

        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
                && AssignProcessToJobObject(handle, child.as_raw_handle() as _) != 0;
            if !ok {
                CloseHandle(handle);
                return None;
            }
            Some(Job { handle })
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
impl Job {
    pub fn adopt(_child: &Child) -> Option<Job> {
        None
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn alive(pid: u32) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    #[test]
    fn dropping_the_job_ends_a_grandchild_that_child_kill_would_leave() {
        // cmd starts a long ping (the grandchild) and prints its pid via a PowerShell wrapper.
        let mut child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "$p = Start-Process ping -ArgumentList '-n','60','127.0.0.1' -PassThru -WindowStyle Hidden; $p.Id; Start-Sleep 60",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let job = Job::adopt(&child).expect("job");
        use std::io::{BufRead, BufReader};
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let grandchild: u32 = line.trim().parse().expect("pid");
        assert!(alive(grandchild));
        drop(job);
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(!alive(grandchild), "grandchild survived the job");
        let _ = child.kill();
    }
}
