import { EntityPanel } from '../components/EntityPanel';

export function EntityPanelView() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: '#f4f2f6',
        padding: '24px 32px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          height: '100%',
          backgroundColor: '#faf9fa',
          borderRadius: 24,
          boxShadow: '0 24px 48px rgba(40, 32, 70, 0.12)',
          overflow: 'hidden',
        }}
      >
        <EntityPanel collapsed={false} />
      </div>
    </div>
  );
}
