import { post } from '../api.js';
import { html, icon, $ } from '../ui.js';
import { languageSelect } from '../i18n.js';

const ERRORS = {
  state: 'La solicitud de Discord caducó o no es válida. Inténtalo de nuevo.',
  token: 'Discord rechazó el inicio de sesión. Revisa DISCORD_CLIENT_SECRET y la URL de redirección.',
  discord: 'No se pudo hablar con Discord. Inténtalo en unos segundos.',
  noguilds: 'Tu cuenta de Discord no administra ningún servidor donde esté el bot.',
  'oauth-off': 'El inicio de sesión con Discord no está configurado.',
};

export default {
  render({ view, query, state, onLogin }) {
    const s = state.session || {};
    view.innerHTML = String(html`
      <div class="login-card">
        <div class="login-language"></div>
        <img src="/img/logo.svg" alt="" width="48" height="48" />
        <h1>Panel de Engage</h1>
        <p class="muted" style="margin:0 0 20px">Controla las tareas de engagement de tus servidores de Discord.</p>
        ${query.error ? html`<div class="alert danger" style="margin-bottom:16px">${icon('alert')}<span>${ERRORS[query.error] || 'No se pudo iniciar sesión.'}</span></div>` : ''}
        ${s.demo ? html`<div class="alert info" style="margin-bottom:16px">${icon('flask')}<span>Modo demostración: la contraseña es <code>demo</code>.</span></div>` : ''}
        ${s.oauthEnabled
          ? html`<a class="btn discord block" href="/auth/discord">${icon('user')} Entrar con Discord</a><div class="divider">o con la contraseña de administrador</div>`
          : ''}
        <form id="login-form" class="stack" style="gap:12px">
          <div class="field">
            <label for="pw">Contraseña del panel</label>
            <input class="input" id="pw" name="password" type="password" autocomplete="current-password" required placeholder="••••••••" />
            <span class="hint">Está en <code>DASHBOARD_PASSWORD</code> (.env) o en <code>data/admin-password.txt</code>.</span>
          </div>
          <button class="btn primary block" type="submit">${icon('key')} Entrar</button>
          <p class="small muted" id="login-msg" role="alert" style="margin:0;min-height:20px"></p>
        </form>
        <p class="small muted" style="margin:14px 0 0">¿Primera vez? Lee la <a href="/docs/guia.html" target="_blank">guía de instalación</a>.</p>
      </div>`);
    view.querySelector('.login-language').innerHTML = languageSelect();
    const form = $('#login-form', view);
    const msg = $('#login-msg', view);
    $('#pw', view).focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      msg.textContent = '';
      try {
        await post('/login', { password: form.password.value });
        history.replaceState(null, '', '#/');
        await onLogin();
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = 'var(--danger)';
        form.password.select();
      } finally {
        btn.disabled = false;
      }
    });
  },
};
