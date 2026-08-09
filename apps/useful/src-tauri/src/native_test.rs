#[cfg(windows)]
pub fn clipboard_roundtrip(marker: &str) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL},
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
                OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        },
    };

    const CF_UNICODETEXT: u32 = 13;

    fn open_clipboard() -> Result<(), String> {
        for _ in 0..20 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        Err("系统剪贴板被其他进程持续占用".to_string())
    }

    fn read_text() -> Result<String, String> {
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
            return Ok(String::new());
        }
        open_clipboard()?;
        let result = (|| {
            let handle = unsafe { GetClipboardData(CF_UNICODETEXT) }
                .map_err(|error| format!("读取剪贴板句柄失败: {error}"))?;
            let global = HGLOBAL(handle.0);
            let byte_len = unsafe { GlobalSize(global) };
            if byte_len < 2 {
                return Ok(String::new());
            }
            let pointer = unsafe { GlobalLock(global) } as *const u16;
            if pointer.is_null() {
                return Err("锁定剪贴板内存失败".to_string());
            }
            let units = unsafe { std::slice::from_raw_parts(pointer, byte_len / 2) };
            let length = units
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(units.len());
            let text = String::from_utf16(&units[..length])
                .map_err(|error| format!("剪贴板文本不是有效 UTF-16: {error}"));
            let _ = unsafe { GlobalUnlock(global) };
            text
        })();
        let close_result =
            unsafe { CloseClipboard() }.map_err(|error| format!("关闭剪贴板失败: {error}"));
        match (result, close_result) {
            (Ok(text), Ok(())) => Ok(text),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }

    fn write_text(text: &str) -> Result<(), String> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        open_clipboard()?;
        let result = (|| {
            unsafe { EmptyClipboard() }.map_err(|error| format!("清空剪贴板失败: {error}"))?;
            let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, units.len() * 2) }
                .map_err(|error| format!("分配剪贴板内存失败: {error}"))?;
            let pointer = unsafe { GlobalLock(global) } as *mut u16;
            if pointer.is_null() {
                let _ = unsafe { GlobalFree(Some(global)) };
                return Err("锁定剪贴板写入内存失败".to_string());
            }
            unsafe { std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len()) };
            let _ = unsafe { GlobalUnlock(global) };
            if let Err(error) = unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0))) }
            {
                let _ = unsafe { GlobalFree(Some(global)) };
                return Err(format!("提交剪贴板数据失败: {error}"));
            }
            Ok(())
        })();
        let close_result =
            unsafe { CloseClipboard() }.map_err(|error| format!("关闭剪贴板失败: {error}"));
        result.and(close_result)
    }

    let previous = read_text()?;
    write_text(marker)?;
    let observed = read_text();
    let restore = write_text(&previous);
    restore?;
    if observed? != marker {
        return Err("系统剪贴板读写内容不一致".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn clipboard_roundtrip(_marker: &str) -> Result<(), String> {
    Err("native clipboard smoke 仅支持 Windows".to_string())
}
