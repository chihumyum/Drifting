import { useParams } from 'react-router-dom';

export function AllElementsEditorView() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: 'rgba(42, 26, 10, 0.7)',
        background: 'rgba(251, 249, 243, 1)',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700 }}>All Elements Editor View</div>
      <div style={{ fontSize: 13, opacity: 0.8 }}>
        Placeholder for full-book scrollable element editor · {projectId}
      </div>
    </div>
  );
}
