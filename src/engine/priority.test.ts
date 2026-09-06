import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network } from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import { buildGraph } from './routing'
import { SignalEngine } from './signals'
import { buildPriorityTables, yieldCapacity, yieldsByRight } from './priority'

function node(id: string, x: number, y: number, boundary = false, extra: Partial<NetNode> = {}): NetNode {
  return { id, x, y, boundary, ...extra }
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

/** Croix à quatre branches à double sens (nord, sud, est, ouest). */
function cross(centre: Partial<NetNode> = {}, edgeOverrides: Record<string, Partial<NetEdge>> = {}): Network {
  const nodes: Record<string, NetNode> = {
    c: node('c', 0, 0, false, centre),
    n: node('n', 0, 200, true), s: node('s', 0, -200, true),
    e: node('e', 200, 0, true), w: node('w', -200, 0, true),
  }
  const edges: Record<string, NetEdge> = {}
  for (const b of ['n', 's', 'e', 'w']) {
    edges[`${b}_in`] = edge(nodes, `${b}_in`, b, 'c', { reverseOf: `${b}_out`, ...edgeOverrides[`${b}_in`] })
    edges[`${b}_out`] = edge(nodes, `${b}_out`, 'c', b, { reverseOf: `${b}_in`, ...edgeOverrides[`${b}_out`] })
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

function tables(network: Network) {
  const graph = buildGraph(network)
  const signals = new SignalEngine(graph, network)
  const prio = buildPriorityTables(graph, network, DEFAULT_SETTINGS, signals.signalizedNodes)
  const idx = (key: string): number => {
    const i = graph.movementOf.get(key)
    if (i === undefined) throw new Error(`mouvement inconnu ${key}`)
    return i
  }
  const yieldsTo = (key: string): string[] => {
    const m = idx(key)
    const out: string[] = []
    for (let k = prio.yieldStart[m]; k < prio.yieldStart[m + 1]; k++) out.push(graph.movements[prio.yieldList[k]].key)
    return out.sort()
  }
  return { graph, prio, idx, yieldsTo }
}

describe('règle de priorité à droite', () => {
  it('cède à l’approche de droite et, en opposition, seulement pour le tourne-à-gauche', () => {
    const network = cross()
    network.controls.c = { nodeId: 'c', type: 'priority_right' }
    const { yieldsTo, prio, idx } = tables(network)

    // Approche ouest : le sud est à droite, le nord à gauche, l'est en face.
    const west = yieldsTo('w_in>e_out')
    expect(west.every((k) => k.startsWith('s_in>'))).toBe(true)
    expect(west.length).toBeGreaterThan(0)

    // Tourne-à-gauche depuis l'ouest : cède au tout-droit venant d'en face.
    expect(yieldsTo('w_in>n_out')).toContain('e_in>w_out')
    // Le tout-droit d'en face ne cède pas au tourne-à-gauche.
    expect(yieldsTo('e_in>w_out')).not.toContain('w_in>n_out')

    expect(prio.gap[idx('w_in>e_out')]).toBe(DEFAULT_SETTINGS.criticalGap.priorityRight)
    expect(prio.stopRequired[idx('w_in>e_out')]).toBe(0)
  })

  it('yieldsByRight se comporte comme la règle décrite', () => {
    const { graph } = tables(cross())
    const m = (key: string) => graph.movements[graph.movementOf.get(key)!]
    expect(yieldsByRight(m('w_in>e_out'), m('s_in>n_out'))).toBe(true) // sud à droite
    expect(yieldsByRight(m('w_in>e_out'), m('n_in>s_out'))).toBe(false) // nord à gauche
    expect(yieldsByRight(m('w_in>n_out'), m('e_in>w_out'))).toBe(true) // gauche contre tout-droit opposé
    expect(yieldsByRight(m('w_in>e_out'), m('e_in>w_out'))).toBe(false) // deux tout-droit opposés
  })
})

describe('stop et cédez-le-passage', () => {
  it('les approches marquées cèdent aux autres, et entre elles par priorité à droite', () => {
    const network = cross()
    network.controls.c = { nodeId: 'c', type: 'stop', yieldEdges: ['n_in', 's_in'] }
    const { yieldsTo, prio, idx } = tables(network)

    const south = yieldsTo('s_in>n_out')
    expect(south.some((k) => k.startsWith('w_in>'))).toBe(true)
    expect(south.some((k) => k.startsWith('e_in>'))).toBe(true)
    expect(prio.stopRequired[idx('s_in>n_out')]).toBe(1)
    expect(prio.gap[idx('s_in>n_out')]).toBe(DEFAULT_SETTINGS.criticalGap.stop)

    // Une approche non marquée ne cède pas à une approche marquée : ici l'ouest ne cède à personne
    // (nord et sud portent le stop, l'est est en face et va tout droit).
    expect(prio.stopRequired[idx('w_in>e_out')]).toBe(0)
    expect(yieldsTo('w_in>e_out')).toEqual([])
    // Entre deux approches marquées, c'est la priorité à droite qui tranche.
    expect(yieldsTo('n_in>e_out')).toContain('s_in>n_out')
  })

  it('`yieldEdges` vide fait céder toutes les approches', () => {
    const network = cross()
    network.controls.c = { nodeId: 'c', type: 'give_way', yieldEdges: [] }
    const { prio, idx } = tables(network)
    for (const key of ['w_in>e_out', 'n_in>s_out', 'e_in>w_out', 's_in>n_out']) {
      expect(prio.yielding[idx(key)]).toBe(1)
      expect(prio.gap[idx(key)]).toBe(DEFAULT_SETTINGS.criticalGap.priorityRight)
    }
  })
})

describe('priorité par classe de voie', () => {
  it('la voie de classe inférieure cède, la bretelle cède à sa voie mère', () => {
    const network = cross({}, {
      w_in: { highway: 'primary' }, w_out: { highway: 'primary' },
      e_in: { highway: 'primary' }, e_out: { highway: 'primary' },
      s_in: { highway: 'primary_link' }, s_out: { highway: 'primary_link' },
    })
    const { yieldsTo, prio, idx } = tables(network)
    // Le sud (bretelle) cède aux mouvements conflictuels de l'axe primaire.
    expect(yieldsTo('s_in>e_out').some((k) => k.startsWith('w_in>'))).toBe(true)
    expect(prio.gap[idx('s_in>e_out')]).toBe(DEFAULT_SETTINGS.criticalGap.giveWay)
    // L'axe primaire ne cède pas à la bretelle.
    expect(yieldsTo('w_in>e_out').some((k) => k.startsWith('s_in>'))).toBe(false)
    // Le nord (résidentiel) cède aussi au primaire.
    expect(yieldsTo('n_in>s_out').some((k) => k.startsWith('w_in>') || k.startsWith('e_in>'))).toBe(true)
  })
})

describe('giratoires', () => {
  it('avec anneau : l’entrée cède aux mouvements conflictuels de l’anneau', () => {
    const nodes: Record<string, NetNode> = {
      c: node('c', 0, 0),
      r1: node('r1', -30, -30), r2: node('r2', 30, 30),
      w: node('w', -200, 0, true), n: node('n', 0, 200, true),
    }
    const edges: Record<string, NetEdge> = {
      ring_in: edge(nodes, 'ring_in', 'r1', 'c', { roundabout: true }),
      ring_out: edge(nodes, 'ring_out', 'c', 'r2', { roundabout: true }),
      app_in: edge(nodes, 'app_in', 'w', 'c'),
      exit_out: edge(nodes, 'exit_out', 'c', 'n'),
    }
    const network: Network = { nodes, edges, controls: {}, controllers: {} }
    const { yieldsTo, prio, idx } = tables(network)
    // Régulation implicite : un tronçon entrant d'anneau suffit (defaultControl).
    expect(yieldsTo('app_in>ring_out')).toContain('ring_in>ring_out')
    expect(prio.gap[idx('app_in>ring_out')]).toBe(DEFAULT_SETTINGS.criticalGap.roundabout)
    expect(yieldsTo('ring_in>ring_out')).toEqual([])
    expect(prio.yielding[idx('ring_in>ring_out')]).toBe(0)
  })

  it('mini-giratoire : on cède à qui passe devant l’entrée (anneau virtuel trigonométrique)', () => {
    const network = cross({ miniRoundabout: true })
    const { yieldsTo, prio, idx } = tables(network)
    // Venant de l'ouest, on cède à celui qui vient de l'est et sort au sud : il passe devant l'entrée ouest.
    expect(yieldsTo('w_in>e_out')).toContain('e_in>s_out')
    // Il ne cède pas au mouvement qui a déjà quitté l'anneau avant l'entrée ouest.
    expect(yieldsTo('w_in>e_out')).not.toContain('e_in>n_out')
    expect(prio.gap[idx('w_in>e_out')]).toBe(DEFAULT_SETTINGS.criticalGap.roundabout)
  })
})

describe('mouvements permis aux feux', () => {
  it('précalcule les conflits et le sens de la priorité à droite', () => {
    const network = cross()
    network.controllers.ctl = {
      id: 'ctl', name: 'Croix', nodeIds: ['c'], mode: 'fixed', offset: 0, amber: 3, allRed: 2,
      phases: [{
        id: 'p1', name: 'Est-ouest', green: 30,
        movements: { 'w_in>e_out': 'protected', 'e_in>w_out': 'protected', 'w_in>n_out': 'permitted' },
        minGreen: 7, maxGreen: 60, gap: 3,
      }],
      actuated: { skipEmpty: true },
    }
    network.controls.c = { nodeId: 'c', type: 'signals', controllerId: 'ctl' }
    const { graph, prio, idx } = tables(network)
    const left = idx('w_in>n_out')
    const conflicts: string[] = []
    const rights: number[] = []
    for (let k = prio.conflictStart[left]; k < prio.conflictStart[left + 1]; k++) {
      conflicts.push(graph.movements[prio.conflictList[k]].key)
      rights.push(prio.conflictYieldRight[k])
    }
    expect(conflicts).toContain('e_in>w_out')
    expect(rights[conflicts.indexOf('e_in>w_out')]).toBe(1)
    expect(prio.gap[left]).toBe(DEFAULT_SETTINGS.criticalGap.permittedLeft)
    // Les tables statiques de cession restent vides aux carrefours à feux.
    expect(prio.yieldStart[left + 1] - prio.yieldStart[left]).toBe(0)
  })
})

describe('capacité de cession', () => {
  it('vaut 1 / tf sans flux conflictuel et décroît quand il augmente', () => {
    expect(yieldCapacity(0, 5, 3)).toBeCloseTo(1 / 3, 10)
    const light = yieldCapacity(0.05, 5, 3)
    const heavy = yieldCapacity(0.5, 5, 3)
    expect(light).toBeLessThan(1 / 3)
    expect(heavy).toBeLessThan(light)
    // Formule d'acceptation de créneaux : qc·e^(−qc·tc) / (1 − e^(−qc·tf)).
    expect(heavy).toBeCloseTo((0.5 * Math.exp(-2.5)) / (1 - Math.exp(-1.5)), 10)
  })
})
