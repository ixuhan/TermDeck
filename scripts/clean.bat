@echo off
rem ============================================================================
rem  Clean build leftovers without throwing away compiled dependencies.
rem
rem    scripts\clean.bat          incremental cache + release staging only
rem    scripts\clean.bat --full   the whole target dir (recompiles everything)
rem
rem  What usually goes wrong: a build interrupted mid-write leaves the
rem  incremental cache in a state where cargo reports 'os error 5' or
rem  'cached cgu ... should have an object file, but doesn't'. Deleting
rem  target\release\incremental fixes it without touching compiled crates.
rem
rem  NOTE: do NOT delete target\release\deps\termdeck.* to "fix" a build error.
rem  That forces a full recompile of the app crate (several minutes).
rem
rem  ASCII only: cmd.exe reads .bat in the OEM codepage.
rem ============================================================================
setlocal
cd /d "%~dp0.."

echo [termdeck] [1/2] removing release staging
if exist release rmdir /s /q release
echo   done

if /i "%~1"=="--full" (
  echo [termdeck] [2/2] removing the whole target dir
  if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
  echo   done - next build recompiles every dependency
) else (
  echo [termdeck] [2/2] removing incremental caches
  if exist "src-tauri\target\release\incremental" rmdir /s /q "src-tauri\target\release\incremental"
  if exist "src-tauri\target\debug\incremental" rmdir /s /q "src-tauri\target\debug\incremental"
  echo   done - compiled dependencies are kept
)

echo.
echo [termdeck] done
endlocal
