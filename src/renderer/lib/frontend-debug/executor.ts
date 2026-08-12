import type { RendererDebugLocator, RendererDebugRequest } from './types';

const ELEMENT_LIMIT = 500;
const ELEMENT_TEXT_LIMIT = 200;

function clip(value: unknown, limit = ELEMENT_TEXT_LIMIT) {
  const text = String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  return {
    value: text.length > limit ? `${text.slice(0, limit)}…` : text,
    truncated: text.length > limit,
  };
}

function implicitRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag !== 'input') return null;
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  if (['button', 'submit', 'reset'].includes(type)) return 'button';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  return type === 'hidden' ? null : 'textbox';
}

function accessibleName(element: Element): string {
  return (
    element.getAttribute('aria-label') ??
    element.getAttribute('title') ??
    element.getAttribute('alt') ??
    (element instanceof HTMLElement ? element.innerText : element.textContent) ??
    ''
  );
}

function locatorFrom(input: Record<string, unknown>): RendererDebugLocator {
  const locator = input.locator;
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
    throw new Error('input.locator is required');
  }
  return locator as RendererDebugLocator;
}

function resolveElements(locator: RendererDebugLocator): Element[] {
  if (locator.kind === 'css') return [...document.querySelectorAll(locator.value)];
  if (locator.kind === 'debug-id') {
    return [...document.querySelectorAll(`[data-debug-id="${CSS.escape(locator.value)}"]`)];
  }
  const elements = [...document.querySelectorAll('*')];
  if (locator.kind === 'role') {
    return elements.filter((element) => {
      if ((element.getAttribute('role') ?? implicitRole(element)) !== locator.role) return false;
      if (locator.name === undefined) return true;
      const name = accessibleName(element).replace(/\s+/gu, ' ').trim();
      return locator.exact
        ? name === locator.name
        : name.toLowerCase().includes(locator.name.toLowerCase());
    });
  }
  return elements.filter((element) => {
    if (element.children.length > 0) return false;
    const text = (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
    return locator.exact
      ? text === locator.value
      : text.toLowerCase().includes(locator.value.toLowerCase());
  });
}

function describe(element: Element, includeText = true) {
  const html = element instanceof HTMLElement ? element : null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const text = includeText
    ? clip(html?.innerText ?? element.textContent)
    : { value: null, truncated: false };
  const hitStack = document
    .elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    .slice(0, 8)
    .map((hit) => ({
      tag: hit.tagName.toLowerCase(),
      id: hit.id || null,
      debugId: hit.getAttribute('data-debug-id'),
      className: typeof hit.className === 'string' ? clip(hit.className, 160).value : '',
    }));
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    debugId: element.getAttribute('data-debug-id'),
    role: element.getAttribute('role') ?? implicitRole(element),
    ariaLabel: element.getAttribute('aria-label'),
    ariaCurrent: element.getAttribute('aria-current'),
    text: text.value,
    textTruncated: text.truncated,
    rect: {
      x: rect.x,
      y: rect.y,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0,
    enabled:
      !(
        (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
        element.disabled
      ) && element.getAttribute('aria-disabled') !== 'true',
    scroll: html
      ? {
          top: html.scrollTop,
          left: html.scrollLeft,
          width: html.scrollWidth,
          height: html.scrollHeight,
          clientWidth: html.clientWidth,
          clientHeight: html.clientHeight,
        }
      : null,
    styles: {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      position: style.position,
      zIndex: style.zIndex,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      transform: style.transform,
    },
    hitStack,
  };
}

function pointFor(input: Record<string, unknown>, coordinatesAllowed = false) {
  if (coordinatesAllowed && Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y))) {
    return {
      x: Number(input.x),
      y: Number(input.y),
      element: document.elementFromPoint(Number(input.x), Number(input.y)),
    };
  }
  const element = resolveElements(locatorFrom(input))[0];
  if (!element) throw new Error('The locator did not match an element');
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, element };
}

