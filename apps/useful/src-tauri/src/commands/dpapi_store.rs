//! Windows DPAPI 令牌存储：实现 useful-source-accounts::TokenStore。
//!
//! 令牌用 CryptProtectData（DPAPI，CRYPTPROTECT_LOCAL_MACHINE 关闭 = 绑定当前用户）
//! 加密后落盘到 data/credentials/<source_id>.<reference>.bin。SQLite 只存引用。
//! 非 Windows（测试/CI 交叉）退化为「拒绝明文落盘」的错误实现，强制走安全路径。

use std::path::{Path, PathBuf};
use useful_source_accounts::{AccountError, TokenBundle, TokenStore};

/// 基于 data 目录的 DPAPI 存储。
pub struct DpapiTokenStore {
    dir: PathBuf,
}

impl DpapiTokenStore {
    pub fn new(credentials_dir: &Path) -> DpapiTokenStore {
        DpapiTokenStore {
            dir: credentials_dir.to_path_buf(),
        }
    }

    /// 凭据文件名：source_id 与 reference 均做安全字符过滤（防路径穿越）。
    /// 仅保留字母数字与 - _；点等均转 _，避免出现 .. 序列。
    fn path_of(&self, source_id: &str, reference: &str) -> Result<PathBuf, AccountError> {
        let safe = |s: &str| -> String {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        };
        let name = format!("{}__{}.bin", safe(source_id), safe(reference));
        Ok(self.dir.join(name))
    }
}

impl TokenStore for DpapiTokenStore {
    fn save(
        &self,
        source_id: &str,
        reference: &str,
        tokens: &TokenBundle,
    ) -> Result<(), AccountError> {
        std::fs::create_dir_all(&self.dir).map_err(|e| AccountError::Store(e.to_string()))?;
        let plaintext =
            serde_json::to_vec(tokens).map_err(|e| AccountError::Store(e.to_string()))?;
        let sealed = protect(&plaintext)?;
        let path = self.path_of(source_id, reference)?;
        // 原子写入
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &sealed).map_err(|e| AccountError::Store(e.to_string()))?;
        std::fs::rename(&tmp, &path).map_err(|e| AccountError::Store(e.to_string()))?;
        Ok(())
    }

    fn load(&self, source_id: &str, reference: &str) -> Result<Option<TokenBundle>, AccountError> {
        let path = self.path_of(source_id, reference)?;
        let sealed = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AccountError::Store(e.to_string())),
        };
        let plaintext = unprotect(&sealed)?;
        let tokens: TokenBundle =
            serde_json::from_slice(&plaintext).map_err(|e| AccountError::Store(e.to_string()))?;
        Ok(Some(tokens))
    }

    fn delete(&self, source_id: &str, reference: &str) -> Result<(), AccountError> {
        let path = self.path_of(source_id, reference)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AccountError::Store(e.to_string())),
        }
    }
}

// ---------- DPAPI 绑定 ----------

#[cfg(windows)]
fn protect(plaintext: &[u8]) -> Result<Vec<u8>, AccountError> {
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&in_blob, None, None, None, None, 0, &mut out_blob)
            .map_err(|e| AccountError::Store(format!("CryptProtectData 失败: {e}")))?;
        let sealed = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        free_blob(&out_blob);
        Ok(sealed)
    }
}

#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, AccountError> {
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: sealed.len() as u32,
            pbData: sealed.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&in_blob, None, None, None, None, 0, &mut out_blob)
            .map_err(|e| AccountError::Store(format!("CryptUnprotectData 失败: {e}")))?;
        let plain = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        free_blob(&out_blob);
        Ok(plain)
    }
}

#[cfg(windows)]
unsafe fn free_blob(blob: &windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) {
    // windows-0.59 未导出 LocalFree
    extern "system" {
        fn LocalFree(hmem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }
    if !blob.pbData.is_null() {
        // 防御性：先清零缓冲（unprotect 时为明文），再释放
        std::ptr::write_bytes(blob.pbData, 0, blob.cbData as usize);
        LocalFree(blob.pbData as *mut core::ffi::c_void);
    }
}

// 非 Windows：不提供明文回退，强制安全路径（CI 交叉编译/单测覆盖逻辑分支）。
#[cfg(not(windows))]
fn protect(_plaintext: &[u8]) -> Result<Vec<u8>, AccountError> {
    Err(AccountError::Store(
        "当前平台无 DPAPI；令牌安全存储仅在 Windows 可用".into(),
    ))
}

#[cfg(not(windows))]
fn unprotect(_sealed: &[u8]) -> Result<Vec<u8>, AccountError> {
    Err(AccountError::Store(
        "当前平台无 DPAPI；令牌安全存储仅在 Windows 可用".into(),
    ))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip_and_cross_source_isolation() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DpapiTokenStore::new(tmp.path());
        let tokens = TokenBundle {
            access_token: "at-secret".into(),
            refresh_token: "rt-secret".into(),
            expires_at: 1_800_000_000,
        };
        store.save("com.a.src", "ref1", &tokens).unwrap();
        // 落盘文件为密文，不含明文令牌（文件名中的点已转 _）
        let raw = std::fs::read(tmp.path().join("com_a_src__ref1.bin")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("at-secret"));
        // 正确读回
        assert_eq!(store.load("com.a.src", "ref1").unwrap(), Some(tokens));
        // 跨源隔离：另一源读不到
        assert_eq!(store.load("com.b.src", "ref1").unwrap(), None);
        // 删除
        store.delete("com.a.src", "ref1").unwrap();
        assert_eq!(store.load("com.a.src", "ref1").unwrap(), None);
    }

    #[test]
    fn path_traversal_reference_sanitized() {
        let tmp = tempfile::tempdir().unwrap();
        let store = DpapiTokenStore::new(tmp.path());
        let p = store.path_of("../../evil", "../x").unwrap();
        assert!(p.starts_with(tmp.path()));
        assert!(!p.to_string_lossy().contains(".."));
    }
}
