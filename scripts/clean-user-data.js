#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const pkgPath = path.join(__dirname, "..", "package.json");
let appName = "drifting-electron";
let productName = "Drifting";

try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  appName = pkg.name || appName;
  productName = pkg.productName || productName;
} catch (error) {
  // If we can't read package.json, fall back to defaults.
  console.warn("[clean-user-data] Failed to read package.json:", error);
}

const candidates = Array.from(new Set([appName, productName].filter(Boolean)));

let baseDir;
if (process.platform === "darwin") {
  baseDir = path.join(os.homedir(), "Library", "Application Support");
} else if (process.platform === "win32") {
  baseDir = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
} else {
  baseDir = path.join(os.homedir(), ".config");
}

const removed = [];
for (const name of candidates) {
  const dir = path.join(baseDir, name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
}

if (removed.length === 0) {
  console.log("[clean-user-data] No user data folders found to remove.");
} else {
  console.log("[clean-user-data] Removed user data:");
  for (const dir of removed) {
    console.log(`- ${dir}`);
  }
}
