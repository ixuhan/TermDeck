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

rem Bundling with createUpdaterArtifacts enabled requires the update signing
rem key. Use the local one when present so --bundles works out of the box;
rem CI provides its own copy through the TAURI_SIGNING_PRIVATE_KEY secret.
if not defined TAURI_SIGNING_PRIVATE_KEY if exist "%~dp0..\.cache\updater\termdeck.key" (
  set "TAURI_SIGNING_PRIVATE_KEY=%~dp0..\.cache\updater\termdeck.key"
  echo [termdeck] signing updates with .cache\updater\termdeck.key
)
cd /d "%~dp0.."

if "%~1"=="" (
  call npx tauri build --no-bundle
) else (
  call npx tauri build %*
)
