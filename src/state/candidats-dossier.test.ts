/**
 * Le store ne doit pas refaire le calcul de rattachement : une seconde règle, même proche, finirait par
 * proposer d'autres carrefours que ceux que l'import a écartés, donc à faire arbitrer de mauvais candidats.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { candidatsPourDossier, importDossiersFeux } from '@/geo/dossierFeux'
import type { NetEdge, Network } from '@/model/types'

/** Deux carrefours voisins : l'un porte les deux rues du dossier, l'autre une seule. */
function reseau(): Network {
  const nodes: Network['nodes'] = {
    a: { id: 'a', x: 0, y: 0, boundary: false },
    b: { id: 'b', x: 60, y: 0, boundary: false },
    n1: { id: 'n1', x: 0, y: 100, boundary: true },
    n2: { id: 'n2', x: -100, y: 0, boundary: true },
    n3: { id: 'n3', x: 0, y: -100, boundary: true },
    n4: { id: 'n4', x: 60, y: 100, boundary: true },
    n5: { id: 'n5', x: 160, y: 0, boundary: true },
    n6: { id: 'n6', x: 60, y: -100, boundary: true },
  }
  const edges: Record<string, NetEdge> = {}
  const lien = (id: string, from: string, to: string, nom: string) => {
    const mk = (i: string, f: string, t: string, rev: string): NetEdge => ({
      id: i, from: f, to: t, reverseOf: rev, name: nom, highway: 'residential', lanes: 1, maxspeed: 50,
      length: Math.hypot(nodes[t].x - nodes[f].x, nodes[t].y - nodes[f].y),
      geometry: [[nodes[f].x, nodes[f].y], [nodes[t].x, nodes[t].y]],
      roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
    })
    edges[id] = mk(id, from, to, id + 'r')
    edges[id + 'r'] = mk(id + 'r', to, from, id)
  }
  lien('e1', 'n1', 'a', 'Rue des Lilas')
  lien('e2', 'n2', 'a', 'Avenue Centrale')
  lien('e3', 'n3', 'a', 'Rue des Lilas')
  lien('e4', 'a', 'b', 'Avenue Centrale')
  lien('e5', 'n4', 'b', 'Rue du Moulin')
  lien('e6', 'n5', 'b', 'Avenue Centrale')
  lien('e7', 'n6', 'b', 'Rue du Moulin')
  return { nodes, edges, controls: {}, controllers: {} }
}

const dossier = {
  id: 'X1',
  nom: 'Avenue Centrale / Rue des Lilas',
  voies: ['Avenue Centrale', 'Rue des Lilas'],
  groupes: [
    { id: 'V1', type: 'vehicule', voie: 'Avenue Centrale' },
    { id: 'V2', type: 'vehicule', voie: 'Rue des Lilas' },
  ],
  phases: [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 30 }],
}

describe('candidatsPourDossier', () => {
  it('retient le carrefour qui porte le plus de rues du dossier', () => {
    const net = reseau()
    const candidats = candidatsPourDossier(net, dossier)
    expect(candidats.length).toBeGreaterThan(0)
    expect(candidats[0].nodeId).toBe('a')
    expect(candidats[0].ruesRetrouvees.sort()).toEqual(['Avenue Centrale', 'Rue des Lilas'])
  })

  it('propose exactement les carrefours que l’import a jugés équivalents', () => {
    const net = reseau()
    // Un dossier qui ne nomme qu'une rue partagée par les deux carrefours : égalité réelle.
    const ambigu = { ...dossier, voies: ['Avenue Centrale'], groupes: [{ id: 'V1', type: 'vehicule', voie: 'Avenue Centrale' }] }
    const res = importDossiersFeux({ carrefours: [ambigu] }, { network: net })
    const m = res.matches[0]
    const candidats = candidatsPourDossier(net, ambigu)
    if (m.nodeId === null) {
      expect(candidats.length).toBeGreaterThan(1)
      // Aucun candidat proposé ne doit être étranger à ce que l'import a considéré.
      for (const c of candidats) expect(['a', 'b']).toContain(c.nodeId)
    } else {
      expect(candidats.some((c) => c.nodeId === m.nodeId)).toBe(true)
    }
  })

  it('rend une liste vide pour un dossier qui ne nomme aucune voie du réseau', () => {
    expect(candidatsPourDossier(reseau(), { ...dossier, voies: ['Rue Introuvable'], groupes: [] })).toEqual([])
  })

  it('ne lève pas sur une entrée qui n’est pas un dossier', () => {
    expect(candidatsPourDossier(reseau(), null)).toEqual([])
    expect(candidatsPourDossier(reseau(), 'texte')).toEqual([])
  })
})
