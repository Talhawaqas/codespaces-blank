"""Builds the Power BI deliverables (SOW INAYA-BOS-POWERBI-SOW-2026-V1).

    python scripts/powerbi/build.py

  public/downloads/powerbi/Inaya.mez                      the Power Query custom connector (zip: Inaya.pq, icons, manifest)
  public/downloads/powerbi/Inaya-Starter-Reports.zip      the starter Power BI project (semantic model + report pages)

A .mez is a zip package; the Power Query SDK produces the same layout. No network access, no secrets.
"""
import io, os, zipfile
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "powerbi")
OUT = os.path.join(ROOT, "public", "downloads", "powerbi")
os.makedirs(OUT, exist_ok=True)

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="pq" ContentType="application/x-ms-m" /><Default Extension="m" ContentType="application/x-ms-m" /><Default Extension="png" ContentType="application/png" /><Default Extension="resx" ContentType="application/xml" /></Types>"""
RESX = """<?xml version="1.0" encoding="utf-8"?>
<root><resheader name="resmimetype"><value>text/microsoft-resx</value></resheader><resheader name="version"><value>2.0</value></resheader><resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader><resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader><data name="DataSourceLabel" xml:space="preserve"><value>Inaya Business OS</value></data></root>"""

def icon(size):
    im = Image.open(os.path.join(ROOT, "public", "inaya-logo.png")).convert("RGBA")
    im.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0)); canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    b = io.BytesIO(); canvas.save(b, "PNG"); return b.getvalue()

def build_mez():
    path = os.path.join(OUT, "Inaya.mez")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.write(os.path.join(SRC, "connector", "Inaya.pq"), "Inaya.m")  # the M document inside a .mez is <Name>.m (Power Query SDK layout)
        z.writestr("resources.resx", RESX)
        for s in (16, 20, 24, 32, 40, 48, 64): z.writestr(f"Inaya{s}.png", icon(s))
    print("built", path, os.path.getsize(path), "bytes")

def build_starter():
    base = os.path.join(SRC, "starter")
    if not os.path.isdir(base): print("no starter project yet"); return
    path = os.path.join(OUT, "Inaya-Starter-Reports.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(base):
            for f in files:
                full = os.path.join(dirpath, f); z.write(full, os.path.relpath(full, base))
    print("built", path, os.path.getsize(path), "bytes")

if __name__ == "__main__":
    build_mez(); build_starter()
