interface StoryStageGroupData {
  label: string;
  width: number;
  height: number;
  color?: string;
}

export function StoryStageGroup({ data }: { data: StoryStageGroupData }) {
  return (
    <div style={{
      backgroundColor: data.color || '#f8f8f8',
      border: '2px dashed #ccc',
      borderRadius: '12px',
      padding: '16px',
      width: data.width,
      height: data.height,
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start'
    }}>
      <div style={{
        fontSize: '14px',
        fontWeight: 'bold',
        color: '#666',
        marginBottom: '8px',
        textAlign: 'center'
      }}>
        {data.label}
      </div>
    </div>
  );
}