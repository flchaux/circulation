import { describe, expect, it } from 'vitest'
import type {
  Demand, NetEdge, NetNode, Network, SignalController, SimSettings,
} from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import type { Frame } from './protocol'
import { VEHICLE_STRIDE } from './protocol'
import { generateArrivals } from './demand'
import { Simulation } from './simulation'

/* ----------------------------- Fabriques de réseau ----------------------------- */

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function edge(nodes: Record<string, NetNode>, id: string, from: string, to: string, o: Partial<NetEdge> = {}): NetEdge {
  const a = nodes[from]
  const b = nodes[to]
  return {
    id, from, to, highway: 'residential', lanes: 1, maxspeed: 50,
    length: Math.hypot(b.x - a.x, b.y - a.y),
    geometry: [[a.x, a.y], [b.x, b.y]],
    roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
    ...o,
  }
}

class NetBuilder {
  nodes: Record<string, NetNode> = {}
  edges: Record<string, NetEdge> = {}
  controls: Network['controls'] = {}
  controllers: Network['controllers'] = {}

  node(id: string, x: number, y: number, boundary = false): this {
    this.nodes[id] = node(id, x, y, boundary)
    return this
  }

  edge(id: string, from: string, to: string, o: Partial<NetEdge> = {}): this {
    this.edges[id] = edge(this.nodes, id, from, to, o)
    return this
  }

  /** Rue à double sens : deux tronçons liés par `reverseOf`. */
  twoWay(id: string, from: string, to: string, o: Partial<NetEdge> = {}): this {
    this.edge(id, from, to, { ...o, reverseOf: `${id}r` })
    this.edge(`${id}r`, to, from, { ...o, reverseOf: id })
    return this
  }

  build(): Network {
    return { nodes: this.nodes, edges: this.edges, controls: this.controls, controllers: this.controllers }
  }
}

function demandOf(
  entries: Record<string, number>,
  exits: Record<string, number>,
  extra: Partial<Demand> = {},
): Demand {
  const d: Demand = {
    seed: 2026,
    globalFactor: 1,
    entries: {},
    exits: {},
    destinationMode: 'weights',
    od: {},
    internal: { enabled: false, generationRate: 0, internalDestinationShare: 0, entryInternalShare: 0 },
    ...extra,
  }
  for (const [id, flow] of Object.entries(entries)) d.entries[id] = { flow, enabled: true, estimated: false }
  for (const [id, weight] of Object.entries(exits)) d.exits[id] = { weight, enabled: true }
  return d
}

function settingsOf(o: Partial<SimSettings> = {}): SimSettings {
  return { ...DEFAULT_SETTINGS, durationMin: 20, warmupMin: 0, dynamicRouting: false, statsIntervalMin: 5, ...o }
}

function runToEnd(sim: Simulation): void {
  let guard = 200_000
  while (!sim.done && guard-- > 0) sim.step(200)
  expect(sim.done).toBe(true)
}

/** Position de chaque véhicule (identifiant → index de tronçon) dans une frame. */
function vehicleEdges(frame: Frame): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i < frame.vehicles.length; i += VEHICLE_STRIDE) m.set(frame.vehicles[i], frame.vehicles[i + 1])
  return m
}

/** Nombre de véhicules par tronçon, et nombre de véhicules en file, dans une frame. */
function edgeOccupancy(frame: Frame): { count: Map<number, number>; queued: Map<number, number> } {
  const count = new Map<number, number>()
  const queued = new Map<number, number>()
  for (let i = 0; i < frame.vehicles.length; i += VEHICLE_STRIDE) {
    const e = frame.vehicles[i + 1]
    count.set(e, (count.get(e) ?? 0) + 1)
    if (frame.vehicles[i + 3] === 1) queued.set(e, (queued.get(e) ?? 0) + 1)
  }
  return { count, queued }
}

/* ----------------------------- Réseaux de référence ----------------------------- */

