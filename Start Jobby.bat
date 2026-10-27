@echo off
setlocal
rem Double-click to start Jobby and open the dashboard in its own window.
rem Keep this window open while you use the app; Ctrl+C stops the server.
rem
rem A dashboard in a browser cannot start a process on this machine, so keeping
rem the server alive is this script's job: if it stops unexpectedly it is started
rem again in this window instead of leaving a dead page behind.

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
  echo Jobby is already running at %URL%
  call :openwindow
  exit /b 0
)

rem Compile can build a real PDF with Tectonic. It is optional: fetch it once
rem into tools\tectonic, and carry on (in-app preview) if that is not possible.
%PY% install_tectonic.py --quiet
echo.
echo Starting Jobby...
echo.

rem The dashboard opens in its own window as soon as the server answers, in
rem the background, so this console can keep the server in the foreground. A
rem restart does not open a second one.
start "" /b wscript //nologo "%~dp0Jobby.vbs" /wait
set "QUICK=0"

:run
call :seconds
set "STARTED=%NOW%"
%PY% server.py
set "STATUS=%ERRORLEVEL%"
call :seconds
set "RAN=9999"
if defined STARTED if defined NOW set /a "RAN=NOW-STARTED"

rem A run that ends within seconds never really started, so count it and give up
rem after three: a stuck port should not spin this window forever.
set "QUICK_RUN=0"
if %RAN% geq 0 if %RAN% lss 5 set "QUICK_RUN=1"
if "%QUICK_RUN%"=="1" (set /a QUICK+=1) else (set QUICK=0)
if %QUICK% geq 3 goto :givingup

echo.
echo The server stopped ^(exit code %STATUS%^). Restarting it...
echo.
rem Give the port a moment to come back before binding it again.
timeout /t 1 /nobreak >nul
goto :run

:givingup
echo.
echo The server stopped three times within seconds of starting.
echo Something else may be using port 8787, or the database could not be opened.
echo The error above says which. To start it by hand, run: %PY% server.py

echo.
if not "%STATUS%"=="0" (
  echo The server stopped with an error ^(exit code %STATUS%^).
) else (
  echo Server stopped.
)
echo.
pause
exit /b %STATUS%

rem Seconds since midnight, for "did it run long enough to count as a start?".
rem The format follows this machine's locale, so a time this cannot read simply
rem means no guard: the loop still restarts the server.
:seconds
set "NOW="
for /f "tokens=1-3 delims=:.," %%a in ("%TIME: =0%") do set /a "NOW=(1%%a-100)*3600+(1%%b-100)*60+(1%%c-100)" 2>nul
goto :eof

rem The dashboard in its own window, through the same app script as Jobby.vbs.
:openwindow
start "" /b wscript //nologo "%~dp0Jobby.vbs" /wait
goto :eof
