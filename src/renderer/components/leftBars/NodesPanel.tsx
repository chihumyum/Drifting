export function NodesPanel() {
  return (
    <div
      style={{
        padding: '24px 18px',
        color: 'hsl(var(--ink-3))',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'hsl(var(--ink-4))',
        }}
      >
        Nodes
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontStyle: 'italic',
          fontSize: 13,
          color: 'hsl(var(--ink-3))',
          lineHeight: 1.5,
        }}
      >
        Placeholder for nodes list layout.
      </div>
    </div>
  );
}
