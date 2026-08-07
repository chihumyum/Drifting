export interface EntityStatsTarget {
  kind: 'chapter' | 'storyline' | 'element' | 'category' | 'drift' | 'all-chapters' | 'none';
  id: string | null;
  title: string;
  kicker: string;
  color?: string;
}
