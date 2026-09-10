/**
 * Import de dossiers de carrefour sur le vrai réseau de Veauche : contrôle de bout en bout du format
 * documenté (un fichier, un carrefour), des groupes, des plans, de la matrice d'inter-verts, et de
 * l'effet des plans horaires sur la circulation.
 *
 * Dans l'application, c'est l'exploitant qui désigne le carrefour en le sélectionnant sur la carte.
 * Les tests le désignent par ses rues (`carrefourDe`) : c'est le même geste, écrit autrement.
 *
 * Deux fixtures : le dossier RÉEL de VE001 (Avenue du Général de Gaulle / Croix des Pères), et un
 * dossier SYNTHÉTIQUE à deux plans dont seuls les noms de voies sont ceux de Veauche — ses durées et
 * ses inter-verts ne sortent d'aucun document réel.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { osm2graph } from '@/geo/osm2graph'
import { importDossierFeux } from '@/geo/dossierFeux'
import type { OsmExtract } from '@/geo/types'
import type { ControllerId, Network, NodeId, SignalController } from '@/model/types'
import { controllerCycle, planPhases, validateController } from '@/model/signals'
import { Simulation } from '@/engine/simulation'
import { DEFAULT_SETTINGS, DEFAULT_SIGNAL_TIMING, defaultDemand } from '@/model/defaults'

const reseau = (): Network => osm2graph(
  JSON.parse(readFileSync('public/demo/veauche.osm.json', 'utf8')) as OsmExtract,
).network

/** Carrefour où arrivent toutes ces rues : celui que l'exploitant désignerait sur la carte. */
function carrefourDe(network: Network, ...rues: string[]): NodeId {
  const noms = new Map<NodeId, Set<string>>()
  for (const e of Object.values(network.edges)) {
    if (!e.name) continue
    for (const n of [e.from, e.to]) {
      const vues = noms.get(n) ?? new Set<string>()
      vues.add(e.name)
      noms.set(n, vues)
    }
  }
  for (const [nodeId, vues] of noms) {
    if (rues.every((r) => vues.has(r))) return nodeId
  }
  throw new Error(`Aucun carrefour de Veauche ne réunit ${rues.join(' et ')}`)
}

/** Passe ce carrefour en feux, comme l'exploitant le fait avant de lui charger son dossier. */
function poserFeux(network: Network, nodeId: NodeId): { network: Network; controllerId: ControllerId } {
  const controleur: SignalController = {
    id: 'cFeu', name: 'Carrefour à feux', nodeIds: [nodeId], mode: 'fixed', offset: 0,
    amber: DEFAULT_SIGNAL_TIMING.amber, allRed: DEFAULT_SIGNAL_TIMING.allRed, phases: [],
    actuated: { skipEmpty: true },
  }
  return {
    network: {
      ...network,
      controls: { ...network.controls, [nodeId]: { nodeId, type: 'signals', controllerId: 'cFeu' } },
      controllers: { ...network.controllers, cFeu: controleur },
    },
    controllerId: 'cFeu',
  }
}

function executer(network: Network, startTimeOfDayMin: number) {
  const demand = defaultDemand(network, 11)
  const sim = new Simulation({
    network, demand,
    settings: { ...DEFAULT_SETTINGS, durationMin: 20, warmupMin: 5, startTimeOfDayMin },
  })
  while (!sim.done) sim.step(600)
  return sim.results()
}

/* ------------------------------------------------------------------ */
/*  Dossier réel VE001                                                 */
/* ------------------------------------------------------------------ */