/** Corridor à sens unique : entrée A → e1 → B → e2 → C → e3 → sortie D. */
function corridor(): Network {
  const b = new NetBuilder()
  b.node('A', 0, 0, true).node('B', 200, 0).node('C', 1200, 0).node('D', 2200, 0, true)
  b.edge('e1', 'A', 'B')
  b.edge('e2', 'B', 'C', { lanes: 2 })
  b.edge('e3', 'C', 'D', { lanes: 2 })
  return b.build()
}

/** Carrefour en croix, quatre branches à double sens, centre en (0,0). */
function cross(): Network {
  const b = new NetBuilder()
  b.node('c', 0, 0)
  b.node('n', 0, 200, true).node('s', 0, -200, true).node('e', 200, 0, true).node('w', -200, 0, true)
  for (const branch of ['n', 's', 'e', 'w']) {
    b.edge(`${branch}_in`, branch, 'c', { reverseOf: `${branch}_out` })
    b.edge(`${branch}_out`, 'c', branch, { reverseOf: `${branch}_in` })
  }
  return b.build()
}

/** Contrôleur à deux phases : les tout-droit est-ouest, puis les tout-droit nord-sud. */
function throughController(o: Partial<SignalController> = {}): SignalController {
  return {
    id: 'ctl',
    name: 'Croix',
    nodeIds: ['c'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    phases: [
      {
        id: 'p1', name: 'Est-ouest', green: 30,
        movements: { 'w_in>e_out': 'protected', 'e_in>w_out': 'protected' },
        minGreen: 7, maxGreen: 20, gap: 3,
      },
      {
        id: 'p2', name: 'Nord-sud', green: 30,
        movements: { 's_in>n_out': 'protected', 'n_in>s_out': 'protected' },
        minGreen: 7, maxGreen: 20, gap: 3,
      },
    ],
    actuated: { skipEmpty: false },
    ...o,
  }
}

/**
 * Carrefour en T : axe principal W→J→E (une voie à l'entrée, deux à la sortie),
 * branche mineure S2→s0→S1→s1→J soumise au cédez-le-passage.
 */
function tJunction(): Network {
  const b = new NetBuilder()
  b.node('W', -300, 0, true).node('J', 0, 0).node('E', 300, 0, true)
  b.node('S1', 0, -60).node('S2', 0, -400, true)
  b.edge('m1', 'W', 'J')
  b.edge('m2', 'J', 'E', { lanes: 2 })
  b.edge('s1', 'S1', 'J')
  b.edge('s0', 'S2', 'S1')
  const net = b.build()
  net.controls.J = { nodeId: 'J', type: 'give_way', yieldEdges: ['s1'] }
  return net
}

/**
 * Grille de `size × size` nœuds à double sens, plus des antennes frontières :
 * ≈ 2 000 tronçons orientés, utilisée pour la mesure de performance.
 */
function grid(size: number, spacing: number): Network {
  const b = new NetBuilder()
  const id = (i: number, j: number) => `g${i}_${j}`
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) b.node(id(i, j), i * spacing, j * spacing)
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (i + 1 < size) b.twoWay(`h${i}_${j}`, id(i, j), id(i + 1, j))
      if (j + 1 < size) b.twoWay(`v${i}_${j}`, id(i, j), id(i, j + 1))
    }
  }
  for (const k of [0, Math.floor(size / 4), Math.floor(size / 2), Math.floor((3 * size) / 4), size - 1]) {
    const stubs: [string, number, number, string][] = [
      [`bw${k}`, -spacing, k * spacing, id(0, k)],
      [`be${k}`, size * spacing, k * spacing, id(size - 1, k)],
      [`bs${k}`, k * spacing, -spacing, id(k, 0)],
      [`bn${k}`, k * spacing, size * spacing, id(k, size - 1)],
    ]
    for (const [name, x, y, target] of stubs) {
      b.node(name, x, y, true)
      b.twoWay(`s_${name}`, name, target, { lanes: 2 })
    }
  }
  return b.build()
}

/* ----------------------------- Tests ----------------------------- */

