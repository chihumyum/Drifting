import { useParams } from 'react-router-dom';

export function AllNodesEditorView() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(42, 26, 10, 0.6)',
        background: 'rgba(251, 249, 243, 1)',
        fontSize: 16,
        fontWeight: 600,
      }}
    >
      All Nodes Editor (placeholder) - {projectId}
    </div>
  );
}
