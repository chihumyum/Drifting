import { type ReactNode, type CSSProperties } from 'react';
import { X } from 'lucide-react';

interface ModalShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function ModalShell({ title, onClose, children }: ModalShellProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: '92%',
          maxWidth: 420,
          backgroundColor: '#fff',
          borderRadius: 16,
          boxShadow: '0 20px 40px rgba(33, 29, 51, 0.24)',
          padding: 24,
          position: 'relative'
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            border: 'none',
            background: 'transparent',
            color: '#8d7a9c',
            cursor: 'pointer'
          }}
          aria-label="关闭"
        >
          <X size={16} />
        </button>
        <h3 style={{ margin: '0 0 18px 0', fontSize: 16, color: '#372f44' }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export const modalInputStyle: CSSProperties = {
  fontSize: 13,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #d4c8d4',
  backgroundColor: '#fff',
  color: '#352f3b'
};

export const modalPrimaryButtonStyle: CSSProperties = {
  border: 'none',
  backgroundColor: '#3a855a',
  color: '#fff',
  padding: '8px 18px',
  borderRadius: 999,
  fontSize: 12,
  cursor: 'pointer'
};

export const modalSecondaryButtonStyle: CSSProperties = {
  border: 'none',
  backgroundColor: '#e4dff0',
  color: '#4b4155',
  padding: '8px 18px',
  borderRadius: 999,
  fontSize: 12,
  cursor: 'pointer'
};
