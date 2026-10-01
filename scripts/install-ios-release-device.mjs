#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IOS_DEVICE_RELEASE_USAGE,
  createIosDevicePlan,
  installIosDevice,
  parseIosDeviceArguments,
} from './install-ios-device.mjs';

export { IOS_DEVICE_RELEASE_USAGE };
export const parseIosDeviceReleaseArguments = (args, environment) =>
  parseIosDeviceArguments(args, environment, 'release');
export const createIosDeviceReleasePlan = (options = {}) =>
  createIosDevicePlan({ ...options, profile: 'release' });
export const installIosReleaseDevice = (args, dependencies = {}) =>
  installIosDevice(args, { ...dependencies, profile: 'release' });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installIosReleaseDevice().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(IOS_DEVICE_RELEASE_USAGE);
    process.exitCode = 1;
  });
}
