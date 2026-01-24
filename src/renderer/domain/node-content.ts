export interface NodeContent {
  nodeId: string;
  contentJson: string;
  outlineJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutlineItem {
  id: string;              // Unique ID for this outline item
  level: 1 | 2 | 3;        // Heading level (h1/h2/h3)
  text: string;            // Heading text content
  position: number;        // Position in the document (for ordering)
  paragraphsAfter: number; // Number of paragraphs after this heading (before next heading or end)
  summary: string;        // Optional summary for this heading section
}
