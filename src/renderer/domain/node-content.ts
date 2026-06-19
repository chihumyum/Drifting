export interface NodeContent {
  nodeId: string;
  contentJson: string;
  outlineJson: string;
  /** In-chapter plot planner grid, serialized PlotGrid (see domain/plot-grid.ts). */
  plotGridJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutlineItem {
  id: string; // Unique ID for this outline item
  level: 1 | 2 | 3; // Heading level (h1/h2/h3)
  text: string; // Heading text content
  position: number; // Position in the document (for ordering)
  paragraphsAfter: number; // Number of paragraphs after this heading (before next heading or end)
}
