@echo off
title De Dart Struners - Bord
cd /d "%~dp0"

set "NODEVER=v22.12.0"
set "NODEDIR=node-%NODEVER%-win-x64"
set "NODE=node"

where node >nul 2>&1
if errorlevel 1 goto eigennode
for /f "tokens=1 delims=." %%v in ('node -v') do set "NV=%%v"
if "%NV%"=="v14" goto eigennode
if "%NV%"=="v16" goto eigennode
goto start

:eigennode
if exist "%NODEDIR%\node.exe" goto heeftnode
if exist "node.zip" goto uitpakken
echo Node.js wordt eenmalig gedownload, even geduld...
curl -L --fail -o node.zip "https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip"
if errorlevel 1 goto fout
:uitpakken
echo Node.js wordt uitgepakt...
tar -xf node.zip
if not exist "%NODEDIR%\node.exe" powershell -NoProfile -Command "Expand-Archive -Force -Path 'node.zip' -DestinationPath '.'"
if not exist "%NODEDIR%\node.exe" goto foutuitpakken
del node.zip >nul 2>&1
:heeftnode
set "NODE=%NODEDIR%\node.exe"

:start
"%NODE%" bord.js %*
echo.
echo Het doorgeefprogramma is gestopt.
pause
exit /b

:foutuitpakken
echo.
echo Uitpakken van Node.js is mislukt. Mogelijk blokkeert de virusscanner dit.
echo Probeer START-BORD.bat nog een keer.
pause
exit /b

:fout
echo.
echo Downloaden is mislukt. Controleer je internetverbinding en probeer het opnieuw.
pause
