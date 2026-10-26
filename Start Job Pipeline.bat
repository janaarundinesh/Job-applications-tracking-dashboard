@echo off
setlocal
rem Double-click to start Job Pipeline and open the dashboard.
rem Keep this window open while you use the app; Ctrl+C stops the server.

cd /d "%~dp0"
set "URL=http://127.0.0.1:8787"

rem Find a working Python: prefer the py launcher, then python, then python3.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  where python3 >nul 2>nul && set "PY=python3"
)

if defined PY (
  %PY% -c "import sys" >nul 2>nul
  if errorlevel 1 set "PY="
)

if not defined PY (
  echo Python was not found.
  echo Install Python 3.8 or newer from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup.
  echo.
  pause
  exit /b 1
)

rem Already running? Just open the dashboard.
%PY% -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen(sys.argv[1] + '/api/health', timeout=1.5).status == 200 else 1)" "%URL%" >nul 2>nul
if not errorlevel 1 (
  echo Job Pipeline is already running at %URL%
  start "" "%URL%"
  exit /b 0
)

rem Compile can build a real PDF with Tectonic. It is optional: fetch it once
rem into tools\tectonic, and carry on (in-app preview) if that is not possible.
%PY% install_tectonic.py --quiet
echo.
echo Starting Job Pipeline...
echo.
%PY% server.py --open
set "STATUS=%ERRORLEVEL%"

echo.
if not "%STATUS%"=="0" (
  echo The server stopped with an error ^(exit code %STATUS%^).
) else (
  echo Server stopped.
)
echo.
pause
exit /b %STATUS%
