# Actualización 1.1.0 · 16 de octubre de 2026

El código está actualizado en este proyecto. Para que aparezca en el servicio público hay que desplegarlo en Railway. Esta carpeta no tiene un repositorio Git ni una conexión de despliegue de Railway configurados, por lo que no se ha modificado el servicio de producción ni su configuración de Discord.

- El bot consulta las dos variantes del permiso Server Members para la aplicación autenticada. Distingue el estado del portal del de la sesión, reconecta al detectar la activación y permite comprobarlo desde Estado del bot. El panel muestra el ID de aplicación para evitar configurar otro bot por error.
- Comandos, mensajes, botones y formularios del bot en inglés. Se elimina `/panel` y los enlaces al dashboard de la ayuda y configuración. El panel permite cambiar entre español e inglés sin perder campos sin guardar.
- `/points` configura recompensas para posts nuevos. `/task create` permite `like-points`, `repost-points`, `reply-points`, `quote-points` y `bonus-points` para una publicación concreta. Sólo el personal autorizado puede configurarlas.
- La valoración automática de calidad pasa a ser orientativa: los comentarios breves o con emojis quedan pendientes del staff sin descuentos ni intentos consumidos. Se conservan autor, destino y protección contra copias. Las bases de datos anteriores recuperan el último rechazo automático por calidad de cada envío, sin modificar decisiones del staff.
- Registro con scroll, conservación de su posición y un máximo de 500 elementos en vivo. Panel de sistema adaptable y controles de móvil en una fila propia.
- HTTP 429 respeta `Retry-After`, pausa la fuente completa y permite usar las otras fuentes. Los estados distinguen pausa, disponibilidad de reintento, fallo temporal y fuente sin comprobar. Una respuesta vacía no se interpreta como prueba de que un post fue borrado.
- Se limitan las cachés de miembros de Discord; se liberan oyentes, temporizadores y conexiones lentas; se espera el trabajo pendiente antes de cerrar SQLite. Se corrigen carreras al crear tareas, subir capturas y cambiar páginas o servidores.

## Validación

- `npm test`: **78/78** pruebas correctas, incluidas recuperación del intent, migración de datos, permisos, calidad, concurrencia, sesiones y apagado.
- `npm run test:ui`: correcto en Edge; selector EN/ES, formularios conservados, 650 eventos y diseño de sistema a 1440, 1024, 768, 390 y 320 px.
- `npm run capturas`: **33 capturas** generadas; recorrido del panel y del bot sin errores de consola ni peticiones inesperadas fallidas.
- `npm run soak -- 120 120`: **34.080 interacciones**, cero fallos. Heap final 28,8 MB, estable en las últimas rondas. No se detectó fuga en esta carga.
- Verificación real de una respuesta pública de X: correcta, incluyendo rechazo de autor incorrecto y de un post que no responde a la tarea.
- En la batería completa contra servicios externos, el timeline de X devolvió 429 y una lectura del perfil `XDevelopers` mediante FxTwitter devolvió `NOT_FOUND` de forma intermitente. La disponibilidad de esas fuentes sigue dependiendo de sus servidores; el flujo de verificación real sí pasó.
- `npm audit --omit=dev`: cero vulnerabilidades conocidas en dependencias de producción.

## Despliegue

Sube el contenido de esta actualización al repositorio o servicio que utiliza Railway y redespliega conservando las variables y el volumen de datos existentes. No reemplaces el volumen con datos de demo. La migración se aplica una sola vez al arrancar.

Comprueba **v1.1.0** en Estado del bot y pulsa **Comprobar intent**. Los comandos se actualizan automáticamente al arrancar; también se puede forzar con `npm run comandos`. La actualización de comandos de Discord puede tardar en verse en clientes que los tengan en caché.
