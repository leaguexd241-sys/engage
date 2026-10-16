# Bot de Engage para Discord (X / Twitter sin API)

Bot de *engagement* para Discord: publica tareas para apoyar posts de X (like, repost, comentario y cita), tus miembros las hacen **de verdad en su propia cuenta de X** y el bot **comprueba quién las hizo y quién no**, sin usar la API oficial de X. Incluye un **panel web profesional** para controlarlo todo desde tus servidores.

➡️ **Guía completa con imágenes:** abre [`docs/guia.html`](docs/guia.html) en el navegador (o `http://localhost:3000/guia` con el bot encendido).

El bot usa comandos y mensajes en **inglés**. El panel permite elegir **Español / English** y recuerda el idioma sin perder formularios sin guardar. El acceso al panel se hace desde tu dominio de Railway; el bot no tiene comando ni botones para abrirlo.

Para configurar recompensas: `/points like:2 repost:3 reply:5 quote:5 bonus:3` cambia los valores para posts futuros (sólo administradores). Para un post concreto: `/task create url:https://x.com/…/status/… reply-points:10 bonus-points:5`. Se admiten valores de 0 a 1000; los puntos individuales y `multiplier` son alternativas.

Los comentarios que reciben una valoración baja, incluidos los que sólo contienen emojis, se envían a **revisión del staff**. La valoración automática no descuenta puntos, confianza ni intentos. El miembro puede presentar una versión revisada con `/verify task:1 reply:https://x.com/…/status/…`.

Al actualizar una base de datos anterior, los rechazos automáticos por calidad que seguían vigentes pasan a revisión. Se revierte la penalización del último rechazo registrado en cada envío; las decisiones del staff se respetan.

El estado de Server Members se consulta para la aplicación del bot conectado. Si lo activas después de arrancar, el bot reconecta automáticamente en la siguiente comprobación (cada minuto); también puedes usar **Estado del bot › Comprobar intent**. Una respuesta HTTP 429 de X pausa esa fuente respetando `Retry-After`, permite usar las otras fuentes y muestra cuándo se pueden reanudar los intentos.

## Inicio rápido (Windows)

1. Instala **Node.js 24 LTS** (mínimo 22.13) desde <https://nodejs.org>.
2. Haz doble clic en **`instalar.bat`** → instala todo y abre el archivo `.env`.
3. Pega tu `DISCORD_TOKEN` en `.env` (ver la guía: “Crear el bot en Discord”).
4. Doble clic en **`iniciar.bat`** → el bot arranca y se reinicia solo si algo falla.
5. Abre el panel: <http://localhost:3000> (la contraseña está en `data/admin-password.txt`).

¿Quieres verlo funcionando sin Discord? Doble clic en **`demo.bat`** (contraseña `demo`).

## Subirlo a Internet (Railway)

GitHub Pages sólo publica páginas estáticas (la guía), **no puede ejecutar el bot**. Para tenerlo 24/7 sin tu PC:

1. Sube el proyecto a un repositorio **privado** de GitHub (`.env` y `data/` ya están excluidos).
2. En Railway: *New Project › Deploy from GitHub repo*.
3. Variables: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DASHBOARD_PASSWORD` (no pongas `PORT` ni `PUBLIC_URL`: se detectan solos).
4. Añade un **volumen** montado en `/data` (si no, los datos se borran en cada despliegue).
5. *Settings › Networking › Generate Domain* → ese es tu panel; la guía queda en `/guia`.

Pasos detallados, alternativa con Railway CLI y cómo publicar la guía en GitHub Pages: sección 14 de la guía.

## Comandos de terminal

| Comando | Qué hace |
|---|---|
| `npm install` | Instala las dependencias |
| `npm start` | Arranca el bot y el panel web |
| `npm run demo` | Modo demostración con Discord y X simulados (panel en el puerto 3100) |
| `npm run doctor` | Diagnóstico: token, intents, servidores, acceso a X, puerto… |
| `npm run comandos` | Fuerza el registro de los comandos de barra en Discord |
| `npm test` | Pruebas automáticas del núcleo, Discord, panel, intent y regresiones |
| `npm run test:live` | Pruebas contra X real (verifica una respuesta pública real) |
| `npm run test:ui` | Navegador real: EN/ES, formularios, scroll, eventos en vivo y diseño móvil |
| `npm run soak` | Prueba de resistencia y fugas de memoria (miles de interacciones) |
| `npm run capturas` | Recorrido visual automático del panel y del simulador (genera `docs/img`) |

## Cómo verifica sin la API de X

| Acción | Cómo se comprueba | Fiabilidad |
|---|---|---|
| 💬 Comentario / 🗨️ Cita | Se comprueban autor, destino y antiplagio; la valoración de calidad es orientativa y los casos bajos van al staff. Al cerrar se comprueba que el post siga disponible | Alta (comprobado) |
| 🔁 Repost | Se busca en el perfil público del miembro; si no aparece, se aplica el modo de prueba del servidor | Alta si aparece |
| ❤️ Like | X hizo los likes privados en 2024: declaración, captura o revisión del staff (configurable) + auditoría del contador público del post | Media (con auditoría) |
| 🔗 Cuenta de X | El miembro demuestra que es suya con un código temporal en su biografía o en un post | Alta |

Fuentes públicas usadas: `api.fxtwitter.com` y `cdn.syndication.twimg.com` (el endpoint de los embeds de X), con respaldo automático entre ellas, caché y pausa ante límites.

## Estructura

```
src/
  core/       lógica: tareas, verificación, calidad, antiplagio, confianza, planificador
  discord/    comandos, botones, formularios, mensajes y conexión con discord.js
  twitter/    lectura de X sin API (fxtwitter, syndication) + X simulado
  web/        panel web (API + interfaz)
  sim/        Discord simulado (demo y pruebas visuales)
tests/        pruebas automáticas
scripts/      doctor, registro de comandos, prueba de memoria, capturas
docs/         guía HTML e imágenes
data/         base de datos SQLite, capturas y registros (se crea sola)
```
