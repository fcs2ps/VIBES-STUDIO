@echo off
title Vibes 3D Studio
cd /d "%~dp0"

echo.
echo   Starting Vibes 3D Studio...
echo.

rem Prefer the Node bundled by setup.js. Once it is there, this folder runs
rem with nothing installed on the machine.
set "NODE=%~dp0vendor\node\node.exe"
if exist "%NODE%" goto :haveNode

where node >nul 2>nul
if not errorlevel 1 (
  set "NODE=node"
  goto :haveNode
)

echo   ------------------------------------------------------------
echo   Node.js is required for the first run.
echo   ------------------------------------------------------------
echo.
echo   Only the first run needs it. Setup copies Node into this
echo   folder, and after that the app carries its own.
echo.
echo   I'll open the download page for you now.
echo.
echo   1. Click the big "LTS" download button
echo   2. Run the installer, clicking Next through all the steps
echo   3. Come back here and double-click START-WINDOWS.bat again
echo.
pause
start "" https://nodejs.org/en/download
exit /b 1

:haveNode

rem First run: bundle Node and Bambu Studio into .\vendor so the folder becomes
rem self-contained. If it can't (no Bambu Studio to copy), setup says why and we
rem still start — the site, uploads and 3D viewer all work without a slicer.
if not exist "%~dp0vendor\MANIFEST.json" (
  echo   First run - setting up the folder's own copies of Node and
  echo   Bambu Studio. This takes about a minute, once.
  echo.
  "%NODE%" setup.js
  echo.
)

"%NODE%" start.js

echo.
echo   The server has stopped.
pause
