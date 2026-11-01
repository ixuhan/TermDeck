@echo off
rem Rust unit + integration tests.
call "%~dp0_env.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0..\src-tauri"
cargo test %*
