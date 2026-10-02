/**
 * Bootstrap: sessão, tema, pdf.js vendored e roteamento SPA.
 *
 * Rotas:
 *   /login              -> tela de acesso
 *   /aluno  (/portal)   -> fluxo do discente
 *   /admin/*            -> painel da comissão (dashboard, fila, mesa, autorizações)
 */

import { api, AuthError } from './api/client.js';
import { loadThemePreference, saveThemePreference } from './ui/theme.js';
import { initPortal } from './discente/portal.js';
import { initPainel } from './comissao/painel.js';
import { registerRouteResolver } from './router.js';

const ROTAS_PUBLICAS = ['/login', '/'];

function init() {
  configurePdfWorker();
  initTheme();
  initLogin();
  initDevLogin();
  initLogout();
  initSobreModal();
  initArquiteturaModal();
  initNavegacaoSPA();
  bootstrapSessao();
}

function initSobreModal() {
  const modal = document.getElementById('modal-sobre');
  const btn = document.getElementById('btn-sobre');
  const fechar = document.getElementById('modal-sobre-fechar');
  const ok = document.getElementById('modal-sobre-ok');
  if (!modal) return;
  const abrir = () => modal.showModal();
  const fecharFn = () => modal.close();
  btn?.addEventListener('click', abrir);
  fechar?.addEventListener('click', fecharFn);
  ok?.addEventListener('click', fecharFn);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) fecharFn();
  });
}

function initArquiteturaModal() {
  const modal = document.getElementById('modal-arquitetura');
  const btn = document.getElementById('btn-arquitetura');
  const fechar = document.getElementById('modal-arquitetura-fechar');
  const ok = document.getElementById('modal-arquitetura-ok');
  if (!modal) return;
  const abrir = () => modal.showModal();
  const fecharFn = () => modal.close();
  btn?.addEventListener('click', abrir);
  fechar?.addEventListener('click', fecharFn);
  ok?.addEventListener('click', fecharFn);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) fecharFn();
  });
}

function configurePdfWorker() {
  if (globalThis.pdfjsLib) {
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'vendor/pdfjs/pdf.worker.min.js';
    // Desativa a execução de JavaScript embutido em PDFs (hardening).
    globalThis.pdfjsLib.disableAutoFetch = true;
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
    await mostrarApp(user, false);
  } catch (err) {
    if (!(err instanceof AuthError)) console.error(err);
    mostrarLogin();
  }
}

const VIEWS = [
  'view-login',
  'view-discente',
  'view-admin-dashboard',
  'view-admin-fila',
  'view-admin-mesa',
  'view-admin-autorizacoes',
];

function mostrarView(id) {
  VIEWS.forEach((v) => {
    const panel = document.getElementById(v);
    if (!panel) return;
    const ativo = v === id;
    panel.hidden = !ativo;
    panel.classList.toggle('active', ativo);
  });
}

function rotaAtual() {
  return window.location.pathname || '/';
}

function mostrarLogin() {
  mostrarView('view-login');
  document.getElementById('logout-btn').hidden = true;
  document.getElementById('user-badge').hidden = true;
  const headerNav = document.getElementById('header-nav');
  if (headerNav) {
    headerNav.hidden = true;
    headerNav.style.display = 'none';
  }
  history.replaceState({ view: 'login' }, '', '/login');
}

async function mostrarApp(user, pushState = true) {
  const badge = document.getElementById('user-badge');
  badge.textContent = `${user.nome || user.username} (${user.papel})`;
  badge.hidden = false;
  document.getElementById('logout-btn').hidden = false;

  const headerNav = document.getElementById('header-nav');
  if (headerNav) {
    const visivel = user.papel === 'comissao';
    headerNav.hidden = !visivel;
    headerNav.style.display = visivel ? 'flex' : 'none';
  }

  const homeLink = document.getElementById('header-home-link');
  if (homeLink) {
    homeLink.href = user.papel === 'comissao' ? '/admin/dashboard' : '/aluno';
  }

  const caminho = rotaAtual();
  if (user.papel === 'comissao') {
    if (caminho.startsWith('/admin')) {
      const view = caminho === '/admin/fila' ? 'view-admin-fila'
        : caminho === '/admin/mesa' ? 'view-admin-mesa'
        : caminho === '/admin/autorizacoes' ? 'view-admin-autorizacoes'
        : 'view-admin-dashboard';
      mostrarView(view);
      await initPainel(view);
      if (pushState) history.pushState({ view }, '', caminho);
    } else {
      mostrarView('view-admin-dashboard');
      await initPainel('view-admin-dashboard');
      if (pushState) history.pushState({ view: 'view-admin-dashboard' }, '', '/admin/dashboard');
    }
  } else {
    if (caminho === '/aluno' || caminho === '/portal') {
      mostrarView('view-discente');
      await initPortal();
      if (pushState) history.pushState({ view: 'view-discente' }, '', caminho);
    } else {
      mostrarView('view-discente');
      await initPortal();
      if (pushState) history.pushState({ view: 'view-discente' }, '', '/aluno');
    }
  }
}

function initNavegacaoSPA() {
  registerRouteResolver(aplicarRota);
  document.body.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-spa]');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    history.pushState({ view: href }, '', href);
    aplicarRota(href);
  });

  window.addEventListener('popstate', () => {
    aplicarRota(rotaAtual());
  });
}

async function aplicarRota(caminho) {
  const pathname = String(caminho).split('?')[0];
  if (ROTAS_PUBLICAS.includes(pathname)) {
    mostrarLogin();
    return;
  }
  try {
    const user = await api('/api/auth/me');
    if (pathname === '/aluno' || pathname === '/portal') {
      mostrarView('view-discente');
      await initPortal();
      return;
    }
    if (pathname.startsWith('/admin') && user.papel === 'comissao') {
      const view = pathname === '/admin/fila' ? 'view-admin-fila'
        : pathname === '/admin/mesa' ? 'view-admin-mesa'
        : pathname === '/admin/autorizacoes' ? 'view-admin-autorizacoes'
        : 'view-admin-dashboard';
      mostrarView(view);
      await initPainel(view);
      return;
    }
    if (user.papel === 'comissao') {
      history.replaceState({ view: 'view-admin-dashboard' }, '', '/admin/dashboard');
      mostrarView('view-admin-dashboard');
      await initPainel('view-admin-dashboard');
    } else {
      history.replaceState({ view: 'view-discente' }, '', '/aluno');
      mostrarView('view-discente');
      await initPortal();
    }
  } catch (err) {
    if (!(err instanceof AuthError)) console.error(err);
    mostrarLogin();
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
      await mostrarApp(user);
    } catch (err) {
      erro.textContent = err.message || 'Falha no login.';
      erro.hidden = false;
    }
  });
}

function initDevLogin() {
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
      window.location.href = '/login';
    }
  });
}

init();