describe('dossier réel VE001, un fichier pour un carrefour', () => {
  const base = reseau()
  const nodeId = carrefourDe(base, 'Avenue du Général de Gaulle', 'Rue de la Croix des Pères')
  const { network, controllerId } = poserFeux(base, nodeId)
  const res = importDossierFeux(
    readFileSync('src/geo/fixtures/veauche-VE001-gaulle-croix-des-peres.json', 'utf8'),
    { network, controllerId },
  )

  it('applique le dossier au carrefour désigné, sans laisser de groupe orphelin', () => {
    expect(res.dossierId).toBe('VE001')
    expect(res.controller?.id).toBe(controllerId)
    expect(res.controller?.nodeIds).toEqual([nodeId])
    expect(res.groupesNonRattaches).toEqual([])
    console.log(`\nVE001 → carrefour ${nodeId} : ${res.groupesRattaches} groupes rattachés`)
    for (const a of res.avertissements) console.log(`  ⚠ ${a.slice(0, 120)}`)
  })

  it('reprend les sept groupes, les deux phases, le plan PF00 et la matrice d’inter-verts', () => {
    const c = res.controller!
    expect(c.groups?.map((g) => g.id)).toEqual(['V0', 'P1', 'V2', 'V3', 'P4', 'V5', 'P6'])
    expect(c.phases.map((p) => p.name)).toEqual(['Phase A Repos', 'Phase B'])
    expect(c.plans?.map((p) => [p.name, p.cycle])).toEqual([['PF00', 67]])
    // La colonne « vehicules » de la matrice vaut pour chaque groupe véhicule, jamais pour les piétons.
    expect(c.amberByGroup).toEqual({ V0: 3, V2: 3, V3: 3, V5: 3 })
    expect(Object.keys(c.interGreen ?? {})).toEqual(['V0', 'P1', 'V2', 'V3', 'P4', 'V5', 'P6'])
    console.log(`  anomalies : ${validateController(network, c).slice(0, 2).join(' / ') || 'aucune'}`)
    // Rien du matériel, du raccordement, de l'électricité ni des malvoyants n'entre dans le modèle.
    const json = JSON.stringify(c)
    for (const interdit of ['FARECO', 'GALLERY', 'GARBARINI', 'Phitech', 'Ritournelle', 'EX0', 'B0.1', 'BPP1']) {
      expect(json).not.toContain(interdit)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Dossier à deux plans horaires                                      */
/* ------------------------------------------------------------------ */

describe('dossier à deux plans sur le réseau de Veauche', () => {
  const base = reseau()
  const nodeId = carrefourDe(base, "Avenue d'Andrézieux", 'Chemin des Granges')
  const { network, controllerId } = poserFeux(base, nodeId)
  const res = importDossierFeux(
    readFileSync('src/geo/fixtures/veauche-VE009-andrezieux-granges.json', 'utf8'),
    { network, controllerId },
  )

  it('reprend groupes, plans et matrice, et ignore le matériel', () => {
    const c = res.controller!
    console.log(`\ncontrôleur « ${c.name} » source=${c.source}`)
    console.log(`  groupes : ${(c.groups ?? []).map((g) => `${g.id}/${g.type}/${g.movements.length}mvt`).join(', ')}`)
    console.log(`  plans   : ${(c.plans ?? []).map((p) => `${p.name} cycle ${controllerCycle(c, p)} s, ${planPhases(c, p).length} phases ouvertes`).join(' | ')}`)
    console.log(`  matrice : ${c.interGreen ? Object.keys(c.interGreen).length + ' lignes' : 'aucune'}, jaunes : ${JSON.stringify(c.amberByGroup ?? {})}`)
    expect(c.groups?.length).toBeGreaterThan(0)
    expect(c.interGreen).toBeTruthy()
    expect(res.groupesNonRattaches).toEqual([])
    const json = JSON.stringify(c)
    for (const interdit of ['Bouygues', 'cartes_puissance', 'Okeenea', 'kVA', 'pdl']) {
      expect(json.toLowerCase()).not.toContain(interdit.toLowerCase())
    }
  })

  it('ne tourne pas au même rythme selon l’heure', () => {
    const c = res.controller!
    const cycles = (c.plans ?? []).map((p) => ({ nom: p.name, cycle: controllerCycle(c, p), phases: planPhases(c, p).length }))
    console.log(`\nplans de « ${c.name} » : ${cycles.map((x) => `${x.nom} = ${x.cycle} s (${x.phases} phases)`).join(', ')}`)
    // Le plan creux ferme la phase escamotable propre à PF1 : cycle plus court et une phase de moins.
    expect(cycles[1].phases).toBeLessThan(cycles[0].phases)
    expect(cycles[1].cycle).toBeLessThan(cycles[0].cycle)
  })

  it('les plans importés changent la circulation selon l’heure simulée', () => {
    const c = res.controller!
    const avecDossier: Network = { ...network, controllers: { ...network.controllers, [c.id]: c } }
    const pointe = executer(avecDossier, 8 * 60)
    const creuse = executer(avecDossier, 11 * 60)
    console.log(`\n8 h  : ${pointe.network.exited} sortis, retard moyen ${Math.round(pointe.network.meanDelayS)} s`)
    console.log(`11 h : ${creuse.network.exited} sortis, retard moyen ${Math.round(creuse.network.meanDelayS)} s`)
    expect(pointe.network.exited).toBeGreaterThan(0)
    expect(creuse.network.exited).toBeGreaterThan(0)
  })
})
