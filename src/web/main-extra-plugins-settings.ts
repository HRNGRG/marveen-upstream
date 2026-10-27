/**
 * The main agent's co-listen plugins are enabled through a launch-time
 * --settings file, never through a settings layer the sub-agents also read.
 * Twin of scripts/main-extra-plugins-settings.sh (same file, same content);
 * see its header for the measurement (SLACKDMVESZT1006).
 *
 * The same file carries the main agent's sender-role gate when
 * store/main-agent-config.json sets `senderRoleGate` (MIOAPPTEAMSRV1025): the
 * main session serves its owner and a team chat (gromzo, MXD_SCOPE=both) in
 * one session, and a launch flag is the one place only the main session reads.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { senderRoleGatePolicyArg } from './agent-config.js'
import { pythonHookCommand } from './agent-scaffold.js'

export function mainExtraPluginsSettingsPath(installDir: string): string {
  return join(installDir, 'store', '.main-extra-plugins.settings.json')
}

/** The main agent's own agent-config.json counterpart (gitignored, per install). */
export function mainAgentConfigPath(installDir: string): string {
  return join(installDir, 'store', 'main-agent-config.json')
}

/** The gate's --policy for the main agent, or null (no file, not JSON, or the gate off). */
export function readMainSenderRoleGatePolicy(installDir: string): string | null {
  try {
    return senderRoleGatePolicyArg(JSON.parse(readFileSync(mainAgentConfigPath(installDir), 'utf-8')))
  } catch {
    return null
  }
}

/** The PreToolUse entry: the same fail-closed command shape as the tracked project hooks. */
export function mainSenderRoleGateEntry(policy: string): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> } {
  const command = pythonHookCommand('$CLAUDE_PROJECT_DIR/scripts/hooks/sender-role-gate.py', ['--policy', policy])
  return { matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }
}

type MainSettings = { enabledPlugins: Record<string, true>; hooks?: { PreToolUse: Array<ReturnType<typeof mainSenderRoleGateEntry>> } }

/** Pure: the settings object the flag file carries. */
export function mainExtraPluginsSettings(pluginIds: readonly string[], gatePolicy: string | null = null): MainSettings {
  const enabledPlugins: Record<string, true> = {}
  for (const id of pluginIds) if (id) enabledPlugins[id] = true
  return gatePolicy ? { enabledPlugins, hooks: { PreToolUse: [mainSenderRoleGateEntry(gatePolicy)] } } : { enabledPlugins }
}

/**
 * Write the file and return its path, or null when there are no extras and no
 * gate (the launch then carries no flag at all). A write failure returns null
 * too: the session still starts, as it did before this flag existed.
 */
export function writeMainExtraPluginsSettings(installDir: string, pluginIds: readonly string[]): string | null {
  const ids = pluginIds.filter(Boolean)
  const policy = readMainSenderRoleGatePolicy(installDir)
  if (ids.length === 0 && !policy) return null
  const path = mainExtraPluginsSettingsPath(installDir)
  try {
    mkdirSync(join(installDir, 'store'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(mainExtraPluginsSettings(ids, policy), null, 2) + '\n')
    renameSync(tmp, path)
    return path
  } catch {
    return null
  }
}
