// POS printing and cash drawer ("Route 3", post-Commerce-SOW, owner-approved 22 Nov 2026).
//
// The web till (inayanetwork.com, POS) builds ESC/POS bytes (src/lib/commerce/escpos.js) and hands them to these commands
// as base64. Nothing here interprets money or sales: it only moves bytes to a printer or a drawer trigger, so a failure can
// only mean "nothing printed / the drawer did not open" -- every drawer opening is logged by the web app, not here.
//
//   pos_list_printers      the computer's installed printers (Windows spooler / CUPS)
//   pos_print_raw          raw bytes to an installed printer (Windows: winspool RAW job; Linux: `lp -o raw`)
//   pos_print_network      raw bytes to a LAN receipt printer on TCP (port 9100) -- LOCAL NETWORK ADDRESSES ONLY
//   pos_list_serial_ports  COM ports (USB cash drawers and USB-to-RJ11 trigger boxes show up as serial ports)
//   pos_serial_write       raw bytes to a serial port (e.g. the drawer pulse)
//
// SECURITY: each command checks the calling window's origin (verify_trusted_origin in lib.rs), payloads are capped, and the
// network command refuses anything that is not a private/loopback/link-local address, so the website can never use the app
// as a bridge to the wider internet or to scan arbitrary hosts.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Write;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

const MAX_BYTES: usize = 256 * 1024;

fn decode(data_b64: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD.decode(data_b64.trim()).map_err(|_| "The print data is not valid.".to_string())?;
    if bytes.is_empty() { return Err("Nothing to print.".into()); }
    if bytes.len() > MAX_BYTES { return Err("The print job is too large.".into()); }
    Ok(bytes)
}

/// Private, loopback or link-local only (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10).
pub fn is_local_address(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

pub fn send_network(host: &str, port: u16, bytes: &[u8]) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() || host.len() > 253 { return Err("Enter the printer's address.".into()); }
    let port = if port == 0 { 9100 } else { port };
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().map_err(|_| format!("Couldn't find the printer at {}.", host))?.collect();
    let addr = addrs.into_iter().find(|a| is_local_address(&a.ip())).ok_or_else(|| "Only printers on your local network can be used.".to_string())?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("The printer didn't answer ({}).", e))?;
    s.set_write_timeout(Some(Duration::from_secs(10))).ok();
    s.write_all(bytes).map_err(|e| format!("Printing failed ({}).", e))?;
    s.flush().ok();
    Ok(())
}

#[cfg(target_os = "windows")]
mod spool {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W};
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    unsafe fn from_wide(p: *const u16) -> String { if p.is_null() { return String::new(); } let mut n = 0; while *p.add(n) != 0 { n += 1; } String::from_utf16_lossy(std::slice::from_raw_parts(p, n)) }
    pub fn list() -> Result<Vec<String>, String> {
        unsafe {
            let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS; let (mut needed, mut count) = (0u32, 0u32);
            EnumPrintersW(flags, std::ptr::null(), 4, std::ptr::null_mut(), 0, &mut needed, &mut count);
            if needed == 0 { return Ok(vec![]); }
            let mut buf = vec![0u8; needed as usize];
            if EnumPrintersW(flags, std::ptr::null(), 4, buf.as_mut_ptr(), needed, &mut needed, &mut count) == 0 { return Err("Couldn't list printers.".into()); }
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize);
            Ok(infos.iter().map(|i| from_wide(i.pPrinterName)).filter(|n| !n.is_empty()).collect())
        }
    }
    pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
        unsafe {
            let name = wide(printer); let mut h: HANDLE = std::ptr::null_mut();
            if OpenPrinterW(name.as_ptr(), &mut h, std::ptr::null()) == 0 { return Err(format!("Printer \"{}\" not found.", printer)); }
            let doc = wide("Inaya receipt"); let raw = wide("RAW");
            let info = DOC_INFO_1W { pDocName: doc.as_ptr() as *mut u16, pOutputFile: std::ptr::null_mut(), pDatatype: raw.as_ptr() as *mut u16 };
            let job = StartDocPrinterW(h, 1, &info);
            if job == 0 { ClosePrinter(h); return Err("The printer refused the job.".into()); }
            StartPagePrinter(h); let mut written = 0u32;
            let ok = WritePrinter(h, bytes.as_ptr() as *const _, bytes.len() as u32, &mut written);
            EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
            if ok == 0 || written as usize != bytes.len() { return Err("Printing failed part-way.".into()); }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod spool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    pub fn list() -> Result<Vec<String>, String> {
        let out = Command::new("lpstat").arg("-e").output().map_err(|_| "Printing (CUPS) isn't available on this computer.".to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
    }
    pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
        if printer.starts_with('-') || printer.contains(char::is_whitespace) { return Err("Choose a printer from the list.".into()); }
        let mut child = Command::new("lp").args(["-d", printer, "-o", "raw"]).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().map_err(|_| "Printing (CUPS) isn't available on this computer.".to_string())?;
        child.stdin.as_mut().ok_or("Printing failed.")?.write_all(bytes).map_err(|_| "Printing failed.".to_string())?;
        let st = child.wait().map_err(|_| "Printing failed.".to_string())?;
        if st.success() { Ok(()) } else { Err(format!("Printer \"{}\" refused the job.", printer)) }
    }
}

