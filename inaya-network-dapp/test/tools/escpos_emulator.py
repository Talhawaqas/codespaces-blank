# A minimal ESC/POS receipt-printer emulator for testing Inaya's desktop printing without hardware.
# Listens on 127.0.0.1:<port> like a LAN receipt printer (port 9100), decodes the job (text, bold, double size,
# centre/left, feed, cut, drawer pulse), renders the paper as a PNG and writes a JSON log of the events.
# Usage: python escpos_emulator.py <port> <out-prefix> <jobs>
import socket, sys, json
from PIL import Image, ImageDraw, ImageFont

port, prefix, jobs = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
def font(size, bold=False):
    for f in (["C:/Windows/Fonts/consolab.ttf"] if bold else []) + ["C:/Windows/Fonts/consola.ttf"]:
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()

def decode(data):
    lines, events, cur, style = [], [], "", {"bold": False, "double": False, "align": "left"}
    i = 0
    while i < len(data):
        b = data[i]
        if b == 0x1B:
            c = data[i + 1]
            if c == 0x40: events.append("init"); i += 2; continue
            if c == 0x61: style["align"] = {0: "left", 1: "center", 2: "right"}.get(data[i + 2], "left"); i += 3; continue
            if c == 0x45: style["bold"] = data[i + 2] == 1; i += 3; continue
            if c == 0x64: lines += [("", dict(style))] * data[i + 2]; i += 3; continue
            if c == 0x70: events.append({"drawer_pulse": {"pin": data[i + 2], "on_ms": data[i + 3] * 2, "off_ms": data[i + 4] * 2}}); i += 5; continue
            i += 2; continue
        if b == 0x1D:
            c = data[i + 1]
            if c == 0x21: style["double"] = data[i + 2] != 0; i += 3; continue
            if c == 0x56: events.append("cut"); i += 4; continue
            i += 2; continue
        if b == 0x0A: lines.append((cur, dict(style))); cur = ""; i += 1; continue
        cur += chr(b) if 0x20 <= b < 0x7F else "?"; i += 1
    return lines, events

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("127.0.0.1", port)); srv.listen(1)
print("ready", flush=True)
for n in range(jobs):
    conn, _ = srv.accept(); data = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk: break
        data += chunk
    conn.close()
    lines, events = decode(data)
    W = 560; img = Image.new("RGB", (W, 40 + 30 * len(lines)), "white"); d = ImageDraw.Draw(img); y = 20
    for text, st in lines:
        f = font(34 if st["double"] else 20, st["bold"]); w = d.textlength(text, font=f)
        x = (W - w) / 2 if st["align"] == "center" else 20
        d.text((x, y), text, fill="black", font=f); y += 44 if st["double"] else 26
    img = img.crop((0, 0, W, y + 20)); img.save(f"{prefix}-{n + 1}.png")
    json.dump({"bytes": len(data), "lines": len(lines), "events": events}, open(f"{prefix}-{n + 1}.json", "w"), indent=1)
    print("job", n + 1, len(data), "bytes", events, flush=True)
