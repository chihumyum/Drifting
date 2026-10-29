#!/usr/bin/env node
// macOS process RSS/CPU telemetry for the two PIDs attested by this owned App.
// Does not read other apps, manipulate their UI, or claim RSS is JS heap size.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [directory] = process.argv.slice(2);
if (!directory || process.platform !== 'darwin') throw new Error('Usage on macOS: node scripts/native-performance-process-sampler.mjs <profile/performance-audit>');
const control = JSON.parse(readFileSync(path.join(directory, 'control.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(directory, '..', 'profile.json'), 'utf8'));
const artifactFile = path.join(directory, 'artifact.json');
const binary = existsSync(artifactFile) ? JSON.parse(readFileSync(artifactFile, 'utf8')).binaryPath : path.join(manifest.cargoTargetDirectory, 'debug', 'drifting');
let stop = false;
process.once('SIGINT', () => { stop = true; });
process.once('SIGTERM', () => { stop = true; });
while (!stop) {
  try {
    const response = await fetch(`${control.endpoint}/status`, { headers: { Authorization: `Bearer ${control.token}` }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Collector ${response.status}`);
    const status = await response.json();
    const info = status.latest?.nativeProcesses;
    if (info?.nativePid > 0 && info.webContentPid > 0) {
      const text = execFileSync('/bin/ps', ['-p', `${info.nativePid},${info.webContentPid}`, '-o', 'pid=,pcpu=,rss=,etime=,comm='], { encoding: 'utf8' });
      const processes = text.trim().split('\n').map(line => {
        const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) throw new Error('Unrecognized ps output');
        const [, pid, cpu, rss, elapsed, command] = match;
        const role = Number(pid) === info.nativePid ? 'native' : 'web-content';
        if ((role === 'native' && command !== binary) || (role === 'web-content' && !command.endsWith('/com.apple.WebKit.WebContent'))) {
          throw new Error('Process identity changed; refuse unrelated sampling');
        }
        return { role, pid: Number(pid), cpuPercent: Number(cpu), rssKiB: Number(rss), elapsed };
      });
      appendFileSync(path.join(directory, 'processes.jsonl'), `${JSON.stringify({ at: Date.now(), marker: status.marker, visible: status.latest.visible, processes })}\n`, { mode: 0o600 });
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Sampling failed'); }
  await delay(2000);
}
