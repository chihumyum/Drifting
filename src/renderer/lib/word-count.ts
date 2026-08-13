/**
 * Compatibility facade for the canonical prose-metric contract shared by the
 * renderer and Server. Existing imports stay stable while the implementation
 * has one owner in @drifting/prose-metrics.
 */
export {
  countWords,
  countWordsInPmJson,
  deriveProseMetric,
  deriveProseMetricFromJson,
  extractProseText,
  hashProseDocument,
  type ProseMetric,
  type ProseMetricBasisKind,
} from '@drifting/prose-metrics';
