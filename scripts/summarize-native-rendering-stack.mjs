// Metadata-only synopsis of private native samples from one recorded session.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [directory, beforePath, output] = process.argv.slice(2);
if (!directory || !beforePath || !output) throw new Error('Usage: <sample-directory> <native-report> <output>');
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const start = Date.parse(before.source.recordedAt), end = Date.parse(before.generatedAt);
const samples = readdirSync(directory).filter(file => file.endsWith('.txt')).flatMap(file => {
  const target = path.join(directory, file), modified = statSync(target).mtimeMs;
  if (modified < start || modified > end) return [];
  const bytes = readFileSync(target), source = bytes.toString('utf8');
  return [{ sha256: createHash('sha256').update(bytes).digest('hex'), signals: {
    renderingUpdate: /RemoteLayerTreeDrawingArea::updateRendering/.test(source),
    layout: /WebCore::Document::updateLayout/.test(source), styleResolution: /TreeResolver::resolve/.test(source),
    ruleMatching: /ElementRuleCollector::collectMatchingRules/.test(source),
    json: /jsonProtoFuncParse|jsonProtoFuncStringify/.test(source), gc: /JSC::Heap::collect|MarkedBlock::Handle::sweep/.test(source),
  } }];
});
writeFileSync(output, JSON.stringify({ kind: 'native_rendering_stack_signals', generatedAt: new Date().toISOString(),
  reportSha256: createHash('sha256').update(readFileSync(beforePath)).digest('hex'), samples,
  limits: ['Samples span recovery. Signals establish presence only, not proportions, root cause or forced-layout counts. No paths, messages, text or raw stacks are exported.'] }, null, 2) + '\n');
console.log(JSON.stringify({ samples: samples.length }));
