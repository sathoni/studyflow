/**
 * A very small helper for building screens.
 *
 * Not a framework. Roughly sixty lines that turn nested function calls into
 * DOM nodes, which is all this app needs. Copied unchanged from the Andrea &
 * Mathieu app, where it has been in daily use since August 2026.
 */

type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  /** Raw HTML. Only ever used for icons we generated ourselves. */
  html?: string;
  text?: string | number;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>;
  [key: string]: unknown;
}

/**
 * Build an element.
 *
 *   h('div', { class: 'card' }, h('p', { text: 'hello' }))
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else Object.assign(el.style, value);
    } else if (key === 'on') {
      for (const [type, handler] of Object.entries(value as Record<string, EventListener>)) {
        el.addEventListener(type, handler);
      }
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }

  append(el, children);
  return el;
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** Replace everything inside a node. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** Set text only when it changed, so the phone is not repainting for nothing. */
export function setText(el: Element | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
