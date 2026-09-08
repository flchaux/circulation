/**
 * Phases propres à un plan : un dossier déclare des phases qui n'existent que dans certains plans
 * (sous-phase de pointe, phase escamotable de nuit). Une phase fermée ne doit consommer ni vert
 * ni inter-vert dans les plans qui ne l'ouvrent pas.
 */
import { describe, expect, it } from 'vitest'
import type { SignalController } from '@/model/types'
import { controllerCycle, planPhases, phaseRunsIn, validateController } from '@/model/signals'
import { SignalEngine, SIG_RED } from '@/engine/signals'
import { buildGraph } from '@/engine/routing'
import { crossNetwork, withSignals } from '@/model/testNetworks'

/** Carrefour en croix à trois phases, dont la troisième n'appartient qu'au plan de pointe. */
function reseau() {
  const base = withSignals(crossNetwork())
  const c0 = base.controllers.c1
  const troisieme = { ...c0.phases[0], id: 'p3', name: 'Sous-phase de pointe', green: 12 }
  const controller: SignalController = {
    ...c0,
    phases: [...c0.phases, troisieme],
    plans: [
      {
        id: 'pointe', name: 'PF1 pointe', cycle: 0, offset: 0,
        phases: { p1: { green: 30 }, p2: { green: 20 }, p3: { green: 12 } },
      },
      {
        id: 'creuse', name: 'PF2 creuse', cycle: 0, offset: 0,
        phases: { p1: { green: 20 }, p2: { green: 15 }, p3: { green: 0, skipped: true } },
      },
    ],
  }
  return { network: { ...base, controllers: { c1: controller } }, controller }
}

describe('phase propre à un plan', () => {
  it('est exclue des phases ouvertes et du cycle du plan qui la ferme', () => {
    const { controller } = reseau()
    const [pointe, creuse] = controller.plans!
    expect(phaseRunsIn(controller.phases[2], pointe)).toBe(true)
    expect(phaseRunsIn(controller.phases[2], creuse)).toBe(false)
    expect(planPhases(controller, pointe).map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(planPhases(controller, creuse).map((p) => p.id)).toEqual(['p1', 'p2'])

    // Le cycle creux ne paie ni les 12 s de vert ni l'inter-vert de la sous-phase.
    const cyclePointe = controllerCycle(controller, pointe)
    const cycleCreux = controllerCycle(controller, creuse)
    expect(cyclePointe).toBeGreaterThan(cycleCreux)
    expect(cycleCreux).toBe(20 + 15 + 2 * (controller.amber + controller.allRed))
  })

  it('n’est jamais ouverte par le moteur dans le plan qui la ferme', () => {
    const { network, controller } = reseau()
    // Plan creux imposé : aucun calendrier, on force en plaçant le plan creux en premier.
    const creuseDabord: SignalController = { ...controller, plans: [controller.plans![1], controller.plans![0]] }
    const net = { ...network, controllers: { c1: creuseDabord } }
    const graph = buildGraph(net)
    const engine = new SignalEngine(graph, net)
    const probe = { lastActivity: () => -Infinity, queueLength: () => 0 }

    const cycle = controllerCycle(creuseDabord, creuseDabord.plans![0])
    const vus = new Set<number>()
    for (let t = 0; t < cycle * 3; t++) {
      engine.update(t, probe)
      const etat = engine.states(t)[0]
      if (etat.phaseIndex >= 0) vus.add(etat.phaseIndex)
    }
    expect(vus.has(2), 'la sous-phase de pointe ne doit jamais s’ouvrir en heure creuse').toBe(false)
    expect(vus.has(0)).toBe(true)
    expect(vus.has(1)).toBe(true)
  })

  it('reste sans effet sur un contrôleur dépourvu de plans', () => {
    const base = withSignals(crossNetwork())
    const c = base.controllers.c1
    expect(planPhases(c, undefined).map((p) => p.id)).toEqual(c.phases.map((p) => p.id))
    expect(controllerCycle(c)).toBeGreaterThan(0)
  })

  it('ignore un plan qui fermerait toutes les phases plutôt que de bloquer le carrefour', () => {
    const { controller } = reseau()
    const toutFerme = {
      id: 'vide', name: 'Plan vide', cycle: 0, offset: 0,
      phases: { p1: { green: 0, skipped: true }, p2: { green: 0, skipped: true }, p3: { green: 0, skipped: true } },
    }
    expect(planPhases(controller, toutFerme).length).toBe(controller.phases.length)
  })
})

describe('validation d’une phase fermée par un plan', () => {
  it('ne signale pas un vert nul sur une phase que le plan ferme volontairement', () => {
    const { controller } = reseau()
    const creuse = controller.plans![1]
    const anomalies = validateController(withSignals(crossNetwork()), { ...controller, plans: [creuse] }, undefined)
    expect(anomalies.some((a) => /durée de vert nulle/.test(a))).toBe(false)
  })

  it('signale toujours un vert nul sur une phase que le plan ouvre', () => {
    const { controller } = reseau()
    const casse = {
      ...controller,
      plans: [{ ...controller.plans![0], phases: { ...controller.plans![0].phases, p1: { green: 0 } } }],
    }
    const anomalies = validateController(withSignals(crossNetwork()), casse, undefined)
    expect(anomalies.some((a) => /durée de vert nulle/.test(a))).toBe(true)
  })
})
