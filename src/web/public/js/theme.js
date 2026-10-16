// Aplica el tema guardado antes de pintar la página (evita el parpadeo claro/oscuro).
(function () {
  try {
    var t = localStorage.getItem('engage-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* almacenamiento no disponible */
  }
})();
