//! GPU 采集：Windows PDH「GPU Engine」利用率与「GPU Process Memory」独立显存计数器。
//!
//! - 处理多 GPU、多 engine，对同一 PID 的 engine 聚合。
//! - 数据缺失 / 驱动不支持 / 计数器异常时返回空（上层显示「不可用」），绝不伪造 0。
//! - 界面须说明该数据来自 Windows 性能计数器。

use std::collections::HashMap;

/// 每个 PID 的 GPU 聚合数据。
#[derive(Debug, Clone, Copy, Default)]
pub struct GpuUsage {
    /// 利用率百分比（同 PID 所有 engine 求和，封顶 100 由上层决定是否裁剪）
    pub utilization: f32,
    /// 独立显存占用（字节）
    pub dedicated_bytes: u64,
}

/// GPU 采集器。保持一个长期 PDH 查询，只在可用时返回数据。
pub struct GpuCollector {
    #[cfg(windows)]
    inner: Option<win::PdhGpu>,
    available: bool,
}

impl Default for GpuCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl GpuCollector {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            match win::PdhGpu::create() {
                Ok(inner) => GpuCollector {
                    inner: Some(inner),
                    available: true,
                },
                Err(e) => {
                    tracing::warn!("GPU PDH 初始化失败，GPU 数据不可用: {e}");
                    GpuCollector {
                        inner: None,
                        available: false,
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            GpuCollector { available: false }
        }
    }

    /// 显式禁用（不初始化 PDH），用于测试与无 Windows 环境。
    pub fn disabled() -> Self {
        #[cfg(windows)]
        {
            GpuCollector {
                inner: None,
                available: false,
            }
        }
        #[cfg(not(windows))]
        {
            GpuCollector { available: false }
        }
    }

    /// 是否可用。不可用时上层应显示「不可用」。
    pub fn is_available(&self) -> bool {
        self.available
    }

    /// 采集一次，返回 pid -> GpuUsage。不可用或异常返回空 map。
    pub fn sample(&mut self) -> HashMap<u32, GpuUsage> {
        #[cfg(windows)]
        {
            if let Some(inner) = self.inner.as_mut() {
                match inner.sample() {
                    Ok(map) => return map,
                    Err(e) => {
                        tracing::debug!("GPU PDH 采集失败: {e}");
                        // 单次失败不永久禁用，但本次返回空
                    }
                }
            }
        }
        HashMap::new()
    }
}

#[cfg(windows)]
mod win {
    use super::GpuUsage;
    use std::collections::HashMap;
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER,
        PDH_HQUERY,
    };

    const PDH_MORE_DATA: u32 = 0x800007D2;
    const ERROR_SUCCESS: u32 = 0;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct PdhGpu {
        query: PDH_HQUERY,
        util: PDH_HCOUNTER,
        mem: PDH_HCOUNTER,
        primed: bool,
    }

    impl PdhGpu {
        pub fn create() -> Result<PdhGpu, String> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                let st = PdhOpenQueryW(PCWSTR::null(), 0, &mut query);
                if st != ERROR_SUCCESS {
                    return Err(format!("PdhOpenQueryW 失败: {st:#x}"));
                }

                let util_path = to_wide(r"\GPU Engine(*)\Utilization Percentage");
                let mut util = PDH_HCOUNTER::default();
                let st = PdhAddEnglishCounterW(query, PCWSTR(util_path.as_ptr()), 0, &mut util);
                if st != ERROR_SUCCESS {
                    let _ = PdhCloseQuery(query);
                    return Err(format!("添加 GPU Engine 计数器失败: {st:#x}"));
                }

                let mem_path = to_wide(r"\GPU Process Memory(*)\Dedicated Usage");
                let mut mem = PDH_HCOUNTER::default();
                // 显存计数器可能在部分驱动缺失；缺失不致命
                let _ = PdhAddEnglishCounterW(query, PCWSTR(mem_path.as_ptr()), 0, &mut mem);