#[tauri::command]
pub fn pos_list_printers(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    crate::verify_trusted_origin(&window)?; spool::list()
}

#[tauri::command]
pub fn pos_print_raw(window: tauri::WebviewWindow, printer: String, data_b64: String) -> Result<(), String> {
    crate::verify_trusted_origin(&window)?; let bytes = decode(&data_b64)?;
    if printer.trim().is_empty() { return Err("Choose a receipt printer first.".into()); }
    spool::print_raw(printer.trim(), &bytes)
}

#[tauri::command]
pub fn pos_print_network(window: tauri::WebviewWindow, host: String, port: u16, data_b64: String) -> Result<(), String> {
    crate::verify_trusted_origin(&window)?; let bytes = decode(&data_b64)?; send_network(&host, port, &bytes)
}

#[tauri::command]
pub fn pos_list_serial_ports(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    crate::verify_trusted_origin(&window)?;
    serialport::available_ports().map(|v| v.into_iter().map(|p| p.port_name).collect()).map_err(|e| format!("Couldn't list ports ({}).", e))
}

#[tauri::command]
pub fn pos_serial_write(window: tauri::WebviewWindow, port: String, baud: u32, data_b64: String) -> Result<(), String> {
    crate::verify_trusted_origin(&window)?; let bytes = decode(&data_b64)?;
    let baud = if baud == 0 { 9600 } else { baud };
    let mut p = serialport::new(port.trim(), baud).timeout(Duration::from_secs(2)).open().map_err(|e| format!("Couldn't open {} ({}).", port, e))?;
    p.write_all(&bytes).map_err(|e| format!("Couldn't send to {} ({}).", port, e))?;
    p.flush().ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    #[test]
    fn only_local_addresses_are_allowed() {
        for ok in ["192.168.1.50", "10.0.0.9", "172.16.4.2", "127.0.0.1", "169.254.1.1", "::1"] { assert!(is_local_address(&ok.parse().unwrap()), "{}", ok); }
        for bad in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860::1"] { assert!(!is_local_address(&bad.parse().unwrap()), "{}", bad); }
        assert!(send_network("8.8.8.8", 9100, b"x").unwrap_err().contains("local network"));
    }
    #[test]
    fn network_print_delivers_the_exact_bytes() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap(); let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || { let (mut s, _) = l.accept().unwrap(); let mut v = vec![]; s.read_to_end(&mut v).unwrap(); v });
        let job = [0x1b, 0x40, b'H', b'i', 0x0a, 0x1d, 0x56, 0x42, 0x03, 0x1b, 0x70, 0x00, 0x19, 0xfa];
        send_network("127.0.0.1", port, &job).unwrap();
        assert_eq!(h.join().unwrap(), job.to_vec());
    }
    #[test]
    fn payload_checks() {
        assert!(decode("").is_err()); assert!(decode("not base64!").is_err());
        assert_eq!(decode("G3AAGfo=").unwrap(), vec![0x1b, 0x70, 0x00, 0x19, 0xfa]);
    }
}
