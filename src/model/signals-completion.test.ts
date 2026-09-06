/**
 * Complétion automatique des plans de feux après une modification de topologie.
 * Sans elle, les mouvements créés par une fusion de nœuds resteraient au rouge en permanence.
 */
import { describe, expect, it } from 'vitest'
import type { Network, SignalController } from '@/model/types'
import { buildAdjacency, movementsConflict } from '@/model/geometry'
import { completeSignalPlans, controllerMovements, createDefaultSignalPlan, validateController } from '@/model/signals'
import { crossNetwork, withSignals } from './testNetworks'

/** Mouvements pilotés qui n'apparaissent dans aucune phase. */
function jamaisVerts(net: Network, c: SignalController): string[] {
  const adj = buildAdjacency(net)
  const couverts = new Set<string>()
  for (const p of c.phases) for (const k of Object.keys(p.movements)) couverts.add(k)
  return controllerMovements(net, c, adj).filter((m) => !couverts.has(m.key)).map((m) => m.key)
}

describe('completeSignalPlans', () => {
  it('ne touche pas un plan déjà complet et préserve l’identité du réseau', () => {
    const net = withSignals(crossNetwork())
    const { network, added } = completeSignalPlans(net)
    expect(added).toBe(0)
    expect(network).toBe(net)
  })

  it('rattache les mouvements orphelins et supprime l’anomalie', () => {
    const net = withSignals(crossNetwork())
    const c = Object.values(net.controllers)[0]
    // On ampute le plan comme le ferait une topologie modifiée après coup.
    const ampute: Network = {
      ...net,
      controllers: {
        [c.id]: {
          ...c,
          phases: c.phases.map((p, i) => ({
            ...p,
            movements: i === 0 ? { [Object.keys(p.movements)[0]]: 'protected' as const } : {},
          })),
        },
      },
    }
    const avant = jamaisVerts(ampute, ampute.controllers[c.id])
    expect(avant.length).toBeGreaterThan(5)

    const { network, added } = completeSignalPlans(ampute)
    expect(added).toBe(avant.length)
    const repare = network.controllers[c.id]
    expect(jamaisVerts(network, repare)).toEqual([])
    expect(validateController(network, repare).some((a) => /jamais au vert/.test(a))).toBe(false)
  })

  it('n’introduit jamais deux mouvements protégés en conflit dans une même phase', () => {
    const net = withSignals(crossNetwork())
    const c = Object.values(net.controllers)[0]
    const ampute: Network = {
      ...net,
      controllers: { [c.id]: { ...c, phases: c.phases.map((p) => ({ ...p, movements: {} })) } },
    }
    const { network } = completeSignalPlans(ampute)
    const repare = network.controllers[c.id]
    const parCle = new Map(controllerMovements(network, repare).map((m) => [m.key, m]))
    for (const phase of repare.phases) {
      const proteges = Object.entries(phase.movements)
        .filter(([, k]) => k === 'protected')
        .map(([key]) => parCle.get(key))
        .filter((m): m is NonNullable<typeof m> => !!m)
      for (let i = 0; i < proteges.length; i++) {
        for (let j = i + 1; j < proteges.length; j++) {
          expect(movementsConflict(proteges[i], proteges[j]),
            `${proteges[i].key} et ${proteges[j].key} sont protégés en conflit`).toBe(false)
        }
      }
    }
  })

  it('régénère un plan complet pour un contrôleur sans aucune phase', () => {
    const net = withSignals(crossNetwork())
    const c = Object.values(net.controllers)[0]
    const vide: Network = { ...net, controllers: { [c.id]: { ...c, phases: [] } } }
    const { network, added } = completeSignalPlans(vide)
    expect(added).toBeGreaterThan(0)
    const repare = network.controllers[c.id]
    expect(repare.phases.length).toBeGreaterThanOrEqual(1)
    expect(jamaisVerts(network, repare)).toEqual([])
  })

  it('couvre autant de mouvements qu’un plan régénéré de zéro', () => {
    const net = withSignals(crossNetwork())
    const c = Object.values(net.controllers)[0]
    const complet = createDefaultSignalPlan(net, c.nodeIds)
    const attendus = new Set<string>()
    for (const p of complet.phases) for (const k of Object.keys(p.movements)) attendus.add(k)

    const ampute: Network = {
      ...net,
      controllers: { [c.id]: { ...c, phases: c.phases.map((p) => ({ ...p, movements: {} })) } },
    }
    const { network } = completeSignalPlans(ampute)
    const obtenus = new Set<string>()
    for (const p of network.controllers[c.id].phases) for (const k of Object.keys(p.movements)) obtenus.add(k)
    expect([...obtenus].sort()).toEqual([...attendus].sort())
  })
})
