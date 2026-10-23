// CHANNELSDUP1023: is a scripts/channels.sh supervisor already running for this install?
//
// Measured 2026-10-22 13:10 (and 10-19 12:06, 10-21 13:10 in the same log): the context
// guard's hard restart bounced the launchd job, launchd started a fresh channels.sh, and
// that supervisor kill-sessioned and rebuilt the main session. For those seconds the pane
// was unreadable, the dashboard's 8 s effect poll read pidAfter = null, took that for "no
// effect", fell through and launched a SECOND channels.sh itself (detached, PPID 1). Two
// supervisors then watched one session until the next restart.
//
// The answer here is read from `ps`, not from a pid file: a supervisor that died without
// cleaning up must not block a recreate, and one started outside the dashboard (launchd,
// systemd, start.sh) must still be seen.
import { execFileSync } from 'node:child_process'

export interface ChannelsSupervisor {
  pid: number
  /** Seconds since the process started (ps etime). */
  elapsedSec: number
}

/** Pure: ps etime ([[dd-]hh:]mm:ss) as seconds, or null when it does not parse. */
export function etimeSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!m) return null
  const [, d, h, min, s] = m
  return (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(s)
}

/**
 * Pure: the long-lived supervisors in `ps -axo pid=,etime=,args=` output. A supervisor is
 * the script run with NO arguments; channels.sh's test and helper seams (--resolve-main-model,
 * --bot-owner-check, ...) take arguments and are short-lived, so they never count.
 */
export function supervisorsFromPs(psOut: string, script: string): ChannelsSupervisor[] {
  const out: ChannelsSupervisor[] = []
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line)
    if (!m) continue
    const args = m[3].split(/\s+/)
    const interpreter = args[0]?.split('/').pop()
    const isSupervisor = args.length === 2 && (interpreter === 'bash' || interpreter === 'sh') && args[1] === script
    if (!isSupervisor) continue
    const elapsedSec = etimeSeconds(m[2])
    if (elapsedSec === null) continue
    out.push({ pid: Number(m[1]), elapsedSec })
  }
  return out
}

/** The running supervisors of `script`; an empty list when ps cannot be read (fail-open: the caller may start one). */
export function runningChannelsSupervisors(script: string): ChannelsSupervisor[] {
  try {
    const psOut = execFileSync('/bin/ps', ['-axo', 'pid=,etime=,args='], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
    return supervisorsFromPs(psOut, script)
  } catch {
    return []
  }
}

/** Pure: a supervisor started within the last `withinSec` seconds (one launchd spawned for this reload), or null. */
export function freshSupervisor(list: readonly ChannelsSupervisor[], withinSec: number): ChannelsSupervisor | null {
  return list.find((s) => s.elapsedSec <= withinSec) ?? null
}

/**
 * Pure: what a launchd reload of the channels job did, read from the pane pid before and
 * after, and from a channels.sh supervisor started since the reload (its pid, or null).
 * 'rebuilt': a different claude is in the pane. 'rebuilding': the pane is unreadable, but a
 * supervisor launchd started for this reload is tearing the session down and building it
 * again. 'none': nothing shows the reload did anything, so the caller falls back.
 */
export function launchdReloadVerdict(pidBefore: number | null, pidAfter: number | null, freshSupervisorPid: number | null): 'rebuilt' | 'rebuilding' | 'none' {
  if (pidBefore !== null && pidAfter !== null && pidBefore !== pidAfter) return 'rebuilt'
  if (pidBefore !== null && pidAfter === null && freshSupervisorPid !== null) return 'rebuilding'
  return 'none'
}

/** The window a supervisor must fall in to belong to a reload begun at `reloadAt` (ms): the time since, rounded up, plus a second of slack. */
export function reloadWindowSec(reloadAt: number, now: number): number {
  return Math.ceil((now - reloadAt) / 1000) + 1
}
