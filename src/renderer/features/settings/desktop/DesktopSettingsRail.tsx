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
  items, active, activeSection, onSelect,
}: {
  items: SettingsRailItem<Id>[];
  active: Id;
  activeSection: string | null;
  onSelect: (id: Id, section?: SettingsNavigationSection) => void;
}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.hostedUser);
  const name = user?.name ?? user?.email ?? t('settings.local_user');
  const initial = name.slice(0, 1).toUpperCase();
  const groups: { name: string; items: typeof items }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.name === item.group) group.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

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
          <div className="set-rail__who-meta">{t('settings.models.sidebarMeta')}</div>
        </div>
      </div>

      {groups.map(group => (
        <div className="set-rail__group" key={group.name}>
          <div className="set-rail__group-title">{group.name}</div>
          {group.items.map(item => {
            const selected = active === item.id;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  className={
                    'set-rail__item' +
                    (selected ? ' set-rail__item--active' : '') +
                    (selected && !activeSection ? ' is-current' : '')
                  }
                  aria-current={selected && !activeSection ? 'location' : undefined}
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
                {item.sections.length > 0 && (
                  <ul className="set-rail__sections">
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
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
