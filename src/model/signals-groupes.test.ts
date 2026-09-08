/**
 * Dossiers de carrefour (§14 de docs/ARCHITECTURE.md), côté modèle : dérivation des mouvements à partir des
 * groupes de signaux, inter-verts par couple de groupes, plages horaires et anomalies associées.
 */
import { describe, expect, it } from 'vitest'
import type { Network, SignalController, SignalPhase } from './types'
import { crossNetwork } from './testNetworks'
import {
  activePlan, activePlanAt, clockAt, completeSignalPlans, controllerCycle, defaultPlan, phaseDuration,
  phaseGreenGroups, phaseMovements, phaseTransition, planPhaseTiming, scheduleCovers, validateController,
} from './signals'

/* ----------------------------- Fabriques ----------------------------- */

function phase(id: string, name: string, green: number, o: Partial<SignalPhase> = {}): SignalPhase {
  return { id, name, green, movements: {}, minGreen: 7, maxGreen: 60, gap: 3, ...o }
}

/**
 * Contrôleur imité d'un dossier : deux phases écrites en groupes, un vert piéton P1 sur la traversée nord
 * qui coupe le tourne-à-gauche ouest, et une matrice d'inter-verts asymétrique.
 */
function dossierController(o: Partial<SignalController> = {}): SignalController {
  return {
    id: 'ctl',
    name: 'Carrefour dossier',
    nodeIds: ['c'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    phases: [
      phase('p1', 'Est-ouest', 20, { groups: ['V1', 'P1'] }),
      phase('p2', 'Nord-sud', 25, { groups: ['V2'] }),
    ],
    groups: [
      { id: 'V1', type: 'vehicule', label: 'Axe est-ouest', movements: ['w_in>e_out', 'e_in>w_out', 'w_in>n_out'] },
      { id: 'V2', type: 'vehicule', label: 'Axe nord-sud', movements: ['s_in>n_out', 'n_in>s_out'] },
      { id: 'P1', type: 'pieton', label: 'Traversée nord', movements: ['w_in>n_out'], recall: true },
    ],
    interGreen: { V1: { V2: 6 }, P1: { V2: 8 }, V2: { V1: 7 } },
    amberByGroup: { V1: 3, V2: 5 },
    source: 'dossier VE005',
    actuated: { skipEmpty: false },
    ...o,
  }
}

/** Contrôleur classique de l'éditeur : aucune donnée de dossier. */
function editorController(o: Partial<SignalController> = {}): SignalController {
  return {
    id: 'ctl',
    name: 'Croix',
    nodeIds: ['c'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    phases: [
      phase('p1', 'Est-ouest', 30, { movements: { 'w_in>e_out': 'protected', 'e_in>w_out': 'protected' } }),
      phase('p2', 'Nord-sud', 30, { movements: { 's_in>n_out': 'protected', 'n_in>s_out': 'protected' } }),
    ],
    actuated: { skipEmpty: false },
    ...o,
  }
}

function withController(controller: SignalController): Network {
  const net = crossNetwork()
  return {
    ...net,
    controls: { ...net.controls, c: { nodeId: 'c', type: 'signals', controllerId: controller.id } },
    controllers: { [controller.id]: controller },
  }
}

/* ----------------------------- Mouvements dérivés des groupes ----------------------------- */

describe('mouvements dérivés des groupes', () => {
  it('sans groupe, `movements` de la phase reste la source', () => {
    const c = editorController()
    expect(phaseGreenGroups(c, c.phases[0])).toEqual([])
    expect(phaseMovements(c, c.phases[0])).toEqual({ 'w_in>e_out': 'protected', 'e_in>w_out': 'protected' })
  })

  it('union des groupes véhicules verts, moins ce qu’un vert piéton traverse', () => {
    const c = dossierController()
    // V1 ouvre aussi le tourne-à-gauche vers le nord, mais P1 est vert : il reste rouge.
    expect(phaseMovements(c, c.phases[0])).toEqual({ 'w_in>e_out': 'protected', 'e_in>w_out': 'protected' })
    expect(phaseMovements(c, c.phases[1])).toEqual({ 's_in>n_out': 'protected', 'n_in>s_out': 'protected' })
  })

  it('sans le groupe piéton, le mouvement sécant redevient vert', () => {
    const c = dossierController({
      phases: [phase('p1', 'Est-ouest', 20, { groups: ['V1'] }), phase('p2', 'Nord-sud', 25, { groups: ['V2'] })],
    })
    expect(Object.keys(phaseMovements(c, c.phases[0])).sort())
      .toEqual(['e_in>w_out', 'w_in>e_out', 'w_in>n_out'])
  })

  it('conserve le type de vert indiqué par la phase, protégé par défaut', () => {
    const c = dossierController({
      phases: [
        phase('p1', 'Est-ouest', 20, { groups: ['V1'], movements: { 'w_in>n_out': 'permitted' } }),
        phase('p2', 'Nord-sud', 25, { groups: ['V2'] }),
      ],
      groups: [
        { id: 'V1', type: 'vehicule', movements: ['w_in>e_out', 'w_in>n_out'] },
        { id: 'V2', type: 'vehicule', movements: ['s_in>n_out'] },
      ],
    })
    expect(phaseMovements(c, c.phases[0])).toEqual({ 'w_in>e_out': 'protected', 'w_in>n_out': 'permitted' })
  })

  it('un groupe inconnu du contrôleur ne fait pas disparaître le plan', () => {
    const c = dossierController({
      phases: [
        phase('p1', 'Est-ouest', 20, { groups: ['V9'], movements: { 'w_in>e_out': 'protected' } }),
        phase('p2', 'Nord-sud', 25, { groups: ['V2'] }),
      ],
    })
    expect(phaseMovements(c, c.phases[0])).toEqual({ 'w_in>e_out': 'protected' })
  })
})

/* ----------------------------- Inter-verts ----------------------------- */

describe('inter-verts par couple de groupes', () => {
  it('dépend de la transition et non du seul contrôleur', () => {
    const c = dossierController()
    const aller = phaseTransition(c, c.phases[0], c.phases[1])
    const retour = phaseTransition(c, c.phases[1], c.phases[0])
    // Aller : V1 et P1 perdent le vert, V2 le prend → max(6, 8) = 8 s.
    expect(aller.total).toBe(8)
    // Retour : V2 perd le vert, V1 et P1 le prennent → 7 s (aucune case V2→P1).
    expect(retour.total).toBe(7)
    expect(aller.matrixBased).toBe(true)
  })

  it('prend le jaune du groupe véhicule qui perd le vert', () => {
    const c = dossierController()
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 3, allRed: 5 })
    expect(phaseTransition(c, c.phases[1], c.phases[0])).toMatchObject({ amber: 5, allRed: 2 })
  })

  it('retient le jaune le plus long quand plusieurs groupes véhicules perdent le vert', () => {
    const c = dossierController({
      phases: [phase('p1', 'A', 20, { groups: ['V1', 'V2'] }), phase('p2', 'B', 20, { groups: ['P1'] })],
      interGreen: { V1: { P1: 9 }, V2: { P1: 9 } },
      amberByGroup: { V1: 3, V2: 5 },
    })
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 5, allRed: 4 })
  })

  it('un groupe piéton qui perd le vert n’apporte aucun jaune', () => {
    const c = dossierController({
      phases: [phase('p1', 'Piétons', 20, { groups: ['P1'] }), phase('p2', 'Nord-sud', 20, { groups: ['V2'] })],
    })
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 0, allRed: 8 })
  })

  it('deux groupes compatibles (case absente) s’enchaînent sans temps mort', () => {
    const c = dossierController({
      phases: [phase('p1', 'A', 20, { groups: ['V1'] }), phase('p2', 'B', 20, { groups: ['V1', 'P1'] })],
    })
    // V1 reste vert : aucun groupe ne perd le vert, la transition est nulle.
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 0, allRed: 0, total: 0 })
  })

  it('tronque un jaune plus long que l’inter-vert plutôt que de rendre le rouge négatif', () => {
    const c = dossierController({ interGreen: { V1: { V2: 2 }, P1: { V2: 2 }, V2: { V1: 7 } } })
    const tr = phaseTransition(c, c.phases[0], c.phases[1])
    expect(tr).toMatchObject({ amber: 2, allRed: 0, total: 2, truncatedAmber: true })
  })

  it('replie le jaune sur celui du contrôleur quand le dossier n’en donne aucun', () => {
    // Une matrice sans colonne « jaune » exploitable ne doit pas transformer tout l'inter-vert en rouge
    // intégral : le jaune du contrôleur (renseigné à 3 s par l'import) prend le relais.
    const c = dossierController({ amberByGroup: undefined })
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 3, allRed: 5, total: 8 })
    const vide = dossierController({ amberByGroup: {} })
    expect(phaseTransition(vide, vide.phases[0], vide.phases[1])).toMatchObject({ amber: 3, allRed: 5 })
  })

  it('plafonne ce jaune de repli à l’inter-vert du dossier', () => {
    const c = dossierController({ amberByGroup: {}, interGreen: { V1: { V2: 2 }, P1: { V2: 2 }, V2: { V1: 7 } } })
    expect(phaseTransition(c, c.phases[0], c.phases[1]))
      .toMatchObject({ amber: 2, allRed: 0, total: 2, truncatedAmber: true })
  })

  it('n’allonge pas le jaune avec un groupe sans conflit avec la phase qui s’ouvre', () => {
    const c = dossierController({
      phases: [phase('p1', 'A', 20, { groups: ['V1', 'V2'] }), phase('p2', 'B', 20, { groups: ['P1'] })],
      interGreen: { V1: { P1: 9 } }, // V2 n'a aucune case vers P1 : il n'est pas en conflit avec elle
      amberByGroup: { V1: 3, V2: 5 },
    })
    // Seul le jaune de V1 compte : le rouge de dégagement dû à P1 reste de 6 s.
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 3, allRed: 6, total: 9 })
  })

  it('conserve le jaune d’un groupe véhicule qui s’éteint même sans case au dossier', () => {
    const c = dossierController({
      phases: [phase('p1', 'A', 20, { groups: ['V1', 'V2'] }), phase('p2', 'B', 20, { groups: ['V2'] })],
    })
    // V1 s'éteint pendant que V2 reste vert : aucune case ne s'applique, mais un feu ne passe jamais du
    // vert au rouge sans jaune — la transition dure au moins ce jaune.
    expect(phaseTransition(c, c.phases[0], c.phases[1]))
      .toMatchObject({ amber: 3, allRed: 0, total: 3, truncatedAmber: false })
  })

  it('dégage une traversée qui s’éteint même quand le groupe véhicule reste vert', () => {
    // Motif de la sous-phase piétonne : phase B = V1 + P1, phase C = V1. Aucun groupe ne « prend » le vert,
    // mais le tourne-à-gauche que la traversée fermait rouvre : il lui faut le dégagement du dossier.
    const c = dossierController({
      phases: [
        phase('pA', 'Nord-sud', 20, { groups: ['V2'] }),
        phase('pB', 'Est-ouest + traversée', 20, { groups: ['V1', 'P1'] }),
        phase('pC', 'Est-ouest', 20, { groups: ['V1'] }),
      ],
      interGreen: { V1: { V2: 6 }, P1: { V1: 9, V2: 9 }, V2: { V1: 7, P1: 7 } },
    })
    expect(phaseTransition(c, c.phases[1], c.phases[2]))
      .toMatchObject({ amber: 0, allRed: 9, total: 9 })
  })

  it('retient le dégagement le plus long de la traversée à défaut de case vers la phase suivante', () => {
    // V1 et P1 étant verts ensemble, le dossier les déclare compatibles : sa ligne ne cite que V2. Le temps
    // de dégagement dû reste celui de la traversée, un temps de marche.
    const c = dossierController({
      phases: [
        phase('pA', 'Nord-sud', 20, { groups: ['V2'] }),
        phase('pB', 'Est-ouest + traversée', 20, { groups: ['V1', 'P1'] }),
        phase('pC', 'Est-ouest', 20, { groups: ['V1'] }),
      ],
      interGreen: { V1: { V2: 6 }, P1: { V2: 9 }, V2: { V1: 7 } },
    })
    expect(phaseTransition(c, c.phases[1], c.phases[2])).toMatchObject({ allRed: 9, total: 9 })
  })

  it('ne réclame aucun dégagement quand la traversée ne rouvre rien', () => {
    // P1 ferme le tourne-à-gauche ouest ; la phase suivante n'ouvre que l'axe nord-sud, rien ne rouvre.
    const c = dossierController({
      phases: [phase('p1', 'Piétons', 20, { groups: ['P1'] }), phase('p2', 'Nord-sud', 20, { groups: ['V2'] })],
    })
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 0, allRed: 8, total: 8 })
  })

  it('sans matrice, l’orange et le rouge intégral de la phase s’appliquent comme avant', () => {
    const c = editorController()
    expect(phaseTransition(c, c.phases[0], c.phases[1])).toMatchObject({ amber: 3, allRed: 2, matrixBased: false })
    expect(phaseDuration(c, c.phases[0])).toBe(35)
    expect(controllerCycle(c)).toBe(70)
  })

  it('le temps de cycle additionne les inter-verts réels', () => {
    const c = dossierController()
    expect(controllerCycle(c)).toBe(20 + 8 + 25 + 7)
  })
})

