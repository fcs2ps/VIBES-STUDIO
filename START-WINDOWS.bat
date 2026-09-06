@echo off
title Vibes 3D Studio
cd /d "%~dp0"

echo.
echo   Starting Vibes 3D Studio...
echo.

rem Node: the bundled copy in a released zip, otherwise whatever is installed.
rem A developer checkout has no vendor\ and does not need one.
set "NODE=%~dp0vendor\node\node.exe"
if exist "%NODE%" goto :haveNode

where node >nul 2>nul
if not errorlevel 1 (
  set "NODE=node"
  goto :haveNode
)

echo   ------------------------------------------------------------
echo   Node.js is needed to run this.
echo   ------------------------------------------------------------
echo.
echo   Install it once from https://nodejs.org (the LTS button),
echo   then double-click this file again.
echo.
echo   If you unzipped a release and are seeing this, the zip was
echo   only partly unpacked - unzip the whole folder again.
echo.
pause
start "" https://nodejs.org/en/download
exit /b 1

:haveNode

rem First run in a fresh checkout: work out which slicer this machine quotes
rem with. If Bambu Studio is installed it takes a couple of seconds and nothing
rem is downloaded. Released zips already carry their answer and skip this.
if not exist "%~dp0vendor\MANIFEST.json" (
  echo   First run - finding the slicer on this machine.
  echo.
  "%NODE%" setup.js
  if errorlevel 1 (
    echo.
    echo   Setup could not find or configure a slicer. See the message above.
    echo.
    pause
    exit /b 1
  )
  echo.
)

"%NODE%" start.js

echo.
echo   The server has stopped.
pause
