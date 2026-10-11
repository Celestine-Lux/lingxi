@echo off
rem ---------------------------------------------------------------------------
rem  Lingxi - local chat analysis tool launcher.
rem
rem  This file is intentionally ASCII-only: cmd.exe reads .bat files using the
rem  OEM codepage, so any Chinese text in here would be parsed as garbage
rem  commands. All user-facing text is printed by node (tools\launch.js).
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title Lingxi - Chat Lens
cd /d "%~dp0"

set "NODEEXE="
set "CAND="

rem --- 1) node.exe on PATH -----------------------------------------------------
where node.exe >nul 2>nul
if not errorlevel 1 set "NODEEXE=node.exe"

rem --- 2) common install locations --------------------------------------------
if defined NODEEXE goto RUN
set "CAND=%ProgramFiles%\nodejs\node.exe"
if exist "%CAND%" set "NODEEXE=%CAND%"
if defined NODEEXE goto RUN
set "CAND=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%CAND%" set "NODEEXE=%CAND%"
if defined NODEEXE goto RUN
set "CAND=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%CAND%" set "NODEEXE=%CAND%"
if defined NODEEXE goto RUN
set "CAND=%APPDATA%\npm\node.exe"
if exist "%CAND%" set "NODEEXE=%CAND%"
if defined NODEEXE goto RUN

rem --- 3) Node bundled with DeepSeek Harness ----------------------------------
set "CAND=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\node.exe"
if exist "%CAND%" set "NODEEXE=%CAND%"
if defined NODEEXE goto RUN

rem --- 4) manual override -----------------------------------------------------
if defined NODE_EXE set "CAND=%NODE_EXE%"
if defined NODE_EXE if exist "%CAND%" set "NODEEXE=%CAND%"
if defined NODEEXE goto RUN

goto NONODE

:RUN
"%NODEEXE%" "tools\launch.js" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
exit /b %CODE%

:NONODE
echo.
echo   [x] Node.js not found.
echo.
echo   This tool needs Node.js 18 or higher. It uses only built-in modules,
echo   so there is nothing to install with npm.
echo.
echo   Download the LTS build from https://nodejs.org , install it, then run
echo   this file again.
echo.
echo   If Node.js is installed in an unusual place, set the environment
echo   variable NODE_EXE to the full path of node.exe .
echo.
pause
exit /b 1
