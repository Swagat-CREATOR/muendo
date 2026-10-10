#!/usr/bin/env bash
# Run a Windows program on this PC from WSL, from the repository root, with Windows Rust (GNU toolchain) on the PATH
# and Cargo's output on C: (building over the \\wsl.localhost share is slow). Give paths relative to the repository
# root: Windows programs see the root as their working folder (node --test can't take \\wsl.localhost paths).
#   scripts/windows.sh cargo test --manifest-path core/Cargo.toml
#   scripts/windows.sh node --test apps/desktop/test/core.test.js
# Needs, on Windows (see core/README.md): rustup with the x86_64-pc-windows-gnu toolchain, and GNU as + dlltool in
# %USERPROFILE%\.mewndo-dev\binutils (windows-sys links with raw-dylib, which needs both; Rust ships no as.exe).
set -euo pipefail
cd "$(dirname "$0")/.."
profile=$(cd /mnt/c && cmd.exe /c 'echo %USERPROFILE%' | tr -d '\r')
home=$(wslpath -u "$profile")
for need in "$home/.cargo/bin/cargo.exe" "$home/.mewndo-dev/binutils/as.exe"; do
  [ -e "$need" ] || { echo "missing $need: see core/README.md, \"Windows builds from WSL\"" >&2; exit 1; }
done

export CARGO_TARGET_DIR="$profile\\.mewndo-dev\\target"
export CARGO_INCREMENTAL=0 # incremental caches grew to gigabytes on a nearly full C:
export PATH="$home/.mewndo-dev/binutils:$home/.cargo/bin:$PATH"
export MEWNDO_CORE_BIN="$profile\\.mewndo-dev\\target\\debug\\mewndo-core.exe" # for the Node tests
export WSLENV="${WSLENV:+$WSLENV:}CARGO_TARGET_DIR:CARGO_INCREMENTAL:MEWNDO_CORE_BIN:PATH/l" # PATH/l: hand PATH to Windows, translated
program=$1
case $program in cargo|rustc|rustup) program="$home/.cargo/bin/$program.exe" ;; node) program="/mnt/c/Program Files/nodejs/node.exe" ;; esac
exec "$program" "${@:2}"
