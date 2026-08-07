import { ChevronLeft } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { AnchoredPopover } from '../ui/AnchoredPopover';

interface ElementCategoryCreateMenuProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  categoryName: string;
  existingGroupNames: string[];
  onCreateElement: () => void;
  onCreateGroup: (groupName: string) => void;
  onClose: () => void;
}

/**
 * One compact creation entry for an Element category. Groups are labels stored
 * on elements rather than standalone rows, so creating a group also creates
 * and opens its first element instead of pretending an empty group can exist.
 */
export function ElementCategoryCreateMenu({
  anchorRef,
  categoryName,
  existingGroupNames,
  onCreateElement,
  onCreateGroup,
  onClose,
}: ElementCategoryCreateMenuProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'actions' | 'group'>('actions');
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const helperId = `${inputId}-helper`;
  const groupName = draft.trim();
  const duplicateGroup = useMemo(
    () =>
      groupName.length > 0 &&
      existingGroupNames.some(
        (name) => name.trim().toLocaleLowerCase() === groupName.toLocaleLowerCase(),
      ),
    [existingGroupNames, groupName],
  );
  const canSubmit = groupName.length > 0 && !duplicateGroup;

  const submitGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    onClose();
    onCreateGroup(groupName);
  };

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      open
      onClose={onClose}
      placement="bottom-start"
      role={mode === 'actions' ? 'menu' : 'dialog'}
      ariaLabel={t('elementCategoryCreateMenu.title', { name: categoryName })}
      className="menu-surface menu-surface--standard editor-bar__menu"
      style={{ zIndex: 'var(--z-popover)', overflow: 'hidden' }}
    >
      {mode === 'actions' ? (
        <>
          <div className="menu-surface__section-label">
            {t('elementCategoryCreateMenu.title', { name: categoryName })}
          </div>
          <button
            autoFocus
            type="button"
            role="menuitem"
            className="menu-surface__item"
            onClick={() => {
              onClose();
              onCreateElement();
            }}
          >
            {t('elementCategoryCreateMenu.newElement')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-surface__item"
            onClick={() => setMode('group')}
          >
            {t('elementCategoryCreateMenu.newGroup')}
          </button>
        </>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              minHeight: 24,
              padding: '0 4px 3px',
            }}
          >
            <button
              type="button"
              aria-label={t('elementCategoryCreateMenu.back')}
              title={t('elementCategoryCreateMenu.back')}
              onClick={() => setMode('actions')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                padding: 0,
                border: 0,
                borderRadius: 2,
                background: 'transparent',
                color: 'hsl(var(--ink-3))',
                cursor: 'pointer',
              }}
            >
              <ChevronLeft size={13} strokeWidth={1.8} />
            </button>
            <div className="menu-surface__section-label" style={{ padding: 0 }}>
              {t('elementCategoryCreateMenu.groupTitle')}
            </div>
          </div>
          <form onSubmit={submitGroup} style={{ padding: '2px 8px 4px' }}>
            <label
              htmlFor={inputId}
              style={{
                display: 'block',
                marginBottom: 4,
                color: 'hsl(var(--ink-3))',
                fontSize: 11,
              }}
            >
              {t('elementCategoryCreateMenu.groupNameLabel')}
            </label>
            <input
              id={inputId}
              autoFocus
              value={draft}
              aria-invalid={duplicateGroup || undefined}
              aria-describedby={helperId}
              placeholder={t('elementCategoryCreateMenu.groupNamePlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                setMode('actions');
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '5px 8px',
                border: `1px solid hsl(var(${duplicateGroup ? '--accent' : '--rule-strong'}))`,
                borderRadius: 2,
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-1))',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <div
              id={helperId}
              role={duplicateGroup ? 'alert' : undefined}
              style={{
                minHeight: 28,
                padding: '4px 1px 3px',
                color: duplicateGroup ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))',
                fontSize: 10.5,
                lineHeight: 1.3,
              }}
            >
              {t(
                duplicateGroup
                  ? 'elementCategoryCreateMenu.duplicateGroup'
                  : 'elementCategoryCreateMenu.groupCreatesFirstElement',
              )}
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              className="menu-surface__item"
              style={{
                justifyContent: 'center',
                opacity: canSubmit ? 1 : 0.45,
                cursor: canSubmit ? 'pointer' : 'default',
              }}
            >
              {t('elementCategoryCreateMenu.createGroup')}
            </button>
          </form>
        </>
      )}
    </AnchoredPopover>
  );
}
