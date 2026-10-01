#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IOS_DEVICE_DEBUG_USAGE,
  createIosDevicePlan,
  installIosDevice,
  parseIosDeviceArguments,
} from './install-ios-device.mjs';

export { IOS_DEVICE_DEBUG_USAGE };
export const parseIosDeviceDebugArguments = (args, environment) =>
  parseIosDeviceArguments(args, environment, 'debug');
export const createIosDeviceDebugPlan = (options = {}) =>
  createIosDevicePlan({ ...options, profile: 'debug' });
export const installIosDebugDevice = (args, dependencies = {}) =>
  installIosDevice(args, { ...dependencies, profile: 'debug' });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installIosDebugDevice().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(IOS_DEVICE_DEBUG_USAGE);
    process.exitCode = 1;
  });
}
