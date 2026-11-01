@echo off
rem Launches the already-built binary.
set "DIR=%~dp0..\src-tauri\target"
set "EXE=%DIR%\release\termdeck.exe"
if not exist "%EXE%" set "EXE=%DIR%\debug\termdeck.exe"
if not exist "%EXE%" set "EXE=%DIR%\release\TermDeck.exe"
if not exist "%EXE%" (
  echo [termdeck] no build found - run scripts\build.bat build --release first
  exit /b 1
)
start "" "%EXE%"
