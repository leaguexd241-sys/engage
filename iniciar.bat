@echo off
chcp 65001 >nul
title Bot de engage
cd /d "%~dp0"
if not exist "node_modules" (
  echo  Primero ejecuta instalar.bat
  pause
  exit /b 1
)
echo  Iniciando el bot de engage... (cierra esta ventana o pulsa Ctrl+C para detenerlo)
:loop
node src\index.js
if errorlevel 1 (
  echo.
  echo  El bot se detuvo por un error. Se reiniciara en 10 segundos... ^(Ctrl+C para cancelar^)
  timeout /t 10 /nobreak >nul
  goto loop
)
pause
