import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountAvatar } from '../../../components/ui/AccountAvatar';
import { BrushIcon, type BrushIconName } from '../../../components/ui/BrushIcon';
import { useAuthStore } from '../../../store/auth';
import type { SettingsNavigationSection } from './settings-section-navigation';

interface SettingsRailItem<Id extends string> {
  id: Id;
  group: string;
  icon: BrushIconName | null;
  label: string;
  badge?: { text: string; tone?: 'accent' | 'warn' };
  sections: SettingsNavigationSection[];
}

export function DesktopSettingsRail<Id extends string>({
  items, active, activeSection, searching, onSelect,
}: {
  items: SettingsRailItem<Id>[];
  active: Id;
  activeSection: string | null;
  /** A search lists its matches open; folding is for browsing the whole rail. */
  searching: boolean;
  onSelect: (id: Id, section?: SettingsNavigationSection) => void;
}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.hostedUser);
  // Every panel opens with its sections listed; a fold lasts while Settings is open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const name = user?.name ?? user?.email ?? t('settings.local_user');
  // The email under a display name; a local author reads where the books live.
  const meta = user ? (user.name ? user.email : null) : t('settings.hosted.disabled');
  const initial = name.slice(0, 1).toUpperCase();
  const groups: { name: string; items: typeof items }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.name === item.group) group.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }
  const toggle = (id: string) => setFolded((previous) => {
    const next = new Set(previous);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  return (
    <nav className="set-rail" aria-label={t('settings.title')}>
      <div className="set-rail__who">
        {/* A name seal: the initial carved out of one sand seal, or the avatar. */}
        <div className="set-rail__who-avatar">
          <i className="sand sand--blob-0" aria-hidden="true" />
          <b><AccountAvatar image={user?.image} initial={initial} /></b>
        </div>
        <div className="set-rail__who-body">
          <div className="set-rail__who-name">{name}</div>
          {meta && <div className="set-rail__who-meta">{meta}</div>}
        </div>
      </div>

      {groups.map(group => (
        <div className="set-rail__group" key={group.name}>
          <div className="set-rail__group-title">{group.name}</div>
          {group.items.map(item => {
            const selected = active === item.id;
            const foldable = item.sections.length > 0 && !searching;
            const open = !foldable || !folded.has(item.id);
            // A folded panel's current section is out of sight; its row stands in.
            const current = selected && (!activeSection || !open);
            const sectionsId = `set-rail-sections-${item.id}`;
            return (
              <div key={item.id}>
                <div className="set-rail__row">
                  <button
                    type="button"
                    className={
                      'set-rail__item' +
                      (foldable ? ' set-rail__item--foldable' : '') +
                      (selected ? ' set-rail__item--active' : '') +
                      (current ? ' is-current' : '')
                    }
                    aria-current={current ? 'location' : undefined}
                    aria-controls={item.id}
                    onClick={() => onSelect(item.id)}
                  >
                    <span className="set-rail__glyph" aria-hidden="true">{item.icon && <BrushIcon name={item.icon} size={14} />}</span>
                    <span className="set-rail__label">{item.label}</span>
                    {item.badge && (
                      <span className={'set-rail__badge' + (item.badge.tone === 'warn' ? ' set-rail__badge--warn' : '')}>
                        {item.badge.text}
                      </span>
                    )}
                  </button>
                  {foldable && (
                    <button
                      type="button"
                      className="set-rail__fold"
                      aria-expanded={open}
                      aria-controls={sectionsId}
                      aria-label={t(open ? 'settings.rail_collapse' : 'settings.rail_expand', { label: item.label })}
                      onClick={() => toggle(item.id)}
                    >
                      <BrushIcon
                        name="chevron-right"
                        size={11}
                        className={'set-rail__fold-chevron' + (open ? ' set-rail__fold-chevron--open' : '')}
                      />
                    </button>
                  )}
                </div>
                {item.sections.length > 0 && (
                  <div className={'set-rail__sections-fold' + (open ? ' is-open' : '')}>
                    <div className="set-rail__sections-clip">
                      <ul className="set-rail__sections" id={sectionsId} inert={!open}>
                        {item.sections.map(section => (
                          <li key={section.id}>
                            <button
                              type="button"
                              className={'set-rail__section' + (selected && activeSection === section.id ? ' set-rail__section--active is-current' : '')}
                              aria-current={selected && activeSection === section.id ? 'location' : undefined}
                              aria-controls={section.id}
                              onClick={() => onSelect(item.id, section)}
                            >
                              {section.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
