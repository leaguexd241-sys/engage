@echo off
chcp 65001 >nul
title Bot de engage - DEMO
cd /d "%~dp0"
if not exist "node_modules" call npm install --omit=dev
echo  Modo demostracion: servidor de Discord y cuentas de X simulados.
echo  Abre http://localhost:3100  (contrasena: demo)
start "" http://localhost:3100
node src\index.js --demo
pause
