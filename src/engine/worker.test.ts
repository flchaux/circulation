import { describe, expect, it } from 'vitest'
import type { Demand, NetEdge, NetNode, Network, SimSettings } from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import type { FromWorker } from './protocol'
import { EngineHost } from './worker'
import type { HostTimers } from './worker'

/** Horloge contrôlée : `advance` fait avancer le temps et déclenche les tâches dues. */
class FakeTimers implements HostTimers {
  time = 0
  /** Millisecondes ajoutées à chaque lecture de l'horloge (simule le coût réel d'un tour). */
  autoTick = 0
  private nextHandle = 1
  private tasks = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    this.time += this.autoTick
    return this.time
  }

  setTimeout(fn: () => void, ms: number): number {
    const handle = this.nextHandle++
    this.tasks.set(handle, { at: this.time + ms, fn })
    return handle
  }

  clearTimeout(handle: number): void {
    this.tasks.delete(handle)
  }

  advance(ms: number, chunk = 10): void {
    const target = this.time + ms
    while (this.time < target) {
      this.time = Math.min(target, this.time + chunk)
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= this.time)
      for (const [handle, task] of due) {
        this.tasks.delete(handle)
        task.fn()
      }
    }
  }
}

function corridorNetwork(): Network {
  const nodes: Record<string, NetNode> = {
    A: { id: 'A', x: 0, y: 0, boundary: true },
    B: { id: 'B', x: 300, y: 0, boundary: false },
    C: { id: 'C', x: 900, y: 0, boundary: true },
  }
  const mk = (id: string, from: string, to: string, lanes = 1): NetEdge => ({
    id, from, to, highway: 'residential', lanes, maxspeed: 50,
    length: Math.hypot(nodes[to].x - nodes[from].x, nodes[to].y - nodes[from].y),
    geometry: [[nodes[from].x, nodes[from].y], [nodes[to].x, nodes[to].y]],
    roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
  })
  return { nodes, edges: { e1: mk('e1', 'A', 'B'), e2: mk('e2', 'B', 'C', 2) }, controls: {}, controllers: {} }
}

const demand: Demand = {
  seed: 5, globalFactor: 1,
  entries: { A: { flow: 900, enabled: true, estimated: false } },
  exits: { C: { weight: 1, enabled: true } },
  destinationMode: 'weights', od: {},
  internal: { enabled: false, generationRate: 0, internalDestinationShare: 0, entryInternalShare: 0 },
}

const settings: SimSettings = { ...DEFAULT_SETTINGS, durationMin: 10, warmupMin: 0, statsIntervalMin: 5, dynamicRouting: false }

function makeHost() {
  const messages: FromWorker[] = []
  const timers = new FakeTimers()
  const host = new EngineHost((msg) => messages.push(msg), timers)
  return { host, timers, messages, types: () => messages.map((m) => m.type) }
}

