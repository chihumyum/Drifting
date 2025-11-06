import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { applyAccentColor } from '../../lib/theme';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AccentColorOption {
  name: string;
  displayName: string;
  hue: number; // HSL hue value (0-360)
  preview: string; // Preview color for the swatch
}

const ACCENT_COLORS: AccentColorOption[] = [
  { name: 'brown', displayName: '棕色 (默认)', hue: 30, preview: '#b89968' },
  { name: 'blue', displayName: '蓝色', hue: 210, preview: '#6b9ab8' },
  { name: 'green', displayName: '绿色', hue: 140, preview: '#68b894' },
  { name: 'purple', displayName: '紫色', hue: 270, preview: '#9a68b8' },
  { name: 'red', displayName: '红色', hue: 10, preview: '#b8686b' },
  { name: 'orange', displayName: '橙色', hue: 25, preview: '#b8926b' },
  { name: 'teal', displayName: '青色', hue: 180, preview: '#68b8b5' },
  { name: 'pink', displayName: '粉色', hue: 330, preview: '#b868a1' },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [selectedColor, setSelectedColor] = useState<string>('brown');
  const [activeTab, setActiveTab] = useState<'appearance' | 'account' | 'advanced'>('appearance');

  useEffect(() => {
    // Load saved accent color from localStorage
    const saved = localStorage.getItem('accentColor');
    if (saved) {
      setSelectedColor(saved);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleColorChange = (colorName: string) => {
    setSelectedColor(colorName);
    const colorOption = ACCENT_COLORS.find(c => c.name === colorName);
    if (colorOption) {
      // Save to localStorage
      localStorage.setItem('accentColor', colorName);
      localStorage.setItem('accentHue', colorOption.hue.toString());
      
      // Apply CSS custom properties for dynamic theming
      applyAccentColor(colorOption.hue);
      
      // Trigger a custom event for other components to react
      window.dispatchEvent(new CustomEvent('accentColorChange', { detail: { hue: colorOption.hue } }));
    }
  };

  useEffect(() => {
    // Initialize accent color on mount
    const savedHue = localStorage.getItem('accentHue');
    if (savedHue) {
      applyAccentColor(parseInt(savedHue));
    } else {
      // Default brown
      applyAccentColor(30);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(90, 74, 58, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '800px',
          height: '600px',
          backgroundColor: '#fefdfb',
          borderRadius: '16px',
          boxShadow: '0 20px 60px rgba(139, 111, 71, 0.25)',
          display: 'flex',
          overflow: 'hidden',
          border: '1px solid #e8dcc8',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div
          style={{
            width: '240px',
            backgroundColor: '#f9f6f1',
            borderRight: '1px solid #e8dcc8',
            display: 'flex',
            flexDirection: 'column',
            padding: '24px 0',
          }}
        >
          {/* Header */}
          <div style={{ padding: '0 24px', marginBottom: '24px' }}>
            <h2
              style={{
                fontSize: '18px',
                fontWeight: 600,
                color: '#2a1a0a',
                fontFamily: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
              }}
            >
              Settings
            </h2>
          </div>

          {/* Space Settings Section */}
          <div style={{ marginBottom: '24px' }}>
            <div
              style={{
                padding: '0 24px',
                marginBottom: '8px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#8b7355',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Space Settings
            </div>
            <button
              style={{
                width: '100%',
                padding: '10px 24px',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '14px',
                color: '#5a4a3a',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>📝</span>
              <span>Published Content</span>
            </button>
            <button
              style={{
                width: '100%',
                padding: '10px 24px',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '14px',
                color: '#5a4a3a',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>#</span>
              <span>Tags</span>
            </button>
          </div>

          {/* General Settings Section */}
          <div>
            <div
              style={{
                padding: '0 24px',
                marginBottom: '8px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#8b7355',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              General Settings
            </div>
            <button
              onClick={() => setActiveTab('appearance')}
              style={{
                width: '100%',
                padding: '10px 24px',
                textAlign: 'left',
                border: 'none',
                background: activeTab === 'appearance' ? '#fefdfb' : 'transparent',
                cursor: 'pointer',
                fontSize: '14px',
                color: activeTab === 'appearance' ? '#2a1a0a' : '#5a4a3a',
                fontWeight: activeTab === 'appearance' ? 600 : 400,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderLeft: activeTab === 'appearance' ? '3px solid var(--accent, #b89968)' : '3px solid transparent',
              }}
            >
              <span>🎨</span>
              <span>Appearance</span>
            </button>
            <button
              onClick={() => setActiveTab('account')}
              style={{
                width: '100%',
                padding: '10px 24px',
                textAlign: 'left',
                border: 'none',
                background: activeTab === 'account' ? '#fefdfb' : 'transparent',
                cursor: 'pointer',
                fontSize: '14px',
                color: activeTab === 'account' ? '#2a1a0a' : '#5a4a3a',
                fontWeight: activeTab === 'account' ? 600 : 400,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderLeft: activeTab === 'account' ? '3px solid var(--accent, #b89968)' : '3px solid transparent',
              }}
            >
              <span>👤</span>
              <span>Account</span>
            </button>
            <button
              onClick={() => setActiveTab('advanced')}
              style={{
                width: '100%',
                padding: '10px 24px',
                textAlign: 'left',
                border: 'none',
                background: activeTab === 'advanced' ? '#fefdfb' : 'transparent',
                cursor: 'pointer',
                fontSize: '14px',
                color: activeTab === 'advanced' ? '#2a1a0a' : '#5a4a3a',
                fontWeight: activeTab === 'advanced' ? 600 : 400,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderLeft: activeTab === 'advanced' ? '3px solid var(--accent, #b89968)' : '3px solid transparent',
              }}
            >
              <span>⚙️</span>
              <span>Advanced</span>
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Header with Close Button */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '24px 32px',
              borderBottom: '1px solid #e8dcc8',
            }}
          >
            <h3
              style={{
                fontSize: '20px',
                fontWeight: 600,
                color: '#2a1a0a',
                fontFamily: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
              }}
            >
              {activeTab === 'appearance' && 'Appearance'}
              {activeTab === 'account' && 'Account Settings'}
              {activeTab === 'advanced' && 'Advanced'}
            </h3>
            <button
              onClick={onClose}
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '6px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#5a4a3a',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f5f0e8';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content Area */}
          <div
            style={{
              flex: 1,
              padding: '32px',
              overflowY: 'auto',
            }}
          >
            {activeTab === 'appearance' && (
              <div>
                {/* Accent Color Section */}
                <div style={{ marginBottom: '32px' }}>
                  <h4
                    style={{
                      fontSize: '15px',
                      fontWeight: 600,
                      color: '#3a2a1a',
                      marginBottom: '8px',
                    }}
                  >
                    Accent Color
                  </h4>
                  <p
                    style={{
                      fontSize: '13px',
                      color: '#8b7355',
                      marginBottom: '16px',
                    }}
                  >
                    Choose an accent color for buttons, highlights, and interactive elements.
                  </p>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, 1fr)',
                      gap: '12px',
                    }}
                  >
                    {ACCENT_COLORS.map((color) => (
                      <button
                        key={color.name}
                        onClick={() => handleColorChange(color.name)}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '12px',
                          border: selectedColor === color.name ? '2px solid var(--accent, #b89968)' : '1px solid #e8dcc8',
                          borderRadius: '8px',
                          background: selectedColor === color.name ? '#f9f6f1' : '#fefdfb',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          if (selectedColor !== color.name) {
                            e.currentTarget.style.background = '#f9f6f1';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (selectedColor !== color.name) {
                            e.currentTarget.style.background = '#fefdfb';
                          }
                        }}
                      >
                        <div
                          style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '50%',
                            backgroundColor: color.preview,
                            border: '2px solid #fefdfb',
                            boxShadow: '0 2px 8px rgba(139, 111, 71, 0.15)',
                          }}
                        />
                        <span
                          style={{
                            fontSize: '13px',
                            color: '#5a4a3a',
                            fontWeight: selectedColor === color.name ? 600 : 400,
                          }}
                        >
                          {color.displayName}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Theme Section (Placeholder) */}
                <div style={{ marginBottom: '32px' }}>
                  <h4
                    style={{
                      fontSize: '15px',
                      fontWeight: 600,
                      color: '#3a2a1a',
                      marginBottom: '8px',
                    }}
                  >
                    Theme
                  </h4>
                  <p
                    style={{
                      fontSize: '13px',
                      color: '#8b7355',
                      marginBottom: '16px',
                    }}
                  >
                    Choose between light and dark mode. (Coming soon)
                  </p>
                </div>

                {/* Font Size Section (Placeholder) */}
                <div>
                  <h4
                    style={{
                      fontSize: '15px',
                      fontWeight: 600,
                      color: '#3a2a1a',
                      marginBottom: '8px',
                    }}
                  >
                    Font Size
                  </h4>
                  <p
                    style={{
                      fontSize: '13px',
                      color: '#8b7355',
                      marginBottom: '16px',
                    }}
                  >
                    Adjust the default font size for the editor. (Coming soon)
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'account' && (
              <div>
                <div
                  style={{
                    padding: '24px',
                    background: '#f9f6f1',
                    borderRadius: '8px',
                    border: '1px solid #e8dcc8',
                    marginBottom: '24px',
                  }}
                >
                  <div style={{ marginBottom: '16px' }}>
                    <div
                      style={{
                        fontSize: '13px',
                        color: '#8b7355',
                        marginBottom: '4px',
                      }}
                    >
                      Name
                    </div>
                    <div
                      style={{
                        fontSize: '15px',
                        color: '#3a2a1a',
                        fontWeight: 600,
                      }}
                    >
                      John Yang
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: '13px',
                        color: '#8b7355',
                        marginBottom: '4px',
                      }}
                    >
                      Email
                    </div>
                    <div
                      style={{
                        fontSize: '15px',
                        color: '#3a2a1a',
                      }}
                    >
                      108172547+chihumyum@users.noreply.github.com
                    </div>
                  </div>
                </div>
                <button
                  style={{
                    padding: '10px 20px',
                    background: 'var(--accent, #b89968)',
                    color: '#fefdfb',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Sign Out
                </button>
              </div>
            )}

            {activeTab === 'advanced' && (
              <div>
                <p
                  style={{
                    fontSize: '13px',
                    color: '#8b7355',
                  }}
                >
                  Advanced settings will be available soon.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
