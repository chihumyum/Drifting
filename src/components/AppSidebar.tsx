import { Settings, User, HelpCircle, FileText, BookOpen } from 'lucide-react';

export function AppSidebar() {
  const menuItems = [
    { icon: BookOpen, label: 'Chapters' },
    { icon: FileText, label: 'Notes' },
    { icon: User, label: 'Account' },
    { icon: Settings, label: 'Settings' },
    { icon: HelpCircle, label: 'Help' },
  ];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '24px 16px',
        background: 'transparent',
      }}
    >
      {/* App Logo */}
      <div
        style={{
          width: '48px',
          height: '48px',
          margin: '0 auto 32px',
          borderRadius: '14px',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '24px',
          fontWeight: 'bold',
          color: 'white',
          boxShadow: '0 4px 12px rgba(102, 126, 234, 0.3)',
        }}
      >
        D
      </div>

      {/* Menu Items */}
      <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {menuItems.map((item, index) => (
          <button
            key={index}
            onClick={() => alert(`${item.label} clicked`)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '12px 16px',
              borderRadius: '10px',
              border: 'none',
              background: 'transparent',
              color: '#5a4d6f',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              textAlign: 'left',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(102, 126, 234, 0.08)';
              e.currentTarget.style.color = '#667eea';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = '#5a4d6f';
            }}
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
