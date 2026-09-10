/**
 * Recherche rapide dans les listes de l'interface (tronçons, carrefours, entrées, sorties).
 *
 * Une commune donne des listes de plusieurs centaines de voies : les retrouver au tri seul est
 * impraticable. La comparaison ignore la casse, les accents et la forme de l'apostrophe — « eglise »
 * trouve « Rue de l’Église » — et les mots saisis sont cumulatifs mais libres d'ordre : « gare rue »
 * trouve « Rue de la Gare ». Chaque mot doit apparaître dans l'un des champs de la ligne.
 */

/** En deçà, la liste tient sous les yeux : un champ de recherche n'y ajouterait que du bruit. */
export const SEUIL_RECHERCHE = 10

/** Minuscules, sans accents ni signes diacritiques, apostrophes ramenées à `'`. */
export function normaliser(texte: string): string {
  return texte
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
}

/** Mots de la requête, normalisés ; une requête vide ou blanche ne donne aucun mot. */
export function motsDeRecherche(requete: string): string[] {
  return normaliser(requete).split(/\s+/).filter((mot) => mot.length > 0)
}

/** Vrai si tous les mots apparaissent dans l'un des champs de la ligne (une requête vide accepte tout). */
export function correspond(mots: string[], champs: (string | undefined)[]): boolean {
  if (!mots.length) return true
  // Les champs sont joints par un espace : un mot ne peut pas chevaucher deux champs par accident.
  const foin = normaliser(champs.filter((c): c is string => !!c).join(' '))
  return mots.every((mot) => foin.includes(mot))
}

/**
 * Filtre une liste sur la requête. Une requête sans mot renvoie la liste d'origine telle quelle,
 * ce qui évite de recopier plusieurs milliers de lignes à chaque rendu.
 */
export function filtrer<T>(lignes: T[], requete: string, champs: (ligne: T) => (string | undefined)[]): T[] {
  const mots = motsDeRecherche(requete)
  if (!mots.length) return lignes
  return lignes.filter((ligne) => correspond(mots, champs(ligne)))
}
