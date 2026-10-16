@echo off
chcp 65001 >nul
title Bot de engage - Instalacion
cd /d "%~dp0"
echo.
echo  ==============================================
echo    Bot de engage - Instalacion
echo  ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] No se encontro Node.js. Instalalo desde https://nodejs.org ^(version 22.13 o superior, recomendado 24 LTS^)
  echo      y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
echo  Node.js encontrado:
node -v
echo.
echo  Instalando dependencias (puede tardar un minuto)...
call npm install --omit=dev
if errorlevel 1 (
  echo  [X] Fallo la instalacion de dependencias. Revisa tu conexion a Internet.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo  Se creo el archivo .env. Abrelo con el Bloc de notas y pega tu DISCORD_TOKEN.
  start notepad ".env"
)
echo.
echo  Comprobando la configuracion...
call npm run doctor
echo.
echo  Listo. Cuando tengas el token en .env, ejecuta iniciar.bat
echo  Para probarlo sin Discord: demo.bat
pause
