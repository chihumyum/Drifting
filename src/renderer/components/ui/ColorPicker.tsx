import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/** The system colour picker shared by preferences and entity editors. */
export function ColorPicker({
  value,
  onChange,
  ariaLabel,
  mark,
  showValue = true,
  children,
}: {
  /** A hex colour or an existing theme colour such as hsl(var(--story-1)). */
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  mark?: ReactNode;
  showValue?: boolean;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const swatchRef = useRef<HTMLSpanElement>(null);
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;

  const prepareColor = useCallback(() => {
    const input = inputRef.current;
    const swatch = swatchRef.current;
    if (!input || !swatch) return;
    if (hex) {
      input.value = hex;
      return;
    }
    // Resolve CSS variables in the current theme without rewriting the stored
    // preset. A native colour input requires six-digit hex, not CSS colours.
    const canvas = input.ownerDocument.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = getComputedStyle(swatch).color;
    context.fillRect(0, 0, 1, 1);
    const rgb = context.getImageData(0, 0, 1, 1).data;
    input.value = `#${Array.from(rgb.slice(0, 3), (c) => c.toString(16).padStart(2, '0')).join('')}`;
  }, [hex]);

  useEffect(() => {
    prepareColor();
  }, [prepareColor, value]);

  const input = (
    <input
      ref={inputRef}
      type="color"
      defaultValue={hex ?? '#000000'}
      aria-label={ariaLabel}
      onFocus={prepareColor}
      onClick={prepareColor}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <span
      ref={swatchRef}
      className="set-color"
      style={{ color: value }}
    >
      <label className="ui-swatch glass glass--rest glass--round">
        {mark ?? <i className="sand sand--blob-2" style={{ '--sand-c': value } as CSSProperties} />}
        {input}
      </label>
      {showValue && (
        <span className="ui-swatch__value">
          {hex?.toUpperCase() ?? ariaLabel}
        </span>
      )}
      {children}
    </span>
  );
}
