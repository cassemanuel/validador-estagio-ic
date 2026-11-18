/**
 * Testes do helper el() (frontend/js/ui/dom.js) com um DOM mínimo simulado:
 * atributos booleanos não podem virar strings "false".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  hasAttribute(k) { return this.attributes.has(k); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(tipo, fn) { this.listeners[tipo] = fn; }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (t) => Object.assign(new FakeNode(), { text: t }),
};

const { el } = await import('../../frontend/js/ui/dom.js');

test('disabled: false não gera o atributo (botão fica habilitado)', () => {
  const btn = el('button', { type: 'button', disabled: false });
  assert.equal(btn.hasAttribute('disabled'), false);
});

test('disabled: true gera atributo vazio', () => {
  const btn = el('button', { disabled: true });
  assert.equal(btn.getAttribute('disabled'), '');
});

test('null/undefined omitem o atributo; strings são preservadas', () => {
  const div = el('div', { title: null, id: undefined, 'aria-expanded': 'false' });
  assert.equal(div.hasAttribute('title'), false);
  assert.equal(div.hasAttribute('id'), false);
  assert.equal(div.getAttribute('aria-expanded'), 'false');
});

test('href continua sanitizado', () => {
  const a = el('a', { href: 'javascript:alert(1)' });
  assert.equal(a.getAttribute('href'), '#');
});
