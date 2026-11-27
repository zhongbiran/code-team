import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve plugin root strictly from PLUGIN_ROOT or relative to this script.
 * Never guess host directories via "../../".
 */
export function resolvePluginRoot() {
  if (process.env.PLUGIN_ROOT && fs.existsSync(process.env.PLUGIN_ROOT)) {
    return path.resolve(process.env.PLUGIN_ROOT);
  }
  return path.resolve(__dirname, '..');
}

/**
 * Resolve persistent plugin data directory.
 * Antigravity injects PLUGIN_DATA for installed plugins; fallback cleanly to
 * ~/.gemini/antigravity/plugin-data/code-team-agy when invoked standalone via CLI.
 */
export function resolvePluginDataDir() {
  if (process.env.PLUGIN_DATA) {
    fs.mkdirSync(process.env.PLUGIN_DATA, { recursive: true });
    return path.resolve(process.env.PLUGIN_DATA);
  }
  if (process.env.CODE_TEAM_AGY_DATA_DIR) {
    fs.mkdirSync(process.env.CODE_TEAM_AGY_DATA_DIR, { recursive: true });
    return path.resolve(process.env.CODE_TEAM_AGY_DATA_DIR);
  }
  const fallback = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin-data', 'code-team-agy');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function loadTeamConfig() {
  const root = resolvePluginRoot();
  const configPath = path.join(root, 'config', 'team.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function getEventsFilePath() {
  return path.join(resolvePluginDataDir(), 'events.jsonl');
}

export function getBriefsDir() {
  const dir = path.join(resolvePluginDataDir(), 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getStateFilePath(name) {
  const dir = path.join(resolvePluginDataDir(), 'state');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
