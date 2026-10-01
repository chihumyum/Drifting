import { useTranslation } from 'react-i18next';
import { AccountAvatar } from '../../../components/ui/AccountAvatar';
import { useAuthStore } from '../../../store/auth';
import type { SettingsNavigationSection } from './settings-section-navigation';

interface SettingsRailItem<Id extends string> {
  id: Id;
  group: string;
  glyph: string;
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
  const initial = (user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase();
  const groups: { name: string; items: typeof items }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.name === item.group) group.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  return (
    <nav className="set-rail" aria-label={t('settings.title')}>
      <div className="set-rail__who">
        <div className="set-rail__who-avatar"><AccountAvatar image={user?.image} initial={initial} /></div>
        <div className="set-rail__who-body">
          <div className="set-rail__who-name">
            {user?.name ?? user?.email ?? t('settings.local_user')}
          </div>
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
                  className={'set-rail__item' + (selected ? ' set-rail__item--active' : '')}
                  aria-current={selected && !activeSection ? 'location' : undefined}
                  aria-controls={item.id}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="set-rail__glyph" aria-hidden="true">{item.glyph}</span>
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
                          className={'set-rail__section' + (selected && activeSection === section.id ? ' set-rail__section--active' : '')}
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
