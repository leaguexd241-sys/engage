// Interacción de la guía: copiar código, ampliar imágenes, índice activo, tema y menú móvil.
(function () {
  // Tema
  try {
    var saved = localStorage.getItem('engage-guide-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* sin almacenamiento */
  }
  document.addEventListener('DOMContentLoaded', function () {
    var themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        var cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        var next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try {
          localStorage.setItem('engage-guide-theme', next);
        } catch (e) {
          /* sin almacenamiento */
        }
      });
    }

    // Botón copiar en cada bloque de código
    document.querySelectorAll('pre').forEach(function (pre) {
      var b = document.createElement('button');
      b.className = 'copy';
      b.type = 'button';
      b.textContent = 'Copiar';
      b.addEventListener('click', function () {
        var text = pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText;
        var done = function () {
          b.textContent = '¡Copiado!';
          b.classList.add('done');
          setTimeout(function () {
            b.textContent = 'Copiar';
            b.classList.remove('done');
          }, 1600);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(text.trim()).then(done, function () {});
      });
      pre.appendChild(b);
    });

    // Ampliar imágenes
    document.querySelectorAll('figure img').forEach(function (img) {
      img.addEventListener('click', function () {
        var box = document.createElement('div');
        box.className = 'lightbox';
        var big = document.createElement('img');
        big.src = img.src;
        big.alt = img.alt;
        box.appendChild(big);
        box.addEventListener('click', function () {
          box.remove();
        });
        document.addEventListener(
          'keydown',
          function esc(e) {
            if (e.key === 'Escape') {
              box.remove();
              document.removeEventListener('keydown', esc);
            }
          },
          { once: false },
        );
        document.body.appendChild(box);
      });
    });

    // Menú en móvil
    var toggle = document.getElementById('menu-toggle');
    var toc = document.querySelector('.toc');
    if (toggle && toc) {
      toggle.addEventListener('click', function () {
        toc.classList.toggle('open');
      });
      toc.querySelectorAll('nav a').forEach(function (a) {
        a.addEventListener('click', function () {
          toc.classList.remove('open');
        });
      });
    }

    // Índice: resalta la sección visible
    var links = {};
    document.querySelectorAll('.toc nav a[href^="#"]').forEach(function (a) {
      links[a.getAttribute('href').slice(1)] = a;
    });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting && links[en.target.id]) {
              Object.keys(links).forEach(function (k) {
                links[k].classList.remove('active');
              });
              links[en.target.id].classList.add('active');
            }
          });
        },
        { rootMargin: '-10% 0px -80% 0px' },
      );
      document.querySelectorAll('main section[id]').forEach(function (s) {
        io.observe(s);
      });
    }
  });
})();
