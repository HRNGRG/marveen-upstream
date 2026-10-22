// Fleet freeze API (KILLSWITCH1022), the state lives in src/web/fleet-freeze.ts.
//
//   GET  /api/fleet/freeze     -> { frozen, state }
//   POST /api/fleet/freeze     { reason, mode?: 'freeze' | 'stop' } -> switch it on
//   POST /api/fleet/unfreeze   -> lift it
//
// Switching ON is open to every dashboard credential, an agent's token included:
// an agent that sees something going wrong may pull the brake itself, and a
// brake pulled by mistake costs a minute of the owner's time. Lifting it is the
// owner's: the SAME predicate that guards issuing credentials (mayIssueCredentials,
// routes/auth.ts, DEVKEYMINT1022), so an agent that went astray, or text that
// talked one into it, cannot unfreeze itself with the shared token. Before the
// first dashboard login exists the token is the only owner credential there is,
// and that predicate lets it through; the CLI-free way out is still deleting
// store/fleet-freeze.json on the machine.
import { MAIN_AGENT_ID } from '../../config.js'
import { logConfigChange } from '../../db.js'
import { logger } from '../../logger.js'
import { notifyOwner } from '../../notify.js'
import { listAgentNames } from '../agent-config.js'
import { agentHasChannel, isAgentRunning, startAgentProcess, stopAgentProcess } from '../agent-process.js'
import {
  REASON_MAX, clearFleetFreeze, readFleetFreeze, writeFleetFreeze,
  type FleetFreezeMode, type FleetFreezeState,
} from '../fleet-freeze.js'
import { json, readBody } from '../http-helpers.js'
import { mayIssueCredentials, OWNER_SESSION_REQUIRED } from './auth.js'
import type { RouteContext } from './types.js'

const BODY_MAX_BYTES = 4 * 1024
// A federation peer is somebody else's install: it never pulls our brake.
const FREEZE_KINDS = ['token', 'session', 'device'] as const

function actorOf(auth: RouteContext['auth']): string {
  if (!auth) return '?'
  if (auth.kind === 'session') return `session:${auth.user ?? '?'}`
  if (auth.kind === 'device') return `device:${auth.device ?? '?'}`
  return auth.agent ? `token:${auth.agent}` : 'token'
}

/** The sub-agents whose sessions run now (never the main agent). */
function runningSubAgents(): string[] {
  return listAgentNames().filter((n) => n !== MAIN_AGENT_ID && isAgentRunning(n))
}

export async function tryHandleFleetFreeze(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== '/api/fleet/freeze' && path !== '/api/fleet/unfreeze') return false

  if (path === '/api/fleet/freeze' && method === 'GET') {
    const state = readFleetFreeze()
    json(res, { frozen: state !== null, state })
    return true
  }

  if (path === '/api/fleet/freeze' && method === 'POST') {
    if (!auth || !(FREEZE_KINDS as readonly string[]).includes(auth.kind)) {
      json(res, { error: 'Forbidden for this credential type' }, 403)
      return true
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readBody(req, { maxBytes: BODY_MAX_BYTES })).toString() || '{}')
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason || reason.length > REASON_MAX) {
      json(res, { error: `reason is required (1-${REASON_MAX} characters): say why the fleet is being stopped` }, 400)
      return true
    }
    if (body.mode !== undefined && body.mode !== 'freeze' && body.mode !== 'stop') {
      json(res, { error: "mode must be 'freeze' or 'stop'" }, 400)
      return true
    }
    const mode: FleetFreezeMode = body.mode === 'stop' ? 'stop' : 'freeze'
    const prev = readFleetFreeze()
    // Already frozen: a second pull keeps the first reason and can only go up
    // ('freeze' -> 'stop'), never down; lifting is the unfreeze call's job.
    const state: FleetFreezeState = prev
      ? { ...prev, mode: prev.mode === 'stop' || mode === 'stop' ? 'stop' : 'freeze' }
      : { mode, reason, by: actorOf(auth), at: new Date().toISOString() }
    // The file first: from here on every tool call is refused and every loop
    // skips, so the stop below cannot race an agent that is being revived.
    writeFleetFreeze(state)
    if (state.mode === 'stop' && prev?.mode !== 'stop') {
      const stopped: string[] = []
      for (const name of runningSubAgents()) {
        const r = await stopAgentProcess(name)
        if (r.ok) stopped.push(name)
        else logger.warn({ agent: name, error: r.error }, 'fleet stop: agent did not stop')
      }
      state.stoppedAgents = [...(prev?.stoppedAgents ?? []), ...stopped]
      writeFleetFreeze(state)
    }
    logConfigChange('fleet.freeze', prev ? JSON.stringify(prev) : null, JSON.stringify(state), actorOf(auth))
    logger.warn({ mode: state.mode, by: actorOf(auth), reason }, 'FLEET FROZEN')
    if (!prev || prev.mode !== state.mode) {
      void notifyOwner(
        `🛑 A flotta ${state.mode === 'stop' ? 'LEÁLLÍTVA' : 'FAGYASZTVA'} (${actorOf(auth)}): ${reason}\n` +
        'Az ügynökök nem futtathatnak eszközt, a háttér-ciklusok állnak. Feloldás: dashboard, bejelentkezve.',
      ).catch(() => {})
    }
    json(res, { ok: true, frozen: true, state })
    return true
  }

  if (path === '/api/fleet/unfreeze' && method === 'POST') {
    if (!mayIssueCredentials(auth, req)) {
      json(res, OWNER_SESSION_REQUIRED, 403)
      return true
    }
    const prev = clearFleetFreeze()
    if (!prev) {
      json(res, { ok: true, frozen: false, restarted: [] })
      return true
    }
    const restarted: string[] = []
    for (const name of prev.stoppedAgents ?? []) {
      if (isAgentRunning(name)) continue
      // A channel agent needs a fresh start: a --continue resume does not load
      // the channel plugin (see the /start route).
      const r = await startAgentProcess(name, { fresh: agentHasChannel(name) })
      if (r.ok) restarted.push(name)
      else logger.warn({ agent: name, error: r.error }, 'fleet unfreeze: agent did not start')
    }
    logConfigChange('fleet.freeze', JSON.stringify(prev), null, actorOf(auth))
    logger.warn({ by: actorOf(auth), restarted }, 'FLEET UNFROZEN')
    void notifyOwner(`✅ A flotta feloldva (${actorOf(auth)}).${restarted.length ? ` Újraindítva: ${restarted.join(', ')}.` : ''}`).catch(() => {})
    json(res, { ok: true, frozen: false, restarted })
    return true
  }

  json(res, { error: 'Method not allowed' }, 405)
  return true
}
