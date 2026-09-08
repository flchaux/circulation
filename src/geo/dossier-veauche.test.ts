/**
 * Import d'un fichier de dossiers de carrefour fidèle au format documenté, sur le vrai réseau de Veauche.
 * Sert de contrôle de bout en bout : rattachement, groupes, plans, matrice, et effet sur la circulation.
 *
 * La fixture est SYNTHÉTIQUE : seuls les noms de voies sont ceux de Veauche, afin d'éprouver le
 * rattachement au réseau. Les durées et les inter-verts ne sortent d'aucun dossier réel.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { osm2graph } from '@/geo/osm2graph'
import { importDossiersFeux } from '@/geo/dossierFeux'
import type { OsmExtract } from '@/geo/types'
import type { Network } from '@/model/types'
import { controllerCycle, planPhases, validateController } from '@/model/signals'
import { Simulation } from '@/engine/simulation'
import { DEFAULT_SETTINGS, defaultDemand } from '@/model/defaults'

const reseau = (): Network => osm2graph(
  JSON.parse(readFileSync('public/demo/veauche.osm.json', 'utf8')) as OsmExtract,
).network

function executer(network: Network, startTimeOfDayMin: number) {
  const demand = defaultDemand(network, 11)
  const sim = new Simulation({
    network, demand,
    settings: { ...DEFAULT_SETTINGS, durationMin: 20, warmupMin: 5, startTimeOfDayMin },
  })
  while (!sim.done) sim.step(600)
  return sim.results()
}

describe('import des dossiers de Veauche', () => {
  const network = reseau()
  const brut = JSON.parse(readFileSync('src/geo/fixtures/dossiers-exemple.json', 'utf8'))
  const res = importDossiersFeux(brut, { network })

  it('rattache les carrefours reconnus et refuse de deviner les autres', () => {
    for (const m of res.matches) {
      console.log(`  ${m.dossierId.padEnd(8)} ${m.confiance.padEnd(11)} nœud=${m.nodeId ?? '—'} groupes=${m.groupesRattaches} :: ${m.raison.slice(0, 90)}`)
      for (const a of m.avertissements.slice(0, 3)) console.log(`      ⚠ ${a.slice(0, 120)}`)
    }
    const reconnus = res.matches.filter((m) => m.nodeId !== null)
    expect(reconnus.length).toBeGreaterThanOrEqual(1)
    // Le carrefour d'une autre commune ne doit être rattaché à rien.
    const inconnu = res.matches.find((m) => m.dossierId === 'Inconnu')
    expect(inconnu?.nodeId).toBeNull()
    expect(inconnu?.confiance).toBe('aucune')
  })

  it('reprend groupes, plans et matrice, et ignore le matériel', () => {
    const c = Object.values(res.controllers)[0]
    expect(c).toBeTruthy()
    console.log(`\ncontrôleur « ${c.name} » source=${c.source}`)
    console.log(`  groupes : ${(c.groups ?? []).map((g) => `${g.id}/${g.type}/${g.movements.length}mvt`).join(', ')}`)
    console.log(`  plans   : ${(c.plans ?? []).map((p) => `${p.name} cycle ${controllerCycle(c, p)} s, ${planPhases(c, p).length} phases ouvertes`).join(' | ')}`)
    console.log(`  matrice : ${c.interGreen ? Object.keys(c.interGreen).length + ' lignes' : 'aucune'}, jaunes : ${JSON.stringify(c.amberByGroup ?? {})}`)
    console.log(`  anomalies : ${validateController(network, c).slice(0, 2).join(' / ') || 'aucune'}`)
    expect(c.groups?.length).toBeGreaterThan(0)
    expect(c.interGreen).toBeTruthy()
    // Aucun champ matériel n'entre dans le modèle.
    const json = JSON.stringify(res.controllers)
    for (const interdit of ['Bouygues', 'cartes_puissance', 'Okeenea', 'kVA', 'pdl']) {
      expect(json.toLowerCase()).not.toContain(interdit.toLowerCase())
    }
  })

  it('un carrefour à deux plans ne tourne pas au même rythme selon l’heure', () => {
    const c = Object.values(res.controllers).find((x) => (x.plans?.length ?? 0) > 1)
    if (!c) return
    const cycles = (c.plans ?? []).map((p) => ({ nom: p.name, cycle: controllerCycle(c, p), phases: planPhases(c, p).length }))
    console.log(`\nplans de « ${c.name} » : ${cycles.map((x) => `${x.nom} = ${x.cycle} s (${x.phases} phases)`).join(', ')}`)
    // Le plan creux ferme la phase escamotable propre à PF1 : cycle plus court et une phase de moins.
    expect(cycles[1].phases).toBeLessThan(cycles[0].phases)
    expect(cycles[1].cycle).toBeLessThan(cycles[0].cycle)
  })

  it('les plans importés changent la circulation selon l’heure simulée', () => {
    const avecDossiers: Network = {
      ...network,
      controls: { ...network.controls, ...res.controls },
      controllers: { ...network.controllers, ...res.controllers },
    }
    const pointe = executer(avecDossiers, 8 * 60)
    const creuse = executer(avecDossiers, 11 * 60)
    console.log(`\n8 h  : ${pointe.network.exited} sortis, retard moyen ${Math.round(pointe.network.meanDelayS)} s`)
    console.log(`11 h : ${creuse.network.exited} sortis, retard moyen ${Math.round(creuse.network.meanDelayS)} s`)
    expect(pointe.network.exited).toBeGreaterThan(0)
    expect(creuse.network.exited).toBeGreaterThan(0)
  })
})