describe('conservation des véhicules', () => {
  it('entrés = sortis + en circulation, et générés = entrés + non injectés', () => {
    const network = corridor()
    const sim = new Simulation({
      network,
      demand: demandOf({ A: 1200 }, { D: 1 }),
      settings: settingsOf({ durationMin: 30 }),
    })
    runToEnd(sim)
    const r = sim.results()
    expect(r.network.entered).toBeGreaterThan(300)
    expect(r.network.entered).toBe(r.network.exited + r.network.inCirculation)
    const generated = generateArrivals(network, demandOf({ A: 1200 }, { D: 1 }), settingsOf({ durationMin: 30 })).length
    expect(generated).toBe(r.network.entered + r.network.notInjected)
  })

  it('reste conservatif malgré la saturation et une chauffe', () => {
    const network = corridor()
    const sim = new Simulation({
      network,
      demand: demandOf({ A: 4000 }, { D: 1 }),
      settings: settingsOf({ durationMin: 20, warmupMin: 5 }),
    })
    runToEnd(sim)
    const r = sim.results()
    expect(r.network.notInjected).toBeGreaterThan(0) // entrée saturée
    expect(r.network.entered).toBe(r.network.exited + r.network.inCirculation)
  })
})

describe('débit de saturation', () => {
  it('décharge un tronçon libre à ≈ 1800 véh/h/voie', () => {
    const sim = new Simulation({
      network: corridor(),
      demand: demandOf({ A: 4000 }, { D: 1 }),
      settings: settingsOf({ durationMin: 30, warmupMin: 5 }),
    })
    runToEnd(sim)
    const flow = sim.results().edges.e1.flowVehH
    expect(flow).toBeGreaterThan(1800 * 0.95)
    expect(flow).toBeLessThan(1800 * 1.05)
  })

  it('double le débit sur un tronçon à deux voies', () => {
    const network = corridor()
    network.edges.e1 = { ...network.edges.e1, lanes: 2 }
    network.edges.e2 = { ...network.edges.e2, lanes: 3 }
    network.edges.e3 = { ...network.edges.e3, lanes: 3 }
    const sim = new Simulation({
      network,
      demand: demandOf({ A: 7000 }, { D: 1 }),
      settings: settingsOf({ durationMin: 30, warmupMin: 5 }),
    })
    runToEnd(sim)
    const flow = sim.results().edges.e1.flowVehH
    expect(flow).toBeGreaterThan(3600 * 0.95)
    expect(flow).toBeLessThan(3600 * 1.05)
  })
})

describe('remontée de file', () => {
  it('un aval plein bloque le tronçon amont', () => {
    const sim = new Simulation({
      network: tJunction(),
      demand: demandOf({ W: 3000, S2: 1200 }, { E: 1 }),
      settings: settingsOf({ durationMin: 15, warmupMin: 2 }),
    })
    // s1 fait 60 m : capacité = ⌊60 / 7,5⌋ = 8 véhicules.
    const s1Capacity = 8
    let sawSpillback = false
    let guard = 100_000
    while (!sim.done && guard-- > 0) {
      const before = sim.frame()
      const occ = before.counts.inCirculation > 0 ? edgeOccupancy(before) : null
      const s1 = sim.edgeIndex.indexOf('s1')
      const s0 = sim.edgeIndex.indexOf('s0')
      const positions = occ ? vehicleEdges(before) : null
      sim.step(1)
      if (!occ || !positions) continue
      if ((occ.count.get(s1) ?? 0) >= s1Capacity && (occ.queued.get(s0) ?? 0) > 0) {
        const after = vehicleEdges(sim.frame())
        const moved = [...positions].some(([id, e]) => e === s0 && after.get(id) === s1)
        if (!moved) sawSpillback = true
      }
    }
    expect(sawSpillback).toBe(true)
    const r = sim.results()
    expect(r.edges.s0.maxQueue).toBeGreaterThan(0)
    expect(r.edges.s1.maxQueue).toBeGreaterThanOrEqual(s1Capacity - 1)
  })
})

