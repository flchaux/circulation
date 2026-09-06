/**
 * Point d'entrée du Web Worker (§5.8 de docs/ARCHITECTURE.md).
 *
 * `EngineHost` contient toute la logique de cadence et de messages ; elle est exportée pour pouvoir être
 * testée hors Worker (environnement node). Le module ne s'accroche à `self` que s'il tourne réellement
 * dans un Worker.
 */
import type { FromWorker, SimStatus, ToWorker } from './protocol'
import { Simulation } from './simulation'

/** Nombre maximal de pas exécutés par tour de boucle en mode cadencé. */
const MAX_STEPS_PER_TURN = 200
/** Intervalle réel minimal entre deux frames en mode cadencé (ms). */
const FRAME_INTERVAL_MS = 50
/** Durée d'un tour en calcul rapide (ms). */
const FAST_TURN_MS = 250
/** Période d'émission du message `status` (ms). */
const STATUS_INTERVAL_MS = 1000

export interface HostTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
}

const defaultTimers: HostTimers = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (h) => clearTimeout(h),
}

export class EngineHost {
  private sim: Simulation | null = null
  private status: SimStatus = 'idle'
  private speed = 1
  private fast = false
  private timer: number | null = null
  private lastTick = 0
  private stepDebt = 0
  private lastFrame = 0
  private lastStatus = 0
  private stepsSinceStatus = 0
  private stepsPerSecond = 0
  private lastIntervals = 0

  constructor(
    private readonly post: (msg: FromWorker, transfer?: Transferable[]) => void,
    private readonly timers: HostTimers = defaultTimers,
  ) {}

  handle(msg: ToWorker): void {
    try {
      switch (msg.type) {
        case 'init': {
          this.stop()
          this.sim = new Simulation(msg.payload)
          this.lastIntervals = this.sim.intervalsClosed
          this.post({ type: 'ready', edgeIndex: this.sim.edgeIndex, endTime: this.sim.endTime, warnings: this.sim.warnings })
          this.sendFrame()
          this.setStatus(this.sim.done ? 'done' : 'idle')
          break
        }
        case 'run':
          this.speed = clampSpeed(msg.speed)
          this.fast = false
          this.start()
          break
        case 'runFast':
          this.fast = true
          this.start()
          break
        case 'setSpeed':
          this.speed = clampSpeed(msg.speed)
          break
        case 'pause':
          this.stop()
          this.sendFrame()
          this.setStatus(this.sim?.done ? 'done' : 'paused')
          break
        case 'step': {
          this.stop()
          this.sim?.step(Math.max(1, Math.floor(msg.steps)))
          this.sendFrame()
          this.emitPendingStats()
          this.setStatus(this.sim?.done ? 'done' : 'paused')
          if (this.sim?.done) this.emitDone()
          break
        }
        case 'reset':
          this.stop()
          this.sim?.reset()
          if (this.sim) this.lastIntervals = this.sim.intervalsClosed
          this.sendFrame()
          this.setStatus('idle')
          break
        case 'updateSignals':
          this.sim?.updateSignals(msg.controllers, msg.controls)
          this.sendFrame()
          this.setStatus(this.status)
          break
        case 'requestStats':
          if (this.sim) this.post({ type: 'stats', results: this.sim.results() })
          break
      }
    } catch (err) {
      this.stop()
      this.post({ type: 'error', message: describeError(err) })
    }
  }

  dispose(): void {
    this.stop()
    this.sim = null
  }

  /* ----------------------------- Cadence ----------------------------- */

  private start(): void {
    if (!this.sim || this.sim.done) {
      this.setStatus('done')
      return
    }
    this.lastTick = this.timers.now()
    this.stepDebt = 0
    this.stepsSinceStatus = 0
    this.lastStatus = this.lastTick
    this.setStatus('running')
    this.schedule(0)
  }

  private stop(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(ms: number): void {
    this.stop()
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.tick()
    }, ms)
  }

  private tick(): void {
    const sim = this.sim
    if (!sim || this.status !== 'running') return
    try {
      const now = this.timers.now()
      let steps = 0
      if (this.fast) {
        const deadline = now + FAST_TURN_MS
        while (!sim.done && this.timers.now() < deadline) {
          sim.step(25)
          steps += 25
        }
      } else {
        const elapsed = Math.max(0, now - this.lastTick) / 1000
        this.stepDebt += elapsed * this.speed
        steps = Math.min(MAX_STEPS_PER_TURN, Math.floor(this.stepDebt))
        this.stepDebt -= steps
        if (steps > 0) sim.step(steps)
      }
      this.lastTick = now
      this.stepsSinceStatus += steps

      const after = this.timers.now()
      if (this.fast || after - this.lastFrame >= FRAME_INTERVAL_MS) this.sendFrame()
      this.emitPendingStats()
      if (after - this.lastStatus >= STATUS_INTERVAL_MS) {
        this.stepsPerSecond = (this.stepsSinceStatus * 1000) / Math.max(1, after - this.lastStatus)
        this.stepsSinceStatus = 0
        this.lastStatus = after
        this.emitStatus()
      }
      if (sim.done) {
        this.stop()
        this.sendFrame()
        this.emitDone()
        this.setStatus('done')
        return
      }
      this.schedule(this.fast ? 0 : Math.max(0, FRAME_INTERVAL_MS - (this.timers.now() - after)))
    } catch (err) {
      this.stop()
      this.post({ type: 'error', message: describeError(err) })
    }
  }

  /* ----------------------------- Messages ----------------------------- */

  private sendFrame(): void {
    if (!this.sim) return
    const frame = this.sim.frame()
    this.lastFrame = this.timers.now()
    this.post({ type: 'frame', frame }, [frame.vehicles.buffer])
  }

  private emitPendingStats(): void {
    if (!this.sim) return
    if (this.sim.intervalsClosed !== this.lastIntervals) {
      this.lastIntervals = this.sim.intervalsClosed
      this.post({ type: 'stats', results: this.sim.results() })
    }
  }

  private emitDone(): void {
    if (!this.sim) return
    this.lastIntervals = this.sim.intervalsClosed
    this.post({ type: 'done', results: this.sim.results() })
  }

  private setStatus(status: SimStatus): void {
    this.status = status
    this.emitStatus()
  }

  private emitStatus(): void {
    this.post({
      type: 'status',
      status: this.status,
      time: this.sim?.time ?? 0,
      endTime: this.sim?.endTime ?? 0,
      stepsPerSecond: Math.round(this.stepsPerSecond),
    })
  }
}

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1
  return Math.min(1000, speed)
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `Erreur du moteur : ${err.message}`
  return `Erreur du moteur : ${String(err)}`
}

/* ----------------------------- Accroche Worker ----------------------------- */

declare const self: DedicatedWorkerGlobalScope | undefined

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.addEventListener === 'function') {
  const host = new EngineHost((msg, transfer) => {
    if (transfer && transfer.length) self.postMessage(msg, transfer)
    else self.postMessage(msg)
  })
  self.addEventListener('message', (ev: MessageEvent<ToWorker>) => host.handle(ev.data))
}
