import { useParams } from 'react-router-dom';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';

export function AllNodesEditorView() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div
      className="editor-shell"
      style={{
        height: '100%',
        background: 'rgba(251, 249, 243, 1)',
      }}
    >
      <EditorTopBar>
        <EditorCrumb>
          <span>All Nodes</span>
        </EditorCrumb>
      </EditorTopBar>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: 'rgba(42, 26, 10, 0.7)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>All Nodes Editor View</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Placeholder for full-book scrollable node editor · {projectId}
        </div>
      </div>
    </div>
  );
}