describe('feux à plan fixe', () => {
  it('respecte le cycle et n’autorise aucun franchissement au rouge', () => {
    const network = cross()
    network.controllers.ctl = throughController()
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({ w: 900, s: 900 }, { e: 1, n: 1 }, { destinationMode: 'od', od: { w: { e: 1 }, s: { n: 1 } } }),
      settings: settingsOf({ durationMin: 15 }),
    })
    const controller = network.controllers.ctl
    const cycle = controller.phases.reduce((s, p) => s + p.green + controller.amber + controller.allRed, 0)
    expect(cycle).toBe(70)

    let crossings = 0
    let guard = 100_000
    while (!sim.done && guard-- > 0) {
      const before = sim.frame()
      const t = before.time
      // État analytique attendu du plan fixe.
      const tau = t % cycle
      const expectedPhase = tau < 35 ? 0 : 1
      const local = tau - expectedPhase * 35
      const expectedState = local < 30 ? 'green' : local < 33 ? 'amber' : 'allred'
      expect(before.controllers[0].phaseIndex).toBe(expectedPhase)
      expect(before.controllers[0].state).toBe(expectedState)

      const positions = vehicleEdges(before)
      sim.step(1)
      const after = vehicleEdges(sim.frame())
      for (const [id, from] of positions) {
        const to = after.get(id)
        if (to === undefined || to === from) continue
        crossings++
        const key = `${sim.edgeIndex[from]}>${sim.edgeIndex[to]}`
        const green = controller.phases[expectedPhase].movements[key]
        // Un franchissement n'est possible qu'au vert ou pendant la part utilisable de l'orange.
        expect(green, `franchissement ${key} à t=${t} (${expectedState})`).toBeDefined()
        expect(expectedState === 'green' || expectedState === 'amber').toBe(true)
      }
    }
    expect(crossings).toBeGreaterThan(200)
  })

  it('un mouvement jamais au vert ne franchit jamais', () => {
    const network = cross()
    network.controllers.ctl = throughController()
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({ w: 600 }, { n: 1 }),
      settings: settingsOf({ durationMin: 10 }),
    })
    runToEnd(sim)
    // Le tourne-à-gauche w_in>n_out n'est dans aucune phase : les véhicules s'accumulent sans jamais sortir.
    expect(sim.results().exits.n.count).toBe(0)
    expect(sim.results().edges.w_in.maxQueue).toBeGreaterThan(0)
  })
})

describe('feux adaptatifs', () => {
  function greenRuns(sim: Simulation, steps: number): { phase: number; length: number }[] {
    const runs: { phase: number; length: number }[] = []
    let current: { phase: number; length: number } | null = null
    for (let i = 0; i < steps && !sim.done; i++) {
      const f = sim.frame()
      const c = f.controllers[0]
      if (c.state === 'green') {
        if (current && current.phase === c.phaseIndex) current.length++
        else { current = { phase: c.phaseIndex, length: 1 }; runs.push(current) }
      } else {
        current = null
      }
      sim.step(1)
    }
    return runs
  }

  it('prolonge le vert par la file, sans dépasser maxGreen', () => {
    const network = cross()
    network.controllers.ctl = throughController({ mode: 'actuated' })
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({ w: 3000, s: 200 }, { e: 1, n: 1 }, { destinationMode: 'od', od: { w: { e: 1 }, s: { n: 1 } } }),
      settings: settingsOf({ durationMin: 10 }),
    })
    const runs = greenRuns(sim, 600).filter((r) => r.length > 1)
    const phase0 = runs.filter((r) => r.phase === 0)
    expect(phase0.length).toBeGreaterThan(3)
    for (const r of runs) expect(r.length).toBeLessThanOrEqual(20 + 1) // maxGreen = 20 s
    // La file de l'ouest se décharge en permanence : le vert est prolongé jusqu'au plafond.
    const long = phase0.filter((r) => r.length >= 20).length
    expect(long).toBeGreaterThan(phase0.length / 2)
  })

  it('sans demande, le vert s’arrête au vert minimal', () => {
    const network = cross()
    network.controllers.ctl = throughController({ mode: 'actuated' })
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({}, { e: 1 }),
      settings: settingsOf({ durationMin: 10 }),
    })
    const runs = greenRuns(sim, 300).slice(1, 6)
    expect(runs.length).toBeGreaterThan(2)
    for (const r of runs) expect(r.length).toBe(7) // minGreen = 7 s
  })
})

