@echo off
rem Starts TermDeck in dev mode (Vite + Tauri window).
call "%~dp0_env.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0.."
call npx tauri dev
