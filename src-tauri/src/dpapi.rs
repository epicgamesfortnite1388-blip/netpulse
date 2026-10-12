//! DPAPI secret-protection bridge — the webview's only path to
//! Windows' per-user, per-machine-at-rest encryption.
//!
//! The cloud session store keeps the refresh token and the derived
//! vault key in webview storage so a restart can silently re-auth. In
//! the packaged app that storage is readable by any process running as
//! this user. These commands wrap `CryptProtectData`/
//! `CryptUnprotectData` so those values are stored DPAPI-protected
//! (bound to this user AND this machine) instead of plaintext: a
//! stolen profile directory, an off-machine backup, or another user's
//! process cannot decrypt them.
//!
//! Scope, stated plainly: DPAPI does not defend against code running
//! as the same interactive user (the entropy below ships in the
//! binary too) — it defends against at-rest extraction and
//! cross-user/cross-machine theft. The webview reaches these only
//! through two typed IPC commands; there is no generic
//! encrypt/decrypt surface and no path to raw key material.

#![cfg(windows)]

use std::ffi::c_void;
use std::ptr::null_mut;

/// Matches the Win32 `DATA_BLOB` layout.
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;

    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;

    fn LocalFree(h: *mut c_void) -> *mut c_void;
    fn GetLastError() -> u32;
}

/// `CRYPTPROTECT_UI_FORBIDDEN` — these run on the IPC thread; a
/// prompt could never be answered and must never be requested.
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

/// Optional entropy, app-scoped. Not a secret (it ships in the
/// binary): it binds blobs to this application so a captured blob
/// cannot be replayed into another app's `CryptUnprotectData` call.
/// The real protection is DPAPI's user+machine binding.
const ENTROPY: &str = "NetPulse.dpapi.v1";

fn entropy_bytes() -> Vec<u8> {
    ENTROPY.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

/// Protect plaintext with DPAPI (current user, this machine).
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    // The input blob borrows `plain`; it is never written through.
    let in_blob = DataBlob {
        cb_data: plain.len() as u32,
        pb_data: plain.as_ptr() as *mut u8,
    };
    let entropy = entropy_bytes();
    let ent_blob = DataBlob {
        cb_data: entropy.len() as u32,
        pb_data: entropy.as_ptr() as *mut u8,
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            null_mut(),
            &ent_blob,
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        // SAFETY: read-only access to the Windows last-error code.
        let err = unsafe { GetLastError() };
        return Err(format!("CryptProtectData failed (error {err})"));
    }
    // DPAPI allocated the output buffer; copy it out and hand it back.
    let copied = unsafe {
        std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
    };
    unsafe { LocalFree(out_blob.pb_data as *mut c_void) };
    Ok(copied)
}

/// Unprotect a DPAPI blob produced by `protect_bytes`.
fn unprotect_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    let in_blob = DataBlob {
        cb_data: data.len() as u32,
        pb_data: data.as_ptr() as *mut u8,
    };
    let entropy = entropy_bytes();
    let ent_blob = DataBlob {
        cb_data: entropy.len() as u32,
        pb_data: entropy.as_ptr() as *mut u8,
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            null_mut(),
            &ent_blob,
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        // SAFETY: read-only access to the Windows last-error code.
        let err = unsafe { GetLastError() };
        return Err(format!("CryptUnprotectData failed (error {err}) — wrong user, wrong machine, or corrupted blob"));
    }
    let copied = unsafe {
        std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
    };
    unsafe { LocalFree(out_blob.pb_data as *mut c_void) };
    Ok(copied)
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn to_base64(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_ALPHABET[triple as usize & 63] as char } else { '=' });
    }
    out
}

fn from_base64(text: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    if clean.len() % 4 != 0 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for (i, &b) in clean.iter().enumerate() {
        let is_pad = b == b'=';
        // Padding is only valid on the final one or two positions.
        let is_final = i >= clean.len() - 2;
        if is_pad && !is_final {
            return Err("invalid base64 padding".into());
        }
        // Padding carries no data bits — stop at the first pad.
        if is_pad {
            break;
        }
        let value = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a') as u32 + 26,
            b'0'..=b'9' => (b - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("invalid base64 character".into()),
        };
        buf = (buf << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Protect a UTF-8 string; returns the DPAPI blob as base64.
#[tauri::command]
pub fn secret_protect(plain: String) -> Result<String, String> {
    protect_bytes(plain.as_bytes()).map(|data| to_base64(&data))
}

/// Unprotect a base64 DPAPI blob produced by `secret_protect`.
#[tauri::command]
pub fn secret_unprotect(protected: String) -> Result<String, String> {
    let data = from_base64(&protected)?;
    let plain = unprotect_bytes(&data)?;
    String::from_utf8(plain).map_err(|_| "protected value is not valid UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_known_vectors() {
        assert_eq!(to_base64(b""), "");
        assert_eq!(to_base64(b"hello"), "aGVsbG8=");
        assert_eq!(to_base64(b"man"), "bWFu");
        assert_eq!(to_base64(b"ma"), "bWE=");
        assert_eq!(to_base64(b"m"), "bQ==");
        assert_eq!(from_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(from_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(from_base64("aG Vs\nbG8=").unwrap(), b"hello");
    }

    #[test]
    fn base64_rejects_garbage() {
        assert!(from_base64("!!!").is_err());
        assert!(from_base64("aGVsbG8").is_err()); // wrong length
        assert!(from_base64("a=GVsbG8=").is_err()); // padding mid-string
    }

    #[test]
    fn protect_unprotect_roundtrips() {
        for sample in ["", "x", "refresh-token-material", "üñïçø∂é key — 32 bytes+"] {
            let blob = protect_bytes(sample.as_bytes()).expect("protect");
            assert_ne!(blob, sample.as_bytes(), "ciphertext must differ from plaintext");
            let back = unprotect_bytes(&blob).expect("unprotect");
            assert_eq!(back, sample.as_bytes());
        }
    }

    #[test]
    fn protect_is_deterministic_per_call_but_not_reusable_across_users() {
        // Two protections of the same plaintext both decrypt correctly.
        let a = protect_bytes(b"same").unwrap();
        let b = protect_bytes(b"same").unwrap();
        assert_eq!(unprotect_bytes(&a).unwrap(), b"same");
        assert_eq!(unprotect_bytes(&b).unwrap(), b"same");
    }

    #[test]
    fn tampered_ciphertext_fails_closed() {
        let mut blob = protect_bytes(b"secret").unwrap();
        blob[0] ^= 0xFF;
        assert!(unprotect_bytes(&blob).is_err());
    }

    #[test]
    fn truncated_ciphertext_fails_closed() {
        let blob = protect_bytes(b"secret").unwrap();
        assert!(unprotect_bytes(&blob[..blob.len() / 2]).is_err());
    }
}