describe('priorités hors feux', () => {
  function minorFlow(majorFlow: number): number {
    const sim = new Simulation({
      network: tJunction(),
      demand: demandOf({ W: majorFlow, S2: 1500 }, { E: 1 }),
      settings: settingsOf({ durationMin: 20, warmupMin: 5 }),
    })
    runToEnd(sim)
    return sim.results().edges.s1.flowVehH
  }

  it('le mouvement cédant passe librement quand le flux prioritaire est nul', () => {
    const flow = minorFlow(0)
    // Capacité de cession sans conflit : 1 / followUpTime = 1200 véh/h.
    expect(flow).toBeGreaterThan(1000)
    expect(flow).toBeLessThan(1300)
  })

  it('le mouvement cédant est fortement ralenti par un flux prioritaire dense', () => {
    const free = minorFlow(0)
    const dense = minorFlow(3000)
    expect(dense).toBeLessThan(free / 3)
    expect(dense).toBeGreaterThan(0)
  })

  it('un stop impose un arrêt supplémentaire par rapport au cédez-le-passage', () => {
    const build = (type: 'stop' | 'give_way'): number => {
      const network = tJunction()
      network.controls.J = { nodeId: 'J', type, yieldEdges: ['s1'] }
      const sim = new Simulation({
        network,
        demand: demandOf({ W: 0, S2: 1500 }, { E: 1 }),
        settings: settingsOf({ durationMin: 20, warmupMin: 5 }),
      })
      runToEnd(sim)
      return sim.results().edges.s1.flowVehH
    }
    expect(build('stop')).toBeLessThan(build('give_way'))
  })
})

describe('interdictions de tourner', () => {
  it('un mouvement interdit n’est jamais emprunté et rend la destination inatteignable', () => {
    const open = cross()
    const simOpen = new Simulation({
      network: open,
      demand: demandOf({ w: 600 }, { n: 1 }),
      settings: settingsOf({ durationMin: 10 }),
    })
    runToEnd(simOpen)
    expect(simOpen.results().exits.n.count).toBeGreaterThan(50)

    const banned = cross()
    banned.edges.w_in = { ...banned.edges.w_in, bannedTo: ['n_out'] }
    const sim = new Simulation({
      network: banned,
      demand: demandOf({ w: 600 }, { n: 1 }),
      settings: settingsOf({ durationMin: 10 }),
    })
    let guard = 100_000
    while (!sim.done && guard-- > 0) {
      const before = vehicleEdges(sim.frame())
      sim.step(1)
      const after = vehicleEdges(sim.frame())
      for (const [id, from] of before) {
        const to = after.get(id)
        if (to === undefined || to === from) continue
        expect(`${sim.edgeIndex[from]}>${sim.edgeIndex[to]}`).not.toBe('w_in>n_out')
      }
    }
    const r = sim.results()
    expect(r.exits.n.count).toBe(0)
    expect(r.network.entered).toBe(0)
    expect(r.network.notInjected).toBeGreaterThan(50)
  })
})

describe('nœuds frontière', () => {
  it('aucun véhicule ne traverse un nœud frontière', () => {
    const b = new NetBuilder()
    b.node('A', -400, 0, true).node('P', -200, 0).node('M', 0, 0, true).node('Q', 200, 0).node('X', 400, 0, true)
    b.node('U', 0, 600)
    b.edge('a_p', 'A', 'P')
    b.edge('p_m', 'P', 'M')
    b.edge('m_q', 'M', 'Q')
    b.edge('p_u', 'P', 'U')
    b.edge('u_q', 'U', 'Q')
    b.edge('q_x', 'Q', 'X')
    const network = b.build()
    const sim = new Simulation({
      network,
      demand: demandOf({ A: 600 }, { X: 1, M: 1 }),
      settings: settingsOf({ durationMin: 10 }),
    })
    let guard = 100_000
    while (!sim.done && guard-- > 0) {
      const before = vehicleEdges(sim.frame())
      sim.step(1)
      const after = vehicleEdges(sim.frame())
      for (const [id, from] of before) {
        const to = after.get(id)
        if (to === undefined || to === from) continue
        expect(`${sim.edgeIndex[from]}>${sim.edgeIndex[to]}`).not.toBe('p_m>m_q')
      }
    }
    const r = sim.results()
    expect(r.exits.X.count + r.exits.M.count).toBeGreaterThan(50)
    expect(r.edges.m_q.exited).toBe(0)
  })
})

