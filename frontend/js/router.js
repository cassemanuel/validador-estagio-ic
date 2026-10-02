/**
 * Roteador SPA simples (History API) para o frontend.
 *
 * Responsabilidade única: expor navegarPara() e permitir que app.js registre
 * a função que resolva uma rota em view concreta.
 */

let _resolver = null;

export function registerRouteResolver(fn) {
  _resolver = fn;
}

export function navegarPara(href) {
  if (!_resolver) {
    window.location.href = href;
    return;
  }
  history.pushState({ view: href }, '', href);
  _resolver(href);
}
