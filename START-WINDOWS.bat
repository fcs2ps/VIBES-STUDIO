@echo off
title Vibes 3D Studio
cd /d "%~dp0"

echo.
echo   Starting Vibes 3D Studio...
echo.

rem This folder carries its own Node and its own slicer. Nothing has to be
rem installed on the machine, and nothing is downloaded on first run.
set "NODE=%~dp0vendor\node\node.exe"
if exist "%NODE%" goto :haveNode

rem Only reached if vendor\ is missing - an incomplete unzip, or someone
rem deleted it. Fall back to an installed Node just so setup can repair it.
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE=node"
  goto :repair
)

echo   ------------------------------------------------------------
echo   This copy is incomplete.
echo   ------------------------------------------------------------
echo.
echo   vendor\node\node.exe is missing, so this folder cannot start.
echo   That normally means the zip was only partly unpacked.
echo.
echo   Unzip the whole folder again and run this from the unzipped
echo   copy - not from inside the .zip window.
echo.
pause
exit /b 1

:repair
echo   vendor\ is missing - rebuilding it. This needs internet access
echo   and takes a minute, once.
echo.
"%NODE%" setup.js
if errorlevel 1 (
  echo.
  echo   Setup could not repair this folder. Ask for a fresh zip.
  echo.
  pause
  exit /b 1
)
set "NODE=%~dp0vendor\node\node.exe"

:haveNode
"%NODE%" start.js

echo.
echo   The server has stopped.
pause
