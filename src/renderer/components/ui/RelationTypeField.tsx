import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EntityRelationType } from '../../domain/entity-relation-type';
import { AnchoredPopover } from './AnchoredPopover';

interface RelationTypeFieldProps {
  value: string | null;
  onChange: (relationTypeId: string) => void;
  options: readonly EntityRelationType[];
  resolveOptionColor: (name: string) => string;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  buttonClassName?: string;
  autoFocus?: boolean;
}

/** Project relation-type selector. It deliberately has no free-text path: new
 * authored edges must choose a first-class definition, while migrated labels
 * remain visible as explicit `unconfigured` rows until the author configures
 * them in the shared relation menu. */
export function RelationTypeField({
  value,
  onChange,
  options,
  resolveOptionColor,
  placeholder,
  ariaLabel,
  className = '',
  buttonClassName = '',
  autoFocus = false,
}: RelationTypeFieldProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => options.find((option) => option.id === value) ?? null, [options, value]);
  const typeSummary = (type: EntityRelationType): string => {
    if (type.orientation === 'unconfigured') return t('relationTypes.pending');
    if (type.orientation === 'symmetric') {
      return t('relationTypes.symmetricSummary', { role: type.sourceRole });
    }
    return `${type.sourceRole} → ${type.targetRole}`;
  };

  return (
    <div className={className}>
      <button
        ref={anchorRef}
        type="button"
        autoFocus={autoFocus}
        className={buttonClassName}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? (
          <>
            <span
              className="relation-kind-suggestions__marker"
              style={{ background: resolveOptionColor(selected.name) }}
            />
            <span>{selected.name}</span>
            <span className="relation-type-field__summary">{typeSummary(selected)}</span>
          </>
        ) : (
          <span className="relation-type-field__placeholder">{placeholder}</span>
        )}
      </button>
      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        role="listbox"
        ariaLabel={ariaLabel}
        autoFocus={false}
        restoreFocus={false}
        maxHeight={260}
        className="relation-kind-suggestions relation-type-suggestions"
      >
        {options.length === 0 ? (
          <div className="relation-type-suggestions__empty">
            {t('relationTypes.emptySelector')}
          </div>
        ) : (
          options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={value === option.id}
              className="relation-kind-suggestions__option relation-type-suggestions__option"
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <span
                className="relation-kind-suggestions__marker"
                style={{ background: resolveOptionColor(option.name) }}
              />
              <span className="relation-type-suggestions__copy">
                <strong>{option.name}</strong>
                <small>{typeSummary(option)}</small>
              </span>
            </button>
          ))
        )}
      </AnchoredPopover>
    </div>
  );
}
