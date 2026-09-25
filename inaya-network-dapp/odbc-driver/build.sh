#!/usr/bin/env bash
# Builds inayaodbc.dll with the MinGW-w64 GCC toolchain
# (BrechtSanders.WinLibs.POSIX.UCRT, installed via winget).
set -euo pipefail
cd "$(dirname "$0")"

GCC="/c/Users/waqastal/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin/x86_64-w64-mingw32-gcc.exe"

"$GCC" -shared -o inayaodbc.dll \
  src/driver.c src/json.c src/http.c \
  inayaodbc.def \
  -Wall -Wno-unused-parameter -O2 \
  -lwinhttp -lodbccp32 \
  -Wl,--out-implib,libinayaodbc.a

echo "Built odbc-driver/inayaodbc.dll"
