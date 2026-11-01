@echo off
rem ============================================================================
rem  Refuse to start a second build while another cargo owns the target dir.
rem
rem  cargo takes an exclusive lock on `target\.cargo-lock`. A second build does
rem  not fail - it prints "Blocking waiting for file lock on build directory"
rem  and sits there until the first one finishes. If the first one is a leftover
rem  process (or an editor's `cargo check`), that looks exactly like a hang.
rem
rem  ASCII only: cmd.exe reads .bat in the OEM codepage.
rem ============================================================================
tasklist /fi "imagename eq cargo.exe" 2>nul | find /i "cargo.exe" >nul
if errorlevel 1 exit /b 0

echo.
echo [termdeck] another cargo process is already running:
echo.
tasklist /fi "imagename eq cargo.exe" 2>nul | find /i "cargo.exe"
echo.
echo [termdeck] a second build would just wait for the file lock, so this one stops here.
echo [termdeck] wait for the running build, or kill it with:  scripts\kill-build.bat
echo.
exit /b 1