describe('déterminisme', () => {
  it('deux exécutions identiques donnent exactement les mêmes résultats', () => {
    const build = () => new Simulation({
      network: cross(),
      demand: demandOf({ w: 800, s: 800, n: 400 }, { e: 1, n: 1, s: 1, w: 1 }),
      settings: settingsOf({ durationMin: 15, warmupMin: 3, dynamicRouting: true, routingIntervalMin: 2 }),
    })
    const a = build()
    const b = build()
    runToEnd(a)
    runToEnd(b)
    expect(JSON.stringify(b.results())).toBe(JSON.stringify(a.results()))
  })

  it('reset() ramène le moteur à un état identique', () => {
    const sim = new Simulation({
      network: corridor(),
      demand: demandOf({ A: 1500 }, { D: 1 }),
      settings: settingsOf({ durationMin: 10 }),
    })
    runToEnd(sim)
    const first = JSON.stringify(sim.results())
    sim.reset()
    expect(sim.time).toBe(0)
    expect(sim.done).toBe(false)
    runToEnd(sim)
    expect(JSON.stringify(sim.results())).toBe(first)
  })

  it('une graine différente change le résultat', () => {
    const run = (seed: number) => {
      const sim = new Simulation({
        network: corridor(),
        demand: demandOf({ A: 1500 }, { D: 1 }, { seed }),
        settings: settingsOf({ durationMin: 10 }),
      })
      runToEnd(sim)
      return sim.results().network.exited
    }
    expect(run(1)).not.toBe(run(2))
  })
})

describe('modification des feux à chaud', () => {
  it('conserve l’état d’un contrôleur inchangé et réinitialise un contrôleur modifié', () => {
    const network = cross()
    network.controllers.ctl = throughController({ mode: 'actuated' })
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({ w: 1200, s: 1200 }, { e: 1, n: 1 }, { destinationMode: 'od', od: { w: { e: 1 }, s: { n: 1 } } }),
      settings: settingsOf({ durationMin: 10 }),
    })
    sim.step(45)
    const before = sim.frame().controllers[0]
    sim.updateSignals({ ctl: network.controllers.ctl }, network.controls)
    const same = sim.frame().controllers[0]
    expect(same.phaseIndex).toBe(before.phaseIndex)
    expect(same.state).toBe(before.state)
    expect(same.remaining).toBeCloseTo(before.remaining, 9)

    const modified = { ...network.controllers.ctl, phases: network.controllers.ctl.phases.map((p) => ({ ...p, maxGreen: 45 })) }
    sim.updateSignals({ ctl: modified }, network.controls)
    const reset = sim.frame().controllers[0]
    expect(reset.phaseIndex).toBe(0)
    expect(reset.state).toBe('green')
  })

  it('conserve les véhicules et applique le nouveau plan', () => {
    const network = cross()
    network.controllers.ctl = throughController()
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({ w: 900, s: 900 }, { e: 1, n: 1 }, { destinationMode: 'od', od: { w: { e: 1 }, s: { n: 1 } } }),
      settings: settingsOf({ durationMin: 15 }),
    })
    sim.step(300)
    const before = sim.frame().counts.inCirculation
    expect(before).toBeGreaterThan(0)
    sim.updateSignals({ ctl: { ...network.controllers.ctl, mode: 'flashing' } }, network.controls)
    const frame = sim.frame()
    expect(frame.counts.inCirculation).toBe(before)
    expect(frame.controllers[0].state).toBe('flashing')
    expect(frame.controllers[0].phaseIndex).toBe(-1)
    sim.step(300)
    expect(sim.frame().controllers[0].state).toBe('flashing')
  })
})

