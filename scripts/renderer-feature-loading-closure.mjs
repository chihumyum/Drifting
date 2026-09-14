import assert from 'node:assert/strict';

// Feature entry retry keys need only cover the entry: their shared dependencies
// are already available after the route-code gate, before feature demand/preload.
// Older eager-route reports have no route chunk and retain their original rule.
export function featureLoadingClosure(chunks) {
  const files = new Set();
  const visit = file => {
    if (files.has(file)) return;
    const chunk = chunks.find(item => item.file === file); assert(chunk, `Unknown dependency: ${file}`);
    files.add(file); chunk.imports.forEach(visit);
  };
  chunks.filter(chunk => chunk.initial || chunk.facade === 'src/renderer/app/project-route-components.tsx').forEach(chunk => visit(chunk.file));
  return { files, css: new Set(chunks.filter(chunk => files.has(chunk.file)).flatMap(chunk => chunk.css)) };
}