/* ----------------------------- Plans horaires ----------------------------- */

describe('plans horaires', () => {
  const planned = (): SignalController => dossierController({
    plans: [
      { id: 'jour', name: 'Pointe', period: '7h-9h', cycle: 0, offset: 10, phases: { p1: { green: 30 } } },
      { id: 'creuse', name: 'Heure creuse', cycle: 0, offset: 0, phases: { p1: { green: 10 }, p2: { green: 10 } } },
      { id: 'nuit', name: 'Nuit', cycle: 0, offset: 0, phases: { p1: { green: 5 }, p2: { green: 5 } } },
    ],
    schedule: [
      { planId: 'jour', fromMin: 7 * 60, toMin: 9 * 60, days: [] },
      { planId: 'creuse', fromMin: 9 * 60, toMin: 22 * 60, days: [1, 2, 3, 4, 5] },
      { planId: 'nuit', fromMin: 22 * 60, toMin: 6 * 60, days: [] },
    ],
  })

  it('choisit le plan dont la plage couvre l’heure, bornes début incluse et fin exclue', () => {
    const c = planned()
    expect(activePlan(c, 8 * 60, 2)?.id).toBe('jour')
    expect(activePlan(c, 9 * 60, 2)?.id).toBe('creuse')
    expect(activePlan(c, 7 * 60 - 1, 2)?.id).toBe('jour') // aucune plage : repli sur le premier plan
  })

  it('gère une plage qui franchit minuit', () => {
    const c = planned()
    expect(activePlan(c, 23 * 60, 2)?.id).toBe('nuit')
    expect(activePlan(c, 30, 3)?.id).toBe('nuit') // 0 h 30, plage 22 h → 6 h
    expect(activePlan(c, 6 * 60, 3)?.id).toBe('jour') // 6 h : hors plage de nuit, repli
    expect(scheduleCovers({ planId: 'nuit', fromMin: 1320, toMin: 360, days: [] }, 0, 1)).toBe(true)
    expect(scheduleCovers({ planId: 'nuit', fromMin: 1320, toMin: 360, days: [] }, 700, 1)).toBe(false)
  })

  it('`days` vide vaut tous les jours, sinon le jour filtre la plage', () => {
    const c = planned()
    // Dimanche (7) : la plage creuse ne s'applique pas, on retombe sur le premier plan.
    expect(activePlan(c, 10 * 60, 7)?.id).toBe('jour')
    expect(activePlan(c, 10 * 60, 5)?.id).toBe('creuse')
    expect(activePlan(c, 23 * 60, 7)?.id).toBe('nuit')
  })

  it('sans plage horaire, le premier plan s’applique ; sans plan, les phases font foi', () => {
    const sansPlage = dossierController({ plans: planned().plans })
    expect(activePlan(sansPlage, 3 * 60, 4)?.id).toBe('jour')
    expect(defaultPlan(sansPlage)?.id).toBe('jour')
    expect(activePlan(dossierController(), 8 * 60, 2)).toBeUndefined()
    expect(defaultPlan(dossierController())).toBeUndefined()
  })

  it('rattache une plage de nuit au jour où elle commence', () => {
    // « 22 h - 6 h du lundi au vendredi » : cinq nuits ouvertes du lundi soir au vendredi soir. Le samedi
    // 1 h appartient à la nuit du vendredi (couverte), le lundi 1 h à celle du dimanche (hors plage).
    const nuit = { planId: 'nuit', fromMin: 22 * 60, toMin: 6 * 60, days: [1, 2, 3, 4, 5] }
    expect(scheduleCovers(nuit, 60, 6)).toBe(true)
    expect(scheduleCovers(nuit, 60, 1)).toBe(false)
    expect(scheduleCovers(nuit, 23 * 60, 5)).toBe(true)
    expect(scheduleCovers(nuit, 23 * 60, 6)).toBe(false)
    // Une plage qui ne franchit pas minuit reste jugée sur le jour courant.
    expect(scheduleCovers({ planId: 'jour', fromMin: 420, toMin: 540, days: [1] }, 480, 1)).toBe(true)
    expect(scheduleCovers({ planId: 'jour', fromMin: 420, toMin: 540, days: [1] }, 480, 2)).toBe(false)
  })

  it('signale le repli sur le premier plan sans changer le plan retenu', () => {
    const c = planned()
    expect(activePlanAt(c, 8 * 60, 2)).toMatchObject({ fallback: false })
    // 6 h 59 : aucune plage ne couvre l'heure. Le premier plan s'applique, mais ce n'est pas une plage du
    // dossier et l'interface doit pouvoir le dire.
    expect(activePlanAt(c, 7 * 60 - 1, 2)).toMatchObject({ fallback: true })
    expect(activePlanAt(c, 7 * 60 - 1, 2).plan?.id).toBe('jour')
    // Sans calendrier, le premier plan n'est pas un repli mais la règle ; sans plan, il n'y a rien à dire.
    expect(activePlanAt(dossierController({ plans: planned().plans }), 3 * 60, 4)).toMatchObject({ fallback: false })
    expect(activePlanAt(dossierController(), 8 * 60, 2)).toEqual({ plan: undefined, fallback: false })
  })

  it('les durées d’une phase absente du plan restent celles de la phase', () => {
    const c = planned()
    const jour = c.plans![0]
    expect(planPhaseTiming(c.phases[0], jour)).toEqual({ green: 30, minGreen: 7, maxGreen: 60, skipped: false })
    expect(planPhaseTiming(c.phases[1], jour)).toEqual({ green: 25, minGreen: 7, maxGreen: 60, skipped: false })
    expect(controllerCycle(c, jour)).toBe(30 + 8 + 25 + 7)
    expect(controllerCycle(c, c.plans![1])).toBe(10 + 8 + 10 + 7)
    // Sans argument, le premier plan sert de référence (règle « sans schedule »).
    expect(controllerCycle(c)).toBe(30 + 8 + 25 + 7)
  })

  it('l’heure simulée avance et change de jour à minuit', () => {
    expect(clockAt(8 * 60, 2, 0)).toEqual({ minOfDay: 480, dayOfWeek: 2 })
    expect(clockAt(8 * 60, 2, 3600)).toEqual({ minOfDay: 540, dayOfWeek: 2 })
    expect(clockAt(23 * 60 + 59, 2, 120)).toEqual({ minOfDay: 1, dayOfWeek: 3 })
    expect(clockAt(23 * 60, 7, 7200)).toEqual({ minOfDay: 60, dayOfWeek: 1 })
  })
})

