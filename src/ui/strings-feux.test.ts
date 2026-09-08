/**
 * Ce que l'interface dit des groupes piétons (docs/ARCHITECTURE.md §14.5).
 *
 * Les textes du panneau Feux s'adressent à un technicien voirie qui compare l'écran à son dossier de
 * carrefour : une phrase fausse y coûte plus cher qu'un défaut d'affichage, puisqu'elle décrit un
 * fonctionnement que le simulateur n'a pas. Ces tests figent donc la règle de §14.5 dans les chaînes
 * elles-mêmes — un vert piéton concomitant *déclasse* les mouvements sécants, il ne les ferme pas — et
 * vérifient que le panneau affiche bien la réserve documentée sur leur capacité.
 *
 * Le dépôt n'embarque aucun moteur de rendu DOM ; le câblage du panneau est donc contrôlé sur sa source,
 * faute de pouvoir monter le composant.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { S } from '@/ui/strings'

/** Toutes les chaînes visibles, quel que soit leur niveau d'imbrication dans `S`. */
function toutesLesChaines(valeur: unknown, chemin = 'S'): [string, string][] {
  if (typeof valeur === 'string') return [[chemin, valeur]]
  if (!valeur || typeof valeur !== 'object') return []
  return Object.entries(valeur).flatMap(([cle, v]) => toutesLesChaines(v, `${chemin}.${cle}`))
}

const PANNEAU = readFileSync('src/ui/panels/FeuxPanel.tsx', 'utf8')

describe('textes du panneau Feux sur les traversées piétonnes', () => {
  it('ne dit nulle part qu’un vert piéton interdit ou ferme un mouvement véhicule', () => {
    // Les tournures négatives (« ne ferme pas ») disent l'inverse et sont retirées avant l'examen.
    const sansNegation = (texte: string) =>
      texte.replace(/n[e’']\s*(?:\w+\s+){0,3}(?:ferme\w*|interdi\w*)[^.;:]*?\bpas\b/gi, '')
    const fautives = toutesLesChaines(S)
      .filter(([, texte]) => /vert piéton|traversée/i.test(texte))
      .filter(([, texte]) => /interdi|ferm/i.test(sansNegation(texte)))
    expect(fautives).toEqual([])
  })

  it('explique le déclassement de protégé à permis et la cession aux piétons', () => {
    const aide = S.feux.groupePietonAide
    expect(aide).toMatch(/ne ferme pas/)
    expect(aide).toMatch(/protégé/)
    expect(aide).toMatch(/permis/)
    expect(aide).toMatch(/cède/)
    // Le seul cas de rouge est le temps piéton protégé : le dire évite de faire chercher une exception.
    expect(aide).toMatch(/rouge/)
  })

  it('porte la réserve sur la capacité d’un mouvement qui ne cède qu’à des piétons', () => {
    expect(S.feux.groupePietonReserve).toMatch(/optimiste/)
    expect(S.feux.groupePietonReserve).toMatch(/demande piétonne/)
  })

  it('affiche cette réserve avec la liste des groupes, et l’explication du « permis » sous le schéma', () => {
    expect(PANNEAU).toContain('S.feux.groupePietonAide')
    expect(PANNEAU).toContain('S.feux.groupePietonReserve')
    expect(PANNEAU).toContain('S.feux.schemaGroupesPietons')
    // La note du schéma n'a de sens que sur une phase qui cède effectivement à des piétons.
    expect(PANNEAU).toContain('phasePedestrianYields')
  })

  it('ne décrit plus, dans ses commentaires, un vert piéton qui ferme des mouvements', () => {
    expect(PANNEAU).not.toMatch(/leur vert fermant/)
    expect(PANNEAU).not.toMatch(/moins les\s*\n?\s*\/\/ mouvements que coupe un vert piéton/)
  })
})
