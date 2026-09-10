/**
 * Recherche rapide dans les listes : ce qu'un exploitant tape doit trouver le nom réellement porté
 * par la voie, quelles que soient la casse, les accents et la forme de l'apostrophe.
 */
import { describe, expect, it } from 'vitest'
import { correspond, filtrer, motsDeRecherche, normaliser } from '@/ui/components/recherche'

describe('normaliser', () => {
  it('retire accents et casse', () => {
    expect(normaliser('Rue de l’Église')).toBe("rue de l'eglise")
    expect(normaliser('Boulevard Général Éluard')).toBe('boulevard general eluard')
  })

  it('ramène les apostrophes à une seule forme', () => {
    expect(normaliser('L’Étoile')).toBe(normaliser("L'Etoile"))
  })
})

describe('motsDeRecherche', () => {
  it('ignore les espaces superflus', () => {
    expect(motsDeRecherche('  rue   gare ')).toEqual(['rue', 'gare'])
  })

  it('ne rend aucun mot pour une saisie vide', () => {
    expect(motsDeRecherche('   ')).toEqual([])
  })
})

describe('correspond', () => {
  const champs = ['Rue de la Gare', 'Départementale']

  it('trouve sans accent ni casse', () => {
    expect(correspond(motsDeRecherche('GARE'), ['Rue de la Gare'])).toBe(true)
    expect(correspond(motsDeRecherche('departementale'), champs)).toBe(true)
    expect(correspond(motsDeRecherche('eglise'), ['Place de l’Église'])).toBe(true)
  })

  it('cumule les mots sans imposer leur ordre', () => {
    expect(correspond(motsDeRecherche('gare rue'), champs)).toBe(true)
    expect(correspond(motsDeRecherche('gare mairie'), champs)).toBe(false)
  })

  it('accepte un mot trouvé dans un autre champ que le premier', () => {
    expect(correspond(motsDeRecherche('gare departementale'), champs)).toBe(true)
  })

  it('ne laisse pas un mot chevaucher deux champs', () => {
    expect(correspond(motsDeRecherche('garedepartementale'), champs)).toBe(false)
  })

  it('trouve un nom composé écrit sans trait d’union', () => {
    expect(correspond(motsDeRecherche('saint just'), ['Rue de Saint-Just'])).toBe(true)
  })

  it('accepte tout quand la requête est vide', () => {
    expect(correspond(motsDeRecherche(''), champs)).toBe(true)
    expect(correspond(motsDeRecherche('  '), [])).toBe(true)
  })

  it('ignore les champs absents', () => {
    expect(correspond(motsDeRecherche('gare'), [undefined, 'Rue de la Gare'])).toBe(true)
  })
})

describe('filtrer', () => {
  const voies = [
    { nom: 'Rue de la Gare', classe: 'Résidentielle' },
    { nom: 'Route de Saint-Étienne', classe: 'Départementale' },
    { nom: 'Chemin des Vignes', classe: 'Résidentielle' },
  ]
  const champs = (v: (typeof voies)[number]): string[] => [v.nom, v.classe]

  it('ne retient que les lignes correspondantes', () => {
    expect(filtrer(voies, 'etienne', champs).map((v) => v.nom)).toEqual(['Route de Saint-Étienne'])
    expect(filtrer(voies, 'residentielle', champs)).toHaveLength(2)
  })

  it('rend la liste d’origine, sans copie, pour une requête vide', () => {
    expect(filtrer(voies, '   ', champs)).toBe(voies)
  })

  it('rend une liste vide quand rien ne correspond', () => {
    expect(filtrer(voies, 'périphérique', champs)).toEqual([])
  })
})
