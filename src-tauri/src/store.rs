//! Settings and session files in the app's config folder. The frontend owns
//! their schema; this module only stores JSON objects safely.

use std::fs;
use std::path::Path;

use serde_json::Value;

const MAX_STORE_BYTES: usize = 512 * 1024;

/// Reads a JSON object. Missing or unreadable files yield `None` so the app
/// starts with defaults; a corrupt file is kept aside as `<name>.bad`.
pub fn read(dir: &Path, name: &str) -> Option<Value> {
    let path = dir.join(name);
    let bytes = fs::read(&path).ok()?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) if v.is_object() => Some(v),
        _ => {
            let _ = fs::rename(&path, dir.join(format!("{name}.bad")));
            None
        }
    }
}

/// Writes a JSON object atomically.
pub fn write(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("not an object".into());
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("too large".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    psymd_core::save::save(&dir.join(name), &bytes, None, true)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let v = json!({"theme": "latte", "zoom": 1.1});
        write(d.path(), "settings.json", &v).unwrap();
        assert_eq!(read(d.path(), "settings.json"), Some(v));
    }

    #[test]
    fn missing_file_is_none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read(d.path(), "settings.json"), None);
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("settings.json"), b"{ not json").unwrap();
        assert_eq!(read(d.path(), "settings.json"), None);
        assert!(d.path().join("settings.json.bad").exists());
    }

    #[test]
    fn non_object_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        assert!(write(d.path(), "s.json", &json!([1, 2])).is_err());
        fs::write(d.path().join("t.json"), b"[1]").unwrap();
        assert_eq!(read(d.path(), "t.json"), None);
    }

    #[test]
    fn creates_missing_folder() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("a/b");
        write(&sub, "s.json", &json!({})).unwrap();
        assert!(sub.join("s.json").exists());
    }
}
