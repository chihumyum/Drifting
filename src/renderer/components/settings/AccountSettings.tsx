import { LogOut, User } from 'lucide-react';
import { useAuthStore } from '../../store/auth';

export function AccountSettings() {
  const { user, logout } = useAuthStore();

  const handleLogout = async () => {
    await logout();
    // Ideally we might want to close the modal or redirect, but existing logout logic
    // in store seems to handle state clearing. For now just calling logout is enough.
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h4
          style={{
            fontSize: '15px',
            fontWeight: 600,
            color: '#3a2a1a',
            marginBottom: '8px',
          }}
        >
          Account Info
        </h4>

        {user ? (
          <div
            style={{
              padding: '16px',
              backgroundColor: '#f9f6f1',
              borderRadius: '8px',
              border: '1px solid #e8dcc8',
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
            }}
          >
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                backgroundColor: '#e8dcc8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#8b7355',
              }}
            >
              <User size={24} />
            </div>
            <div>
              <div style={{ fontWeight: 600, color: '#2a1a0a' }}>{user.name || 'User'}</div>
              <div style={{ fontSize: '13px', color: '#8b7355' }}>{user.email}</div>
            </div>
          </div>
        ) : (
          <div
            style={{
              padding: '16px',
              backgroundColor: '#f9f6f1',
              borderRadius: '8px',
              border: '1px solid #e8dcc8',
              color: '#8b7355',
              fontSize: '14px',
            }}
          >
            Not logged in
          </div>
        )}
      </div>

      <div>
        <h4
          style={{
            fontSize: '15px',
            fontWeight: 600,
            color: '#3a2a1a',
            marginBottom: '8px',
          }}
        >
          Actions
        </h4>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            backgroundColor: '#fff0f0',
            border: '1px solid #ffccd0',
            borderRadius: '6px',
            color: '#d32f2f',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#ffe5e5';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#fff0f0';
          }}
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </div>
  );
}
