@echo off
rem Sets up a complete MSVC + Windows SDK environment for Rust linking WITHOUT
rem running vcvars64.bat. vcvars shells out to reg.exe, which is blocked by the
rem host security policy, so the paths are resolved directly instead.
rem Intentionally no setlocal: the caller needs these variables to persist.

set "VS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
set "SDK=C:\Program Files (x86)\Windows Kits\10"

if not exist "%VS%\VC\Tools\MSVC" (
  echo [termdeck] MSVC toolset not found under "%VS%"
  exit /b 1
)

set "MSVCVER="
for /d %%D in ("%VS%\VC\Tools\MSVC\14.*") do set "MSVCVER=%%~nxD"

set "SDKVER="
for /d %%D in ("%SDK%\Lib\10.*") do set "SDKVER=%%~nxD"

if "%MSVCVER%"=="" (
  echo [termdeck] no MSVC 14.x toolset installed
  exit /b 1
)
if "%SDKVER%"=="" (
  echo [termdeck] no Windows 10/11 SDK installed
  exit /b 1
)

set "MSVCROOT=%VS%\VC\Tools\MSVC\%MSVCVER%"

set "PATH=%MSVCROOT%\bin\HostX64\x64;%SDK%\bin\%SDKVER%\x64;%PATH%"
set "INCLUDE=%MSVCROOT%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\um;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\winrt;%SDK%\Include\%SDKVER%\cppwinrt"
set "LIB=%MSVCROOT%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64"

rem Cache stays inside the workspace too (CI overrides this via env).
set "NPM_CONFIG_CACHE=%~dp0..\.cache\npm"

rem Workspace-local Rust toolchain: nothing is written to the user profile.
set "CARGO_HOME=%~dp0..\.toolchain\cargo"
set "RUSTUP_HOME=%~dp0..\.toolchain\rustup"
set "PATH=%CARGO_HOME%\bin;%PATH%"
