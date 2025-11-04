import type { CSSProperties } from 'react';

export function RightVerticalButtons() {
  const buttonStyle: CSSProperties = {
    width: 56,
    height: 56,
    borderRadius: 14,
    border: 'none',
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.1)',
    transition: 'all 0.2s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const buttons = [
    { icon: '📝', label: 'Notes', action: () => alert('Notes feature coming soon') },
    { icon: '🔖', label: 'Bookmarks', action: () => alert('Bookmarks feature coming soon') },
    { icon: '🎨', label: 'Themes', action: () => alert('Themes feature coming soon') },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        right: 24,
        bottom: 140, // Above timeline (120px) + margin
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        zIndex: 50,
      }}
    >
      {buttons.map((btn, index) => (
        <button
          key={index}
          onClick={btn.action}
          style={buttonStyle}
          className="bg-mild"
          title={btn.label}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.05)';
            e.currentTarget.style.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.25)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.1)';
          }}
        >
          {btn.icon}
        </button>
      ))}
    </div>
  );
}