                // 首次采集建立基线（利用率是需要两次采样的速率计数器）
                let st = PdhCollectQueryData(query);
                if st != ERROR_SUCCESS {
                    let _ = PdhCloseQuery(query);
                    return Err(format!("首次 PdhCollectQueryData 失败: {st:#x}"));
                }

                Ok(PdhGpu {
                    query,
                    util,
                    mem,
                    primed: true,
                })
            }
        }

        pub fn sample(&mut self) -> Result<HashMap<u32, GpuUsage>, String> {
            unsafe {
                let st = PdhCollectQueryData(self.query);
                if st != ERROR_SUCCESS {
                    return Err(format!("PdhCollectQueryData 失败: {st:#x}"));
                }
                let _ = self.primed;

                let mut out: HashMap<u32, GpuUsage> = HashMap::new();

                // 利用率（DOUBLE）
                for (name, val) in read_array_double(self.util)? {
                    if let Some(pid) = parse_pid(&name) {
                        out.entry(pid).or_default().utilization += val as f32;
                    }
                }
                // 显存（LARGE / 字节）——计数器可能无效，忽略错误
                if let Ok(items) = read_array_large(self.mem) {
                    for (name, val) in items {
                        if let Some(pid) = parse_pid(&name) {
                            let e = out.entry(pid).or_default();
                            // 同 PID 取各实例之和
                            e.dedicated_bytes = e.dedicated_bytes.saturating_add(val);
                        }
                    }
                }
                Ok(out)
            }
        }
    }

    impl Drop for PdhGpu {
        fn drop(&mut self) {
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }

    /// 实例名形如 pid_1234_luid_0x..._phys_0_eng_0_engtype_3D，抽取 pid。
    fn parse_pid(instance: &str) -> Option<u32> {
        let rest = instance.strip_prefix("pid_")?;
        let end = rest.find('_').unwrap_or(rest.len());
        rest[..end].parse().ok()
    }

    unsafe fn read_array_double(counter: PDH_HCOUNTER) -> Result<Vec<(String, f64)>, String> {
        let mut buffer_size = 0u32;
        let mut item_count = 0u32;
        let st = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buffer_size,
            &mut item_count,
            None,
        );
        if st != PDH_MORE_DATA {
            // 无实例或计数器无效
            return Ok(Vec::new());
        }
        if buffer_size == 0 || item_count == 0 {
            return Ok(Vec::new());
        }
        let mut buf = vec![0u8; buffer_size as usize];
        let items_ptr = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let st = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buffer_size,
            &mut item_count,
            Some(items_ptr),
        );
        if st != ERROR_SUCCESS {
            return Ok(Vec::new());
        }
        let items = std::slice::from_raw_parts(items_ptr, item_count as usize);
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let name = pcwstr_to_string(item.szName);
            let val = item.FmtValue.Anonymous.doubleValue;
            if val.is_finite() && val >= 0.0 {
                out.push((name, val));
            }
        }
        Ok(out)
    }

    unsafe fn read_array_large(counter: PDH_HCOUNTER) -> Result<Vec<(String, u64)>, String> {
        let mut buffer_size = 0u32;
        let mut item_count = 0u32;
        let st = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_LARGE,
            &mut buffer_size,
            &mut item_count,
            None,
        );
        if st != PDH_MORE_DATA || buffer_size == 0 || item_count == 0 {
            return Ok(Vec::new());
        }
        let mut buf = vec![0u8; buffer_size as usize];
        let items_ptr = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let st = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_LARGE,
            &mut buffer_size,
            &mut item_count,
            Some(items_ptr),
        );
        if st != ERROR_SUCCESS {
            return Ok(Vec::new());
        }
        let items = std::slice::from_raw_parts(items_ptr, item_count as usize);
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let name = pcwstr_to_string(item.szName);
            let val = item.FmtValue.Anonymous.largeValue;
            if val >= 0 {
                out.push((name, val as u64));
            }
        }
        Ok(out)
    }

    unsafe fn pcwstr_to_string(p: windows::core::PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        p.to_string().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_never_panics() {
        // 不管是否可用，采集都不能 panic
        let mut c = GpuCollector::new();
        let _ = c.is_available();
        let _ = c.sample();
    }
}