function pointer(target: Element, type: string, input: PointerEventInit): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'touch',
      pressure: type === 'pointerup' ? 0 : 1,
      ...input,
    }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitFor(input: Record<string, unknown>) {
  const timeoutMs = Math.min(60_000, Math.max(50, Number(input.timeoutMs) || 15_000));
  const state = typeof input.state === 'string' ? input.state : 'visible';
  const locator = locatorFrom(input);
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    const element = resolveElements(locator)[0];
    const visible = element ? describe(element).visible : false;
    if (
      (state === 'attached' && element) ||
      (state === 'visible' && visible) ||
      (state === 'hidden' && !visible)
    ) {
      return {
        state,
        elapsedMs: Math.round(performance.now() - started),
        match: element ? describe(element) : null,
      };
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for locator to become ${state}`);
}

export async function executeRendererDebugCommand(request: RendererDebugRequest): Promise<unknown> {
  const { command, input } = request;
  if (command === 'snapshot') {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        elements: document.querySelectorAll('*').length,
      },
      activeElement:
        document.activeElement instanceof HTMLElement
          ? describe(document.activeElement, false)
          : null,
      state: window.__DRIFTING_FRONTEND_DEBUG_V1__?.snapshot() ?? null,
    };
  }
  if (command === 'query') {
    const elements = resolveElements(locatorFrom(input));
    const limit = Math.min(ELEMENT_LIMIT, Math.max(1, Number(input.limit) || 50));
    return {
      count: elements.length,
      truncated: elements.length > limit,
      elements: elements.slice(0, limit).map((element) => describe(element)),
    };
  }
  if (command === 'wait') return waitFor(input);
  if (command === 'style') {
    const element = resolveElements(locatorFrom(input))[0];
    if (!element) return null;
    const style = getComputedStyle(element);
    const properties = Array.isArray(input.properties) ? input.properties.slice(0, 100) : [];
    return {
      element: describe(element),
      properties: Object.fromEntries(
        properties.map((property) => [String(property), style.getPropertyValue(String(property))]),
      ),
    };
  }
  if (command === 'hit-test') {
    const point =
      Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y))
        ? { x: Number(input.x), y: Number(input.y) }
        : pointFor(input);
    return document
      .elementsFromPoint(point.x, point.y)
      .slice(0, 50)
      .map((element) => describe(element));
  }
  if (command === 'evaluate') {
    if (typeof input.expression !== 'string' || !input.expression.trim()) {
      throw new Error('input.expression is required');
    }
    return (0, eval)(input.expression) as unknown;
  }
  if (command === 'tap') {
    const point = pointFor(input, true);
    const target = point.element;
    if (!target) throw new Error('No element exists at the requested point');
    pointer(target, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
    });
    pointer(target, 'pointerup', {
      pointerId: 1,
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
    });
    if (target instanceof HTMLElement) target.click();
    return { inputPath: 'synthetic-dom', point: { x: point.x, y: point.y } };
  }
  if (command === 'type') {
    const point = pointFor(input);
    const target = point.element;
    if (!(target instanceof HTMLElement)) throw new Error('The target is not editable');
    target.focus();
    const text = String(input.text ?? '');
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const prototype =
        target instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(target, input.replace === false ? `${target.value}${text}` : text);
      target.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (target.isContentEditable) {
      if (input.replace !== false) target.textContent = '';
      target.textContent = `${target.textContent ?? ''}${text}`;
      target.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
    } else {
      throw new Error('The target is not editable');
    }
    return { inputPath: 'synthetic-dom', point: { x: point.x, y: point.y } };
  }
  if (command === 'scroll') {
    const point = pointFor(input, true);
    const target = point.element instanceof HTMLElement ? point.element : document.scrollingElement;
    const deltaX = Number(input.deltaX) || 0;
    const deltaY = Number(input.deltaY) || 0;
    point.element?.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY }),
    );
    target?.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
    return { inputPath: 'synthetic-dom', point: { x: point.x, y: point.y } };
  }
  if (command === 'drag') {
    const from = pointFor(input, true);
    const target = from.element;
    if (!target) throw new Error('No drag target exists at the requested point');
    const to = {
      x: Number.isFinite(Number(input.toX))
        ? Number(input.toX)
        : from.x + (Number(input.deltaX) || 0),
      y: Number.isFinite(Number(input.toY))
        ? Number(input.toY)
        : from.y + (Number(input.deltaY) || 0),
    };
    pointer(target, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      clientX: from.x,
      clientY: from.y,
    });
    for (let step = 1; step <= 8; step += 1) {
      pointer(target, 'pointermove', {
        pointerId: 1,
        isPrimary: true,
        clientX: from.x + ((to.x - from.x) * step) / 8,
        clientY: from.y + ((to.y - from.y) * step) / 8,
      });
      await delay(16);
    }
    pointer(target, 'pointerup', { pointerId: 1, isPrimary: true, clientX: to.x, clientY: to.y });
    return { inputPath: 'synthetic-dom', from: { x: from.x, y: from.y }, to };
  }
  if (command === 'pinch') {
    const center = pointFor(input, true);
    const target = center.element;
    if (!target) throw new Error('No pinch target exists at the requested point');
    const startDistance = Number(input.startDistance) || 180;
    const endDistance = Number(input.endDistance) || 80;
    const points = (distance: number) => [center.x - distance / 2, center.x + distance / 2];
    points(startDistance).forEach((x, index) =>
      pointer(target, 'pointerdown', {
        pointerId: index + 1,
        isPrimary: index === 0,
        clientX: x,
        clientY: center.y,
      }),
    );
    for (let step = 1; step <= 10; step += 1) {
      const distance = startDistance + ((endDistance - startDistance) * step) / 10;
      points(distance).forEach((x, index) =>
        pointer(target, 'pointermove', {
          pointerId: index + 1,
          isPrimary: index === 0,
          clientX: x,
          clientY: center.y,
        }),
      );
      await delay(16);
    }
    points(endDistance).forEach((x, index) =>
      pointer(target, 'pointerup', {
        pointerId: index + 1,
        isPrimary: index === 0,
        clientX: x,
        clientY: center.y,
      }),
    );
    return {
      inputPath: 'synthetic-dom',
      center: { x: center.x, y: center.y },
      startDistance,
      endDistance,
    };
  }
  throw new Error(`Command ${command} is handled by the daemon, not the renderer`);
}
