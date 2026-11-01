@echo off
rem ============================================================================
rem  Build release artifacts.
rem
rem    scripts\release.bat              portable zip (offline, recommended)
rem    scripts\release.bat --installer  additionally try to build the NSIS setup
rem
rem  The installer needs tauri-bundler to download the NSIS toolchain, which is
rem  hosted on github.com. If github.com is unreachable the installer step fails
rem  - that is a network limitation, not a config problem. Use the portable zip,
rem  or build through GitHub Actions (see docs\RELEASE.md).
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM codepage and
rem  mangles UTF-8 comments.
rem ============================================================================
setlocal
call "%~dp0_guard.bat"
if errorlevel 1 exit /b 1
call "%~dp0_env.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0.."

node -p "require('./package.json').version" > "%TEMP%\termdeck-ver.txt" 2>nul
set /p VER=<"%TEMP%\termdeck-ver.txt"
del /q "%TEMP%\termdeck-ver.txt" 2>nul
if "%VER%"=="" set "VER=0.0.0"
echo [termdeck] version %VER%

echo.
echo [termdeck] [1/3] building release exe
call npx tauri build --no-bundle
if errorlevel 1 (
  echo [termdeck] build failed
  exit /b 1
)
if not exist "src-tauri\target\release\termdeck.exe" (
  echo [termdeck] exe not found after build
  exit /b 1
)

echo.
echo [termdeck] [2/3] staging portable folder
if exist release rmdir /s /q release
set "STAGE=release\TermDeck-%VER%-portable"
mkdir "%STAGE%"
copy /y "src-tauri\target\release\termdeck.exe" "%STAGE%\TermDeck.exe" >nul
copy /y "scripts\portable-readme.txt" "%STAGE%\README-portable.txt" >nul
copy /y "README.md" "%STAGE%\README.md" >nul
copy /y "LICENSE" "%STAGE%\LICENSE" >nul

echo.
echo [termdeck] [3/3] zipping
tar -a -c -f "release\TermDeck-%VER%-portable.zip" -C release "TermDeck-%VER%-portable"
if errorlevel 1 (
  echo [termdeck] zip failed
  exit /b 1
)

if /i "%~1"=="--installer" (
  echo.
  echo [termdeck] building NSIS installer ^(needs github.com access^)
  call npx tauri build
  if errorlevel 1 (
    echo.
    echo [termdeck] installer failed: NSIS toolchain download was blocked.
    echo             The portable zip is ready to use; see docs\RELEASE.md.
  )
)

echo.
echo ============================================================
echo  Artifacts:
dir /b release
echo ============================================================
endlocal