describe('EngineHost', () => {
  it('répond à `init` par ready, frame puis status', () => {
    const { host, messages, types } = makeHost()
    host.handle({ type: 'init', payload: { network: corridorNetwork(), demand, settings } })
    expect(types()).toEqual(['ready', 'frame', 'status'])
    const ready = messages[0]
    expect(ready.type === 'ready' && ready.edgeIndex).toEqual(['e1', 'e2'])
    expect(ready.type === 'ready' && ready.endTime).toBe(600)
    const status = messages[2]
    expect(status.type === 'status' && status.status).toBe('idle')
  })

  it('avance à la cadence demandée et publie des frames', () => {
    const { host, timers, messages } = makeHost()
    host.handle({ type: 'init', payload: { network: corridorNetwork(), demand, settings } })
    messages.length = 0
    host.handle({ type: 'run', speed: 60 })
    timers.advance(2000)
    const frames = messages.filter((m) => m.type === 'frame')
    expect(frames.length).toBeGreaterThan(10)
    const last = frames[frames.length - 1]
    // 2 s réelles × 60 = 120 s simulées (tolérance sur le découpage des tours).
    expect(last.type === 'frame' && last.frame.time).toBeGreaterThan(90)
    expect(last.type === 'frame' && last.frame.time).toBeLessThanOrEqual(120)
    const statuses = messages.filter((m) => m.type === 'status')
    expect(statuses.some((m) => m.type === 'status' && m.status === 'running')).toBe(true)
    expect(statuses.some((m) => m.type === 'status' && m.stepsPerSecond > 0)).toBe(true)
  })

  it('émet un message stats à chaque intervalle clos', () => {
    const { host, timers, messages } = makeHost()
    host.handle({ type: 'init', payload: { network: corridorNetwork(), demand, settings } })
    messages.length = 0
    host.handle({ type: 'run', speed: 120 })
    timers.advance(4000)
    const stats = messages.filter((m) => m.type === 'stats')
    expect(stats.length).toBeGreaterThanOrEqual(1)
    expect(stats[0].type === 'stats' && stats[0].results.series.times[0]).toBe(0)
  })

  it('met en pause, avance pas à pas et réinitialise', () => {
    const { host, timers, messages } = makeHost()
    host.handle({ type: 'init', payload: { network: corridorNetwork(), demand, settings } })
    host.handle({ type: 'run', speed: 60 })
    timers.advance(1000)
    messages.length = 0
    host.handle({ type: 'pause' })
    expect(messages.map((m) => m.type)).toEqual(['frame', 'status'])
    const paused = messages[1]
    expect(paused.type === 'status' && paused.status).toBe('paused')
    const timeAtPause = messages[0].type === 'frame' ? messages[0].frame.time : -1

    messages.length = 0
    host.handle({ type: 'step', steps: 5 })
    const stepped = messages.find((m) => m.type === 'frame')
    expect(stepped?.type === 'frame' && stepped.frame.time).toBe(timeAtPause + 5)

    messages.length = 0
    host.handle({ type: 'reset' })
    const reset = messages.find((m) => m.type === 'frame')
    expect(reset?.type === 'frame' && reset.frame.time).toBe(0)
    expect(messages.some((m) => m.type === 'status' && m.status === 'idle')).toBe(true)
  })

  it('termine en calcul rapide et renvoie les résultats complets', () => {
    const { host, timers, messages } = makeHost()
    host.handle({ type: 'init', payload: { network: corridorNetwork(), demand, settings } })
    messages.length = 0
    host.handle({ type: 'runFast' })
    timers.advance(2000)
    const done = messages.find((m) => m.type === 'done')
    expect(done).toBeDefined()
    if (done?.type === 'done') {
      expect(done.results.completed).toBe(true)
      expect(done.results.reachedS).toBe(600)
      expect(done.results.network.entered).toBe(done.results.network.exited + done.results.network.inCirculation)
    }
    expect(messages.some((m) => m.type === 'status' && m.status === 'done')).toBe(true)
  })

  it('renvoie les statistiques sur demande et applique updateSignals', () => {
    const { host, messages } = makeHost()
    const network = corridorNetwork()
    host.handle({ type: 'init', payload: { network, demand, settings } })
    messages.length = 0
    host.handle({ type: 'requestStats' })
    expect(messages.map((m) => m.type)).toEqual(['stats'])
    messages.length = 0
    host.handle({ type: 'updateSignals', controllers: {}, controls: {} })
    expect(messages.map((m) => m.type)).toEqual(['frame', 'status'])
  })

  it('capture les erreurs et les relaie en français', () => {
    const { host, messages } = makeHost()
    // Réseau invalide : `nodes` absent provoque une erreur à la construction du graphe.
    host.handle({ type: 'init', payload: { network: null as unknown as Network, demand, settings } })
    const error = messages.find((m) => m.type === 'error')
    expect(error?.type === 'error' && error.message.startsWith('Erreur du moteur :')).toBe(true)
  })
})
