/**
 * Bootstrap: sessão, tema, pdf.js vendored e roteamento por papel
 * (discente → portal; comissao → painel).
 */

import { api, AuthError } from './api/client.js';
import { loadThemePreference, saveThemePreference } from './ui/theme.js';
import { initPortal } from './discente/portal.js';
import { initPainel } from './comissao/painel.js';

function init() {
  configurePdfWorker();
  initTheme();
  initLogin();
  initDevLogin();
  initLogout();
  bootstrapSessao();
}

function configurePdfWorker() {
  if (globalThis.pdfjsLib) {
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'vendor/pdfjs/pdf.worker.min.js';
  } else {
    console.warn('pdf.js não carregado. O upload de PDF não funcionará.');
  }
}

function initTheme() {
  applyTheme(loadThemePreference());
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-theme');
    const novo = atual === 'dark' ? 'light' : 'dark';
    applyTheme(novo);
    saveThemePreference(novo);
  });
}

function applyTheme(theme) {
  const html = document.documentElement;
  const icon = document.querySelector('#theme-toggle i');
  if (theme === 'dark') {
    html.setAttribute('data-theme', 'dark');
    icon?.classList.replace('bi-sun-fill', 'bi-moon-stars-fill');
  } else {
    html.removeAttribute('data-theme');
    icon?.classList.replace('bi-moon-stars-fill', 'bi-sun-fill');
  }
}

async function bootstrapSessao() {
  try {
    const user = await api('/api/auth/me');
    mostrarApp(user);
  } catch (err) {
    if (!(err instanceof AuthError)) console.error(err);
    mostrarLogin();
  }
}

const VIEWS = ['view-login', 'view-discente', 'view-comissao'];

function mostrarView(id) {
  VIEWS.forEach((v) => {
    const panel = document.getElementById(v);
    const ativo = v === id;
    // .tab-panel exige a classe .active para exibir (display:none no CSS);
    // o atributo hidden sozinho não basta.
    panel.hidden = !ativo;
    panel.classList.toggle('active', ativo);
  });
}

function mostrarLogin() {
  mostrarView('view-login');
  document.getElementById('logout-btn').hidden = true;
  document.getElementById('user-badge').hidden = true;
}

async function mostrarApp(user) {
  const badge = document.getElementById('user-badge');
  badge.textContent = `${user.nome || user.username} (${user.papel})`;
  badge.hidden = false;
  document.getElementById('logout-btn').hidden = false;

  if (user.papel === 'comissao') {
    mostrarView('view-comissao');
    await initPainel();
  } else {
    mostrarView('view-discente');
    await initPortal();
  }
}

function initLogin() {
  const form = document.getElementById('login-form');
  const erro = document.getElementById('login-erro');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    erro.hidden = true;
    try {
      const user = await api('/api/auth/login', {
        method: 'POST',
        body: {
          username: document.getElementById('login-username').value.trim(),
          senha: document.getElementById('login-senha').value,
        },
      });
      mostrarApp(user);
    } catch (err) {
      erro.textContent = err.message || 'Falha no login.';
      erro.hidden = false;
    }
  });
}

function initDevLogin() {
  // Atalhos de dev só aparecem com AUTH_PROVIDER=local.
  api('/api/auth/info')
    .then(({ provider }) => {
      if (provider !== 'local') return;
      const dev = document.getElementById('login-dev');
      dev.hidden = false;
      dev.querySelectorAll('[data-dev-login]').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.getElementById('login-username').value =
            btn.dataset.devLogin;
          document.getElementById('login-senha').value = btn.dataset.devSenha;
          document.getElementById('login-form').requestSubmit();
        });
      });
    })
    .catch(() => {});
}

function initLogout() {
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      location.reload();
    }
  });
}

init();
