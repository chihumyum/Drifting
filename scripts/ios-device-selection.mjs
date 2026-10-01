import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

export function availableIosDevices(payload) {
  if (payload.info?.outcome !== 'success' || !Array.isArray(payload.result?.devices)) {
    throw new Error('devicectl did not return a successful device list.');
  }
  const devices = new Map();
  for (const device of payload.result.devices) {
    // Xcode 27 uses properties; older Xcode versions use the *Properties fields.
    const hardware = device.properties?.hardware ?? device.hardwareProperties ?? {};
    const connection = device.properties?.connection ?? device.connectionProperties ?? {};
    const state = device.properties?.state ?? device.deviceProperties ?? {};
    const connectionState = connection.state ?? connection.tunnelState;
    if (hardware.reality !== 'physical' || !['iPhone', 'iPad'].includes(hardware.deviceType)
      || connection.pairingState !== 'paired'
      || !['connected', 'disconnected', 'available'].includes(connectionState)) continue;
    const identifier = hardware.udid || device.identifier;
    if (!identifier) continue;
    devices.set(identifier, {
      identifier,
      coreDeviceIdentifier: device.identifier,
      name: state.name || hardware.marketingName || hardware.deviceType,
      model: hardware.marketingName || hardware.deviceType,
    });
  }
  return [...devices.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.identifier.localeCompare(right.identifier));
}

export async function discoverIosDevices(execute, environment) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-ios-devices-'));
  try {
    const output = path.join(directory, 'devices.json');
    await execute('xcrun', ['devicectl', 'list', 'devices', '--timeout', '15', '--json-output', output], {
      environment, captureOutput: true,
    });
    return availableIosDevices(JSON.parse(await readFile(output, 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function selectIosDevice(devices, {
  requested = '',
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  input = process.stdin,
  output = process.stdout,
  prompt,
} = {}) {
  const candidates = requested ? devices.filter(device =>
    [device.identifier, device.coreDeviceIdentifier, device.name].includes(requested)) : devices;
  if (!candidates.length) {
    throw new Error(requested
      ? 'The requested iOS device is unavailable. Connect, unlock and trust it, then check --device.'
      : 'No available paired iPhone/iPad found. Connect and unlock your device, trust this Mac, and enable Developer Mode.');
  }
  if (candidates.length === 1) {
    output.write(`Selected iOS device: ${candidates[0].name} (${candidates[0].identifier})\n`);
    return candidates[0].identifier;
  }
  if (!interactive) {
    throw new Error('Multiple iOS devices match. Run in an interactive terminal to select one, or pass --device <identifier>.');
  }
  output.write('Select an iOS device for Release installation:\n');
  candidates.forEach((device, index) => output.write(
    `  ${index + 1}. ${device.name} — ${device.model} (${device.identifier})\n`,
  ));
  const terminal = prompt ? null : createInterface({ input, output });
  const controller = new AbortController();
  terminal?.once('SIGINT', () => controller.abort());
  terminal?.once('close', () => controller.abort());
  const ask = prompt ?? (question => terminal.question(question, { signal: controller.signal }));
  try {
    while (true) {
      const answer = (await ask(`Device [1-${candidates.length}, q to cancel]: `)).trim();
      if (!answer || /^q(?:uit)?$/iu.test(answer)) throw new Error('Device selection cancelled.');
      const index = /^\d+$/u.test(answer) ? Number(answer) - 1 : -1;
      if (Number.isSafeInteger(index) && index >= 0 && index < candidates.length) {
        return candidates[index].identifier;
      }
      output.write('Enter a listed device number, or q to cancel.\n');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Device selection cancelled.');
    throw error;
  } finally {
    terminal?.close();
  }
}
