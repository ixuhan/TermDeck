//! Read-only serial port enumeration for the sidebar list.
//!
//! Nothing here opens a port: `serialport::available_ports` walks the device
//! tree via SetupAPI and returns metadata only. Opening a port would toggle DTR
//! and reset most USB-serial adapters, which is exactly what a "just show me the
//! list" feature must not do.
//!
//! The friendly name is fetched separately through SetupAPI because
//! `serialport` only classifies ports as USB / PCI / Bluetooth / Unknown — a
//! Bluetooth COM port and a motherboard COM port both come back as `Unknown`,
//! which is useless in a list meant to resemble Device Manager.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PortEntry {
    /// `COM3` — what the user types in a terminal.
    pub name: String,
    /// `usb` | `pci` | `bluetooth` | `unknown`, used for the badge.
    pub kind: &'static str,
    /// Device Manager style description, e.g. `蓝牙链接上的标准串行 (COM3)`.
    pub label: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

/// Natural ordering so COM9 comes before COM10.
fn port_number(name: &str) -> u32 {
    name.trim_start_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .unwrap_or(u32::MAX)
}

/// Pulls `COM4` out of `蓝牙链接上的标准串行 (COM4)`.
fn com_from_friendly(name: &str) -> Option<String> {
    let start = name.rfind('(')?;
    let end = name.rfind(')')?;
    if end <= start + 1 {
        return None;
    }
    let inner = name[start + 1..end].trim();
    if inner.len() > 3 && inner[..3].eq_ignore_ascii_case("com") {
        Some(inner.to_string())
    } else {
        None
    }
}

/// `蓝牙链接上的标准串行 (COM4)` -> `蓝牙链接上的标准串行`, since the list already
/// shows the port name in its own column.
fn strip_port_suffix(name: &str) -> String {
    match name.rfind('(') {
        Some(i) if name.trim_end().ends_with(')') => name[..i].trim().to_string(),
        _ => name.trim().to_string(),
    }
}

/// Friendly names keyed by port name, straight from the Ports device class.
#[cfg(windows)]
fn friendly_names() -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceRegistryPropertyW, DIGCF_PRESENT, SP_DEVINFO_DATA, SPDRP_FRIENDLYNAME,
    };

    // {4D36E978-E325-11CE-BFC1-08002BE10318}
    const GUID_DEVCLASS_PORTS: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x4d36e978,
        data2: 0xe325,
        data3: 0x11ce,
        data4: [0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18],
    };

    let mut out = HashMap::new();
    unsafe {
        let set = SetupDiGetClassDevsW(
            &GUID_DEVCLASS_PORTS,
            std::ptr::null(),
            std::ptr::null_mut(),
            DIGCF_PRESENT,
        );
        // windows-sys 0.61 models HDEVINFO as isize; INVALID_HANDLE_VALUE is -1.
        if set == -1 {
            return out;
        }

        let mut index = 0u32;
        loop {
            let mut info: SP_DEVINFO_DATA = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
            if SetupDiEnumDeviceInfo(set, index, &mut info) == 0 {
                break;
            }
            index += 1;

            let mut buf = [0u16; 512];
            let mut kind = 0u32;
            let mut needed = 0u32;
            let ok = SetupDiGetDeviceRegistryPropertyW(
                set,
                &info,
                SPDRP_FRIENDLYNAME,
                &mut kind,
                buf.as_mut_ptr() as *mut u8,
                (buf.len() * 2) as u32,
                &mut needed,
            );
            if ok == 0 || needed == 0 {
                continue;
            }
            let len = (needed as usize / 2).saturating_sub(1).min(buf.len());
            let name = String::from_utf16_lossy(&buf[..len]);
            if let Some(port) = com_from_friendly(&name) {
                out.insert(port, name);
            }
        }
        SetupDiDestroyDeviceInfoList(set);
    }
    out
}

#[cfg(not(windows))]
fn friendly_names() -> std::collections::HashMap<String, String> {
    std::collections::HashMap::new()
}

fn classify(friendly: Option<&str>, fallback: &'static str) -> &'static str {
    let Some(name) = friendly else {
        return fallback;
    };
    let lower = name.to_lowercase();
    if name.contains("蓝牙") || lower.contains("bluetooth") {
        "bluetooth"
    } else if lower.contains("usb") {
        "usb"
    } else if name.contains("通信端口") || lower.contains("communications port") {
        // Motherboard / add-in card UART, shown as PCI in Device Manager's tree.
        "pci"
    } else {
        fallback
    }
}

pub fn list() -> Result<Vec<PortEntry>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let friendly = friendly_names();

    let mut entries: Vec<PortEntry> = ports
        .into_iter()
        .map(|p| {
            let base_kind = match &p.port_type {
                serialport::SerialPortType::UsbPort(_) => "usb",
                serialport::SerialPortType::PciPort => "pci",
                serialport::SerialPortType::BluetoothPort => "bluetooth",
                serialport::SerialPortType::Unknown => "unknown",
            };
            let (vid, pid) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => (Some(info.vid), Some(info.pid)),
                _ => (None, None),
            };

            let friendly_name = friendly.get(&p.port_name).cloned();
            let label = friendly_name
                .as_deref()
                .map(strip_port_suffix)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => info
                    .product
                    .clone()
                    .or_else(|| info.manufacturer.clone())
                    .unwrap_or_else(|| "USB 串口".to_string()),
                serialport::SerialPortType::PciPort => "主板串口".to_string(),
                serialport::SerialPortType::BluetoothPort => "蓝牙串口".to_string(),
                serialport::SerialPortType::Unknown => "串口".to_string(),
            });

            PortEntry {
                kind: classify(friendly_name.as_deref(), base_kind),
                name: p.port_name,
                label,
                vid,
                pid,
            }
        })
        .collect();

    entries.sort_by_key(|e| (port_number(&e.name), e.name.clone()));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_by_port_number_not_string() {
        let mut names = vec!["COM10", "COM9", "COM2"];
        names.sort_by_key(|n| port_number(n));
        assert_eq!(names, vec!["COM2", "COM9", "COM10"]);
    }

    #[test]
    fn extracts_port_from_friendly_name() {
        assert_eq!(
            com_from_friendly("蓝牙链接上的标准串行 (COM4)").as_deref(),
            Some("COM4")
        );
        assert_eq!(
            com_from_friendly("USB-SERIAL CH340 (COM12)").as_deref(),
            Some("COM12")
        );
        assert_eq!(com_from_friendly("通信端口 (COM1)").as_deref(), Some("COM1"));
        assert_eq!(com_from_friendly("no port here"), None);
        assert_eq!(com_from_friendly("weird (LPT1)"), None);
    }

    #[test]
    fn strips_port_suffix_for_display() {
        assert_eq!(strip_port_suffix("蓝牙链接上的标准串行 (COM4)"), "蓝牙链接上的标准串行");
        assert_eq!(strip_port_suffix("通信端口 (COM1)"), "通信端口");
        assert_eq!(strip_port_suffix("plain name"), "plain name");
    }

    #[test]
    fn classifies_bluetooth_and_usb() {
        assert_eq!(classify(Some("蓝牙链接上的标准串行 (COM4)"), "unknown"), "bluetooth");
        assert_eq!(classify(Some("USB-SERIAL CH340 (COM3)"), "unknown"), "usb");
        assert_eq!(classify(Some("通信端口 (COM1)"), "unknown"), "pci");
        assert_eq!(classify(None, "pci"), "pci");
    }
}
