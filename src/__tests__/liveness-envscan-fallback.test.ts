// FORKFA161A5921, after Argos's fa161a5 (2026-06-18 restart-thrash incident):
// the long-lived channel poller is `bun server.ts` (the bot.pid process), an
// argv with no provider slug. The argv-based tree walk only sees it through the
// short-lived `bun run --cwd .../telegram/<ver> ... start` wrapper; once that
// wrapper has exited, the tree walk and the bot.pid argv match both miss the
// still-running poller, and the monitor restarts the agent on a false "down".
// The poller still carries `<PROVIDER>_STATE_DIR=<chanDir>` and
// CLAUDE_PLUGIN_ROOT in its environment: the fallback reads those, with the
// reaper's own markers (stateDirPluginPollerPids).

import { describe, it, expect } from 'vitest'
import { decideHasPluginAlive } from '../channel-coordinator/liveness.js'
import { stateDirPluginPollerPids } from '../web/channel-poller-reap.js'

const CHAN_DIR = '/Users/u/projects/marveen/agents/argos/.claude/channels/telegram'
const TG_ROOT = '/Users/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6'
const ALIVE = () => true
const DEAD = () => false

// `ps axeww` rows: `PID TTY STAT TIME COMMAND <env k=v k=v ...>`.
function envRow(pid: number, command: string, env: Record<string, string>): string {
  const envStr = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')
  return `${String(pid).padStart(5)} ??  S      0:01.00 ${command} ${envStr}`
}

// `ps -axww -o pid,ppid,command` after the wrapper exited: the claude, and its
// poller reparented to launchd with an argv that names no provider.
const PS_WRAPPER_GONE = [
  '  PID  PPID COMMAND',
  '70994     1 claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official',
  '71046     1 /Users/u/.bun/bin/bun server.ts',
].join('\n')

const POLLER = envRow(71046, '/Users/u/.bun/bin/bun server.ts', { TELEGRAM_STATE_DIR: CHAN_DIR, CLAUDE_PLUGIN_ROOT: TG_ROOT, HOME: '/Users/u' })

function decide(psEww: string, isPidAlive = ALIVE, strictTree = false): boolean {
  return decideHasPluginAlive({
    psOutput: PS_WRAPPER_GONE,
    claudePid: 70994,
    providerType: 'telegram',
    botPid: 71046,
    isPidAlive,
    strictTree,
    stateDirPollerPids: () => stateDirPluginPollerPids('telegram', CHAN_DIR, psEww),
  })
}

describe('the state-dir env scan finds a poller whose wrapper has exited', () => {
  it('without the fallback the live `bun server.ts` poller reads as down (the gap)', () => {
    expect(decideHasPluginAlive({ psOutput: PS_WRAPPER_GONE, claudePid: 70994, providerType: 'telegram', botPid: 71046, isPidAlive: ALIVE })).toBe(false)
  })

  it('with it, the poller is found by its own state dir and plugin root', () => {
    expect(decide(POLLER)).toBe(true)
  })

  it('a matched poller pid that is dead is not alive', () => {
    expect(decide(POLLER, DEAD)).toBe(false)
  })

  it('the agent\'s own claude (it exports the state dir too, no plugin root) is not a poller', () => {
    expect(decide(envRow(70994, 'claude --channels plugin:telegram@claude-plugins-official', { TELEGRAM_STATE_DIR: CHAN_DIR }))).toBe(false)
  })

  it('a background `node server.ts` job of the agent (state dir inherited, no plugin root) is not a poller', () => {
    expect(decide(envRow(80001, 'node server.ts', { TELEGRAM_STATE_DIR: CHAN_DIR }))).toBe(false)
  })

  it('another agent\'s poller, and a sibling dir with the same prefix, do not count', () => {
    const other = '/Users/u/projects/marveen/agents/wozniak/.claude/channels/telegram'
    expect(decide(envRow(49722, '/Users/u/.bun/bin/bun server.ts', { TELEGRAM_STATE_DIR: other, CLAUDE_PLUGIN_ROOT: TG_ROOT }))).toBe(false)
    expect(decide(envRow(49723, '/Users/u/.bun/bin/bun server.ts', { TELEGRAM_STATE_DIR: `${CHAN_DIR}-old`, CLAUDE_PLUGIN_ROOT: TG_ROOT }))).toBe(false)
  })

  it('another provider\'s plugin with this state dir does not make telegram alive', () => {
    const slackRoot = '/Users/u/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0'
    expect(decide(envRow(71100, 'node server.ts', { TELEGRAM_STATE_DIR: CHAN_DIR, CLAUDE_PLUGIN_ROOT: slackRoot }))).toBe(false)
  })

  it('strictTree never asks the env scan (only the session\'s own tree counts there, #1762)', () => {
    let asked = false
    const alive = decideHasPluginAlive({
      psOutput: PS_WRAPPER_GONE, claudePid: 70994, providerType: 'telegram', botPid: 71046, isPidAlive: ALIVE, strictTree: true,
      stateDirPollerPids: () => { asked = true; return [71046] },
    })
    expect(alive).toBe(false)
    expect(asked).toBe(false)
  })

  it('a poller found in the tree never runs the env scan', () => {
    let asked = false
    const ps = `${PS_WRAPPER_GONE}\n71037 70994 bun run --cwd ${TG_ROOT} --shell=bun --silent start`
    const alive = decideHasPluginAlive({
      psOutput: ps, claudePid: 70994, providerType: 'telegram', botPid: 71046, isPidAlive: ALIVE,
      stateDirPollerPids: () => { asked = true; return [] },
    })
    expect(alive).toBe(true)
    expect(asked).toBe(false)
  })
})
