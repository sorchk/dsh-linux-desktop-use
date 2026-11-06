/**
 * Runtime settings for the Linux computer-use plugin.
 *
 * Resolution order (highest priority first):
 *   1. values passed by the harness bundle patch (`config` argument)
 *   2. DSH_LINUX_* environment variables
 *   3. ~/.config/dsh/linux-computer-use.json (re-read on every call)
 *   4. auto-detection from the running X11 session
 *
 * Keys:
 *   display        — X display to drive (e.g. ":1")
 *   xauthority     — path to the Xauthority cookie file
 *   approvalMode   — "all" | "dangerous" | "off" (how chatty the approval gate is)
 *   requireApproval— legacy boolean; true ⇒ approvalMode "all", false ⇒ "off"
 *   ttlMs          — how long an observation screenshot stays valid
 *   allowedWindows — optional allowlist of window-title substrings
 *   timeoutMs      — per command timeout
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectDisplay, detectXauthority } from './x11.js'

/** Settings keys the plugin understands; anything else is refused on write. */
export const SETTINGS_KEYS = [
  'display',
  'xauthority',
  'approvalMode',
  'requireApproval',
  'ttlMs',
  'allowedWindows',
  'timeoutMs',
]

/** Default location of the optional JSON settings file. */
export function settingsPath(env = process.env) {
  return env.DSH_LINUX_CONFIG ?? join(env.HOME ?? homedir(), '.config', 'dsh', 'linux-computer-use.json')
}

/** Read the JSON settings file; unreadable or malformed files are ignored. */
export function readSettingsFile(env = process.env) {
  const path = settingsPath(env)
  try {
    if (!existsSync(path)) return { path, values: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { path, values: {} }
    return { path, values: parsed }
  } catch {
    return { path, values: {} }
  }
}

/**
 * Merge the given values into the settings file and persist it.
 * Only known keys are written; unknown keys are reported back to the caller.
 * @param values - the values to store.
 * @param env - the environment holding HOME / DSH_LINUX_CONFIG.
 * @returns the stored values plus the keys that were refused.
 */
export function writeSettingsFile(values = {}, env = process.env) {
  const path = settingsPath(env)
  const current = readSettingsFile(env).values
  const accepted = {}
  const rejected = []
  for (const [key, value] of Object.entries(values)) {
    if (!SETTINGS_KEYS.includes(key)) {
      rejected.push(key)
      continue
    }
    if (value === null || value === undefined || value === '') {
      delete current[key]
      continue
    }
    accepted[key] = value
    current[key] = value
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  return { path, values: current, accepted, rejected }
}

function firstDefined(...candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate
  }
  return undefined
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  }
  return undefined
}

const APPROVAL_MODES = new Set(['all', 'dangerous', 'off'])

function toApprovalMode(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return APPROVAL_MODES.has(normalized) ? normalized : undefined
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.map(entry => String(entry).trim()).filter(entry => entry.length > 0)
  }
  if (typeof value === 'string') {
    return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  }
  return undefined
}

/**
 * Resolve the effective settings for one tool call.
 * @param config - the configuration object handed to `apply(ctx, config)`, if any.
 * @param env - the environment to detect the X session from.
 * @returns the effective settings.
 */
export function resolveSettings(config = {}, env = process.env) {
  const file = readSettingsFile(env)
  const values = file.values
  const display = firstDefined(
    config.display,
    env.DSH_LINUX_DISPLAY,
    values.display,
    detectDisplay(env),
  )
  const xauthority = firstDefined(
    config.xauthority,
    env.DSH_LINUX_XAUTHORITY,
    values.xauthority,
    detectXauthority(env),
  )

  const requireApproval = firstDefined(
    toBoolean(config.requireApproval),
    toBoolean(env.DSH_LINUX_REQUIRE_APPROVAL),
    toBoolean(values.requireApproval),
    undefined,
  )
  // Explicit approvalMode wins; otherwise the legacy boolean decides.
  const approvalMode = firstDefined(
    toApprovalMode(config.approvalMode),
    toApprovalMode(env.DSH_LINUX_APPROVAL_MODE),
    toApprovalMode(values.approvalMode),
    requireApproval === true ? 'all' : undefined,
    requireApproval === false ? 'off' : undefined,
    'all',
  )

  const ttlMs = Number(
    firstDefined(config.ttlMs, env.DSH_LINUX_TTL_MS, values.ttlMs, 30000),
  )

  const timeoutMs = Number(
    firstDefined(config.timeoutMs, env.DSH_LINUX_TIMEOUT_MS, values.timeoutMs, 20000),
  )

  const allowedWindows = firstDefined(
    toStringList(config.allowedWindows),
    toStringList(env.DSH_LINUX_ALLOWED_WINDOWS),
    toStringList(values.allowedWindows),
    [],
  )

  return {
    display: display ?? '',
    xauthority: xauthority ?? '',
    approvalMode,
    // Kept for the status tool and for backwards compatibility.
    requireApproval: approvalMode !== 'off',
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30000,
    allowedWindows,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
    configPath: file.path,
  }
}
