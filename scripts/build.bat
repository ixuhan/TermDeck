@echo off
rem Production build.
rem   scripts\build.bat            -> release exe only (no installer)
rem   scripts\build.bat --bundle   -> release exe + NSIS installer
rem
rem Must go through the Tauri CLI (not plain `cargo build`): Tauri needs the
rem `custom-protocol` feature enabled, otherwise the binary keeps pointing at
rem devUrl (http://localhost:1420) and the window renders blank.
call "%~dp0_guard.bat"
if errorlevel 1 exit /b 1
call "%~dp0_env.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0.."

if "%~1"=="" (
  call npx tauri build --no-bundle
) else (
  call npx tauri build %*
)
