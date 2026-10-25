import { describe, expect, it, vi } from 'vitest'

// FORKFA161A5921: probeChannelPluginLiveness must hand the state-dir env scan to
// the decider (the decider is tested in liveness-envscan-fallback.test.ts); this
// pins the binding on a fake `ps`. The poller carries THIS process's pid, so the
// probe's kill(pid, 0) finds it alive.
const POLLER_PID = process.pid
const PS = [
  '  PID  PPID COMMAND',
  '70994     1 claude --channels plugin:telegram@claude-plugins-official',
  `${String(POLLER_PID).padStart(5)}     1 /Users/u/.bun/bin/bun server.ts`,
].join('\n')
let envScan = ''

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: (cmd: string, args: string[], opts: unknown) =>
      cmd === '/bin/ps' ? PS : (real.execFileSync as unknown as (c: string, a: string[], o: unknown) => string)(cmd, args, opts),
    execSync: (cmd: string, opts: unknown) =>
      cmd === '/bin/ps axeww' ? envScan : (real.execSync as unknown as (c: string, o: unknown) => string)(cmd, opts),
  }
})

const { probeChannelPluginLiveness } = await import('../channel-coordinator/liveness.js')
const { channelStateDir } = await import('../channel-provider.js')
const { agentDir } = await import('../web/agent-config.js')

const AGENT = 'liveness-envscan-probe-agent'
const row = (chanDir: string) =>
  `${String(POLLER_PID).padStart(5)} ??  S 0:01.00 /Users/u/.bun/bin/bun server.ts TELEGRAM_STATE_DIR=${chanDir} CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6`

describe('probeChannelPluginLiveness asks the state-dir env scan', () => {
  it('the wrapper is gone, the poller carries this agent\'s state dir: alive', () => {
    envScan = row(channelStateDir('telegram', agentDir(AGENT)))
    expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('alive')
  })
  it('...and with no such row: down', () => {
    envScan = row('/elsewhere/.claude/channels/telegram')
    expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('down')
  })
})
