import { CliError } from '../protocol';
import type { DebugLocator } from './types';

function locatorFrom(input: Record<string, unknown>): DebugLocator | undefined {
  const value = input.locator;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as DebugLocator;
}

export function requireLocator(input: Record<string, unknown>): DebugLocator {
  const locator = locatorFrom(input);
  if (!locator) throw new CliError('LOCATOR_REQUIRED', 'input.locator is required');
  if (
    !['css', 'debug-id', 'role', 'text'].includes(locator.kind) ||
    (locator.kind !== 'role' && typeof locator.value !== 'string') ||
    (locator.kind === 'role' && typeof locator.role !== 'string')
  ) {
    throw new CliError('INVALID_LOCATOR', 'input.locator is invalid');
  }
  return locator;
}

export function buildDomExpression(
  command: 'snapshot' | 'query' | 'style' | 'hit-test' | 'resolve-point',
  input: Record<string, unknown>,
): string {
  const serialized = JSON.stringify(input).replace(/</gu, '\\u003c');
  return `(() => {
    const command = ${JSON.stringify(command)};
    const input = ${serialized};
    const textLimit = 200;
    const elementLimit = Math.min(500, Math.max(1, Number(input.limit) || 50));
    const clip = (value, limit = textLimit) => {
      const string = String(value ?? '').replace(/\\s+/g, ' ').trim();
      return { value: string.length > limit ? string.slice(0, limit) + '…' : string, truncated: string.length > limit };
    };
    const implicitRole = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = String(element.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type !== 'hidden') return 'textbox';
      }
      return null;
    };
    const accessibleName = (element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt') || element.innerText || '';
    const resolve = (locator) => {
      if (!locator || typeof locator !== 'object') return [];
      if (locator.kind === 'css') return [...document.querySelectorAll(locator.value)];
      if (locator.kind === 'debug-id') return [...document.querySelectorAll('[data-debug-id="' + CSS.escape(locator.value) + '"]')];
      const all = [...document.querySelectorAll('*')];
      if (locator.kind === 'role') {
        return all.filter((element) => {
          const role = element.getAttribute('role') || implicitRole(element);
          if (role !== locator.role) return false;
          if (typeof locator.name !== 'string') return true;
          const actual = accessibleName(element).replace(/\\s+/g, ' ').trim();
          return locator.exact ? actual === locator.name : actual.toLowerCase().includes(locator.name.toLowerCase());
        });
      }
      if (locator.kind === 'text') {
        return all.filter((element) => {
          if (element.children.length > 0) return false;
          const actual = String(element.textContent || '').replace(/\\s+/g, ' ').trim();
          return locator.exact ? actual === locator.value : actual.toLowerCase().includes(locator.value.toLowerCase());
        });
      }
      return [];
    };
    const describe = (element, includeText = true) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const text = includeText ? clip(element.innerText || element.textContent || '') : { value: null, truncated: false };
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hitStack = document.elementsFromPoint(centerX, centerY).slice(0, 8).map((hit) => ({
        tag: hit.tagName.toLowerCase(),
        id: hit.id || null,
        debugId: hit.getAttribute('data-debug-id'),
        className: typeof hit.className === 'string' ? clip(hit.className, 160).value : '',
      }));
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        debugId: element.getAttribute('data-debug-id'),
        role: element.getAttribute('role') || implicitRole(element),
        ariaLabel: element.getAttribute('aria-label'),
        ariaCurrent: element.getAttribute('aria-current'),
        text: text.value,
        textTruncated: text.truncated,
        rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
        enabled: !(element.disabled === true || element.getAttribute('aria-disabled') === 'true'),
        scroll: { top: element.scrollTop, left: element.scrollLeft, width: element.scrollWidth, height: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight },
        styles: { display: style.display, visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents, position: style.position, zIndex: style.zIndex, overflowX: style.overflowX, overflowY: style.overflowY, transform: style.transform },
        hitStack,
      };
    };
    if (command === 'snapshot') {
      const active = document.activeElement instanceof HTMLElement ? describe(document.activeElement, false) : null;
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY, visualViewport: visualViewport ? { width: visualViewport.width, height: visualViewport.height, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale } : null },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, elements: document.querySelectorAll('*').length },
        activeElement: active,
        state: globalThis.__DRIFTING_FRONTEND_DEBUG_V1__?.snapshot?.() ?? null,
      };
    }
    if (command === 'hit-test' && Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y))) {
      return document.elementsFromPoint(Number(input.x), Number(input.y)).slice(0, elementLimit).map(describe);
    }
    const elements = resolve(input.locator);
    if (command === 'resolve-point') {
      const element = elements[0];
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, element: describe(element) };
    }
    if (command === 'style') {
      const element = elements[0];
      if (!element) return null;
      const style = getComputedStyle(element);
      const requested = Array.isArray(input.properties) ? input.properties.slice(0, 100) : [];
      return { element: describe(element), properties: Object.fromEntries(requested.map((property) => [String(property), style.getPropertyValue(String(property))])) };
    }
    return { count: elements.length, truncated: elements.length > elementLimit, elements: elements.slice(0, elementLimit).map(describe) };
  })()`;
}