/* ----------------------------- Validation et complétion ----------------------------- */

describe('validation d’un contrôleur de dossier', () => {
  it('distingue un mouvement fermé par un vert piéton d’un mouvement oublié', () => {
    const network = withController(dossierController())
    const anomalies = validateController(network, network.controllers.ctl)
    // 12 mouvements au carrefour, 4 verts ; le tourne-à-gauche ouest est fermé par P1, les 7 autres sont oubliés.
    expect(anomalies.some((a) => a.startsWith('7 mouvement(s) jamais au vert'))).toBe(true)
    const pieton = anomalies.find((a) => a.includes('vert piéton'))
    expect(pieton).toContain('1 mouvement(s)')
    expect(pieton).toContain('Rue wc à gauche')
  })

  it('signale un groupe absent du dossier', () => {
    const c = dossierController({
      phases: [phase('p1', 'Est-ouest', 20, { groups: ['V1', 'P9'] }), phase('p2', 'Nord-sud', 25, { groups: ['V2'] })],
    })
    const anomalies = validateController(withController(c), c)
    expect(anomalies.some((a) => a.includes('groupe(s) absent(s) du dossier (P9)'))).toBe(true)
  })

  it('signale un jaune plus long que l’inter-vert', () => {
    const c = dossierController({ interGreen: { V1: { V2: 2 }, P1: { V2: 2 }, V2: { V1: 7 } } })
    expect(validateController(withController(c), c).some((a) => a.includes('jaune tronqué'))).toBe(true)
  })

  it('signale une phase inconnue d’un plan et un plan inconnu d’une plage', () => {
    const c = dossierController({
      plans: [{ id: 'jour', name: 'Pointe', cycle: 100, offset: 0, phases: { p1: { green: 30 }, pX: { green: 10 } } }],
      schedule: [{ planId: 'absent', fromMin: 0, toMin: 600, days: [] }],
    })
    const anomalies = validateController(withController(c), c)
    expect(anomalies.some((a) => a.includes('phase inconnue (pX)'))).toBe(true)
    expect(anomalies.some((a) => a.includes('plan inconnu (absent)'))).toBe(true)
    // Cycle réel 30 + 8 + 25 + 7 = 70 s, contre 100 s annoncées au dossier.
    expect(anomalies.some((a) => a.includes('temps de cycle annoncé 100 s'))).toBe(true)
  })

  it('juge les durées de vert sur le plan de référence et non sur la phase seule', () => {
    const c = dossierController({
      phases: [phase('p1', 'Est-ouest', 0, { groups: ['V1', 'P1'] }), phase('p2', 'Nord-sud', 0, { groups: ['V2'] })],
      plans: [{ id: 'jour', name: 'Pointe', cycle: 0, offset: 0, phases: { p1: { green: 30 }, p2: { green: 25 } } }],
    })
    expect(validateController(withController(c), c).some((a) => a.includes('durée de vert nulle'))).toBe(false)
  })

  it('reste identique sur un contrôleur sans donnée de dossier', () => {
    const network = withController(editorController())
    const anomalies = validateController(network, network.controllers.ctl)
    expect(anomalies).toEqual([
      '8 mouvement(s) jamais au vert : Rue nc à gauche vers Rue ce, Rue nc à droite vers Rue cw, Rue sc à droite vers Rue ce….',
    ])
  })
})

describe('complétion des plans', () => {
  it('ne complète pas un plan issu d’un dossier et laisse ses phases intactes', () => {
    const network = withController(dossierController())
    const res = completeSignalPlans(network)
    expect(res.added).toBe(0)
    expect(res.skipped).toBe(8)
    expect(res.network).toBe(network) // identité préservée : aucun cache d'affichage invalidé
    expect(res.network.controllers.ctl.phases[0].movements).toEqual({})
  })

  it('complète encore un plan ordinaire', () => {
    const network = withController(editorController())
    const res = completeSignalPlans(network)
    expect(res.added).toBe(8)
    expect(res.skipped).toBe(0)
    expect(validateController(res.network, res.network.controllers.ctl)).toEqual([])
  })
})
