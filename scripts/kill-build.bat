@echo off
rem ============================================================================
rem  Kill leftover cargo / rustc processes that hold the target directory lock.
rem
rem  Use this after an interrupted build. Without it the next build just prints
rem  "Blocking waiting for file lock on build directory" and waits.
rem
rem  ASCII only: cmd.exe reads .bat in the OEM codepage.
rem ============================================================================
setlocal

echo [termdeck] current build processes:
tasklist /fi "imagename eq cargo.exe" 2>nul | find /i "cargo.exe"
tasklist /fi "imagename eq rustc.exe" 2>nul | find /i "rustc.exe"
echo.

taskkill /f /im rustc.exe >nul 2>&1
taskkill /f /im cargo.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [termdeck] after cleanup:
tasklist /fi "imagename eq cargo.exe" 2>nul | find /i "cargo.exe" || echo   no cargo process
tasklist /fi "imagename eq rustc.exe" 2>nul | find /i "rustc.exe" || echo   no rustc process

endlocal
