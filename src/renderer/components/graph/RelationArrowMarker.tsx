interface RelationArrowMarkerProps {
  id: string;
  color: string;
}

export function RelationArrowMarker({ id, color }: RelationArrowMarkerProps) {
  return (
    <marker
      id={id}
      viewBox="0 0 9 8"
      markerWidth="9"
      markerHeight="8"
      refX="8"
      refY="4"
      orient="auto"
      markerUnits="userSpaceOnUse"
    >
      <path d="M 0 0 L 9 4 L 0 8 Z" fill={color} />
    </marker>
  );
}
