#!/usr/bin/env node
// Read telemetry / label an operation. This tool never operates the App UI.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [directory, command = 'status', value] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node scripts/native-performance-audit.mjs <profile/performance-audit> [status|mark <label>|summarize <output.json>]');
if (command === 'summarize') {
  const source = JSON.parse(readFileSync(path.join(directory, 'source.json'), 'utf8'));
  const since = Date.parse(source.recordedAt);
  const samples = readFileSync(path.join(directory, 'samples.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(s => s.receivedAt >= since);
  const groups = new Map();
  for (const sample of samples) {
    const group = groups.get(sample.marker) ?? { samples: [], components: new Map() };
    group.samples.push(sample);
    for (const component of sample.componentRenders) {
      const item = group.components.get(component.name) ?? { name: component.name, renders: 0, selfMs: 0, maxSelfMs: 0 };
      item.renders += component.renders; item.selfMs += component.selfMs; item.maxSelfMs = Math.max(item.maxSelfMs, component.maxSelfMs);
      group.components.set(component.name, item);
    }
    groups.set(sample.marker, group);
  }
  const metrics = ['frameGaps', 'inputToTwoRaf', 'timerDelay', 'reactCommits', 'longTasks'];
  const round = value => Math.round(value * 100) / 100;
  const manifest = JSON.parse(readFileSync(path.join(directory, '..', 'profile.json'), 'utf8'));
  const binary = path.join(manifest.cargoTargetDirectory, 'debug', 'drifting');
  const processSamples = existsSync(path.join(directory, 'processes.jsonl')) ? readFileSync(path.join(directory, 'processes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(s => s.at >= since) : [];
  const report = { kind: 'native_stress_seed_ui_audit', schemaVersion: 1, generatedAt: new Date().toISOString(),
    status: 'observations-only-coverage-must-be-reviewed', source,
    artifact: { mode: 'current-isolated-debug', sha256: createHash('sha256').update(readFileSync(binary)).digest('hex') },
    observations: { samples: samples.length, visibleSamples: samples.filter(s => s.visible).length,
      inputSamples: samples.reduce((n, s) => n + s.inputToTwoRaf.count, 0), processSamples: processSamples.length },
    measurement: { build: 'debug-vite-react-strict-mode', endpoint: 'input dispatch to second requestAnimationFrame; not compositor presentation',
      componentTimings: 'React 19 development Fiber metadata; top 30 by self time per sample; render phase only',
      overhead: 'observerMs measures the Fiber walk; snapshotMs measures snapshot creation; neither accounts for all instrumentation overhead',
      memory: 'recorded separately from OS samples; no JavaScript heap API assumption', supportedEntries: samples[0]?.supportedEntries },
    phases: [...groups].map(([marker, group]) => ({ marker, samples: group.samples.length,
      firstAt: Math.min(...group.samples.map(s => s.at)), lastAt: Math.max(...group.samples.map(s => s.at)),
      metrics: Object.fromEntries(metrics.map(key => {
        const buckets = group.samples.filter(s => s.visible).map(s => s[key]);
        const values = buckets.flatMap(b => b.values).sort((a, b) => a - b);
        return [key, { count: buckets.reduce((n, b) => n + b.count, 0), retained: values.length,
          dropped: buckets.reduce((n, b) => n + b.dropped, 0), p50: values.length ? values[Math.ceil(values.length * .5) - 1] : null,
          p95: values.length ? values[Math.ceil(values.length * .95) - 1] : null,
          max: round(Math.max(0, ...buckets.map(b => b.max))), over50: buckets.reduce((n, b) => n + b.over50, 0),
          over100: buckets.reduce((n, b) => n + b.over100, 0), over1000: buckets.reduce((n, b) => n + b.over1000, 0) }];
      })),
      dom: { first: group.samples[0].dom, last: group.samples.at(-1).dom,
        maxElements: Math.max(...group.samples.map(s => s.dom.elements)), maxEditors: Math.max(...group.samples.map(s => s.dom.editors)) },
      mutations: group.samples.reduce((sum, s) => sum + Object.values(s.mutations).reduce((a, b) => a + b, 0), 0),
      commitErrors: group.samples.reduce((n, s) => n + s.commitErrors, 0), errors: group.samples.flatMap(s => s.errors),
      observerMs: round(group.samples.reduce((n, s) => n + s.observerMs, 0)),
      snapshotMs: round(group.samples.reduce((n, s) => n + s.snapshotMs, 0)),
      components: [...group.components.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 20).map(c => ({ ...c, selfMs: round(c.selfMs), maxSelfMs: round(c.maxSelfMs) })),
      processes: ['native', 'web-content'].map(role => {
        const observations = processSamples.filter(s => s.marker === marker).flatMap(s => s.processes.filter(p => p.role === role));
        return { role, samples: observations.length, firstRssKiB: observations[0]?.rssKiB ?? null, lastRssKiB: observations.at(-1)?.rssKiB ?? null,
          peakRssKiB: observations.length ? Math.max(...observations.map(o => o.rssKiB)) : null,
          maxCpuPercent: observations.length ? Math.max(...observations.map(o => o.cpuPercent)) : null };
      }),
      ipc: (() => {
        const commands = new Map();
        for (const s of group.samples) for (const item of s.ipc ?? []) {
          const aggregate = commands.get(item.command) ?? { command: item.command, calls: 0, failures: 0, durationMs: 0, maxMs: 0, rows: 0, stringChars: 0 };
          aggregate.calls += item.calls; aggregate.failures += item.failures; aggregate.durationMs += item.durationMs;
          aggregate.maxMs = Math.max(aggregate.maxMs, item.maxMs); aggregate.rows += item.rows; aggregate.stringChars += item.stringChars;
          commands.set(item.command, aggregate);
        }
        return [...commands.values()].sort((a, b) => b.durationMs - a.durationMs).map(c => ({ ...c, durationMs: round(c.durationMs), maxMs: round(c.maxMs) }));
      })(),
    })) };
  const json = JSON.stringify(report, null, 2);
  if (value) writeFileSync(value, `${json}\n`);
  else console.log(json);
} else {
  const control = JSON.parse(readFileSync(path.join(directory, 'control.json'), 'utf8'));
  const response = await fetch(`${control.endpoint}/${command === 'mark' ? 'mark' : 'status'}`, {
    method: command === 'mark' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    ...(command === 'mark' ? { body: JSON.stringify({ marker: value }) } : {}),
  });
  if (!response.ok) throw new Error(`Collector returned ${response.status}`);
  const result = await response.json();
  if (command === 'status' && result.latest) {
    const latest = result.latest;
    console.log(JSON.stringify({ marker: result.marker, samples: result.samples, latest: { at: latest.at, visible: latest.visible, focused: latest.focused,
      dom: latest.dom, frameMax: latest.frameGaps.max, inputMax: latest.inputToTwoRaf.max, commits: latest.reactCommits.count,
      commitMax: latest.reactCommits.max, components: latest.componentRenders.slice(0, 8), errors: latest.errors } }, null, 2));
  } else console.log(JSON.stringify(result));
}