describe('frames et statistiques', () => {
  it('publie des positions cohérentes et des séries complètes', () => {
    const sim = new Simulation({
      network: corridor(),
      demand: demandOf({ A: 1500 }, { D: 1 }),
      settings: settingsOf({ durationMin: 20, warmupMin: 5, statsIntervalMin: 5 }),
    })
    sim.step(600)
    const frame = sim.frame()
    expect(frame.vehicles.length % VEHICLE_STRIDE).toBe(0)
    expect(frame.vehicles.length / VEHICLE_STRIDE).toBe(frame.counts.inCirculation)
    for (let i = 0; i < frame.vehicles.length; i += VEHICLE_STRIDE) {
      const e = frame.vehicles[i + 1]
      expect(e).toBeGreaterThanOrEqual(0)
      expect(e).toBeLessThan(sim.edgeIndex.length)
      const pos = frame.vehicles[i + 2]
      expect(pos).toBeGreaterThanOrEqual(0)
      expect(pos).toBeLessThanOrEqual(sim.edgeAt(e).length + 1e-6)
    }
    runToEnd(sim)
    const r = sim.results()
    expect(r.completed).toBe(true)
    expect(r.reachedS).toBe(25 * 60)
    expect(r.series.times).toEqual([0, 300, 600, 900, 1200])
    expect(r.series.network.entered.length).toBe(5)
    expect(r.series.edges.e1.flow.length).toBe(5)
    expect(r.series.exits.D.count.length).toBe(5)
    expect(r.edges.e1.meanSpeedKmh).toBeGreaterThan(0)
    expect(r.edges.e1.meanSpeedKmh).toBeLessThanOrEqual(50.001)
    expect(r.network.vehKm).toBeGreaterThan(0)
    expect(r.exits.D.meanTravelTimeS).toBeGreaterThan(0)
  })

  it('calcule la saturation par rapport à la part de vert', () => {
    const network = cross()
    network.controllers.ctl = throughController()
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const sim = new Simulation({
      network,
      demand: demandOf({ w: 1500, s: 1500 }, { e: 1, n: 1 }, { destinationMode: 'od', od: { w: { e: 1 }, s: { n: 1 } } }),
      settings: settingsOf({ durationMin: 20, warmupMin: 5 }),
    })
    runToEnd(sim)
    const r = sim.results()
    // Part de vert de l'approche ouest = 30 / 70 ; le débit sature donc autour de 770 véh/h.
    expect(r.edges.w_in.flowVehH).toBeGreaterThan(650)
    expect(r.edges.w_in.flowVehH).toBeLessThan(820)
    expect(r.edges.w_in.saturation).toBeGreaterThan(0.85)
    expect(r.edges.w_in.saturation).toBeLessThan(1.1)
  })
})

describe('performance', () => {
  it('tient au moins 300 pas/s sur ≈ 2 000 tronçons et ≥ 1 500 véhicules', () => {
    const network = grid(23, 150)
    const edgeCount = Object.keys(network.edges).length
    expect(edgeCount).toBeGreaterThan(2000)
    const demand = demandOf({}, {})
    for (const n of Object.values(network.nodes)) {
      if (!n.boundary) continue
      demand.entries[n.id] = { flow: 700, enabled: true, estimated: false }
      demand.exits[n.id] = { weight: 1, enabled: true }
    }
    const sim = new Simulation({
      network,
      demand,
      settings: settingsOf({ durationMin: 60, warmupMin: 0, dynamicRouting: true, routingIntervalMin: 5 }),
    })
    // Chauffe jusqu'à 1 500 véhicules en circulation.
    let guard = 500
    while (sim.frame().counts.inCirculation < 1500 && guard-- > 0) sim.step(20)
    const vehicles = sim.frame().counts.inCirculation
    expect(vehicles).toBeGreaterThanOrEqual(1500)

    const steps = 1500
    const start = performance.now()
    sim.step(steps)
    const stepsPerSecond = steps / ((performance.now() - start) / 1000)
    console.log(
      `performance : ${edgeCount} tronçons, ${vehicles} → ${sim.frame().counts.inCirculation} véhicules, `
      + `${Math.round(stepsPerSecond)} pas/s`,
    )
    expect(stepsPerSecond).toBeGreaterThan(300)
  })
})
