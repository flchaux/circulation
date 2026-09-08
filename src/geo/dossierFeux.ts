/**
 * Import d'un fichier de « dossiers de carrefour » (voir docs/ARCHITECTURE.md §14).
 *
 * Un dossier de carrefour est le document d'exploitation d'un carrefour à feux réel : il décrit les groupes
 * de signaux, les phases, les plans horaires et les temps de sécurité. Seule la partie qui gouverne
 * l'écoulement du trafic est reprise ; tout ce qui relève du matériel, du câblage, de l'électricité, des
 * contrôles réglementaires ou des dispositifs pour malvoyants est délibérément ignoré (§14.2) : le reprendre
 * alourdirait le format de projet sans changer un seul résultat de simulation.
 *
 * Trois partis pris guident ce module, parce qu'il lit des documents rédigés par des humains, hétérogènes
 * d'un dossier à l'autre :
 *  - il ne lève JAMAIS d'exception : un fichier illisible produit un résultat vide et des avertissements ;
 *  - il ne devine JAMAIS en silence : un rattachement douteux laisse `nodeId` à null et s'explique en français ;
 *  - il ne laisse JAMAIS une clé venant du fichier indexer un objet ordinaire : une ligne de matrice nommée
 *    « __proto__ » écrirait sur `Object.prototype`, et cette pollution survivrait à l'import pour toute la
 *    session du navigateur. Les clés externes passent par une `Map` ou par le filtre `cleReservee`.
 */
import type {
  ControllerId, GreenKind, InterGreenMatrix, MovementKey, Network, NodeControl, NodeId,
  PlanPhaseTiming, PlanSchedule, SignalController, SignalGroup, SignalPhase, SignalPlan,
} from '@/model/types'
import { DEFAULT_SIGNAL_TIMING } from '@/model/defaults'
import { type Adjacency, type Movement, buildAdjacency } from '@/model/geometry'
import { controllerMovements, phaseTransition, planPhaseTiming, planPhases } from '@/model/signals'

/* ------------------------------------------------------------------ */
/*  Contrat                                                            */
/* ------------------------------------------------------------------ */

export interface DossierImportOptions {
  network: Network
}

export interface DossierMatch {
  /** Identifiant du dossier (VE001, VE005, « Place de l'Europe »…). */
  dossierId: string
  nom: string
  /** Carrefour du réseau reconnu, `null` si le rattachement n'est pas certain. */
  nodeId: NodeId | null
  controllerId: ControllerId | null
  confiance: 'sure' | 'probable' | 'incertaine' | 'aucune'
  /** Pourquoi ce rattachement (ou son absence), en français, destiné à l'exploitant. */
  raison: string
  groupesRattaches: number
  groupesNonRattaches: string[]
  avertissements: string[]
}

export interface DossierImportResult {
  /** Contrôleurs prêts à être fusionnés dans `network.controllers`. */
  controllers: Record<ControllerId, SignalController>
  /** Régulations à fusionner dans `network.controls` : les nœuds reconnus passent en `signals`. */
  controls: Record<NodeId, NodeControl>
  matches: DossierMatch[]
  avertissements: string[]
}

/* ------------------------------------------------------------------ */
/*  Lecture tolérante du JSON                                          */
/* ------------------------------------------------------------------ */

type Rec = Record<string, unknown>

function estObjet(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function chaine(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Nombre fini, sinon `null`. Accepte « 40 » et « 40 s » (les dossiers mélangent les deux).
 * Le signe n'est pas jugé ici : c'est `duree()` qui écarte les valeurs hors domaine et le signale.
 */
function nombre(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const m = /-?\d+(?:[.,]\d+)?/.exec(v)
    if (!m) return null
    const n = Number(m[0].replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function tableau(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Liste de chaînes, en acceptant une chaîne seule et des objets porteurs d'un champ `nom`/`voie`. */
function listeDeChaines(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  const out: string[] = []
  for (const item of tableau(v)) {
    if (typeof item === 'string') out.push(item)
    else if (estObjet(item)) {
      const s = chaine(item.nom) || chaine(item.voie) || chaine(item.libelle) || chaine(item.id)
      if (s) out.push(s)
    }
  }
  return out
}

/**
 * Clés qu'un fichier ne peut pas employer comme index d'objet : `objet['__proto__'] = …` écrit sur
 * `Object.prototype` et contamine toute la session, pas seulement le dossier en cours ; `constructor` et
 * `prototype` masquent des membres du langage. Aucun dossier réel ne nomme un groupe ainsi : la clé est
 * écartée et signalée plutôt que subie.
 */
const CLES_RESERVEES = new Set(['__proto__', 'constructor', 'prototype'])

function cleReservee(cle: string): boolean {
  return CLES_RESERVEES.has(cle)
}

/**
 * Valeur d'une case de matrice, en ignorant tout ce qui viendrait du prototype : `matrice['toString']`
 * répond une fonction sur un objet ordinaire, ce qui ferait passer deux groupes pour incompatibles.
 */
function caseDe(matrice: InterGreenMatrix, de: string, vers: string): number | undefined {
  const ligne = Object.prototype.hasOwnProperty.call(matrice, de) ? matrice[de] : undefined
  if (!ligne || !Object.prototype.hasOwnProperty.call(ligne, vers)) return undefined
  return ligne[vers]
}

/** Nom français du type d'une valeur, pour dire à l'exploitant ce que le dossier porte réellement. */
function typeDeValeur(v: unknown): string {
  if (Array.isArray(v)) return 'liste'
  if (v === null) return 'valeur nulle'
  switch (typeof v) {
    case 'string': return 'texte'
    case 'number': return 'nombre'
    case 'boolean': return 'booléen'
    case 'object': return 'objet'
    default: return typeof v
  }
}

/**
 * Durée en secondes lue au dossier. Une durée négative est une faute de saisie : la retenir donnerait un
 * vert négatif, que le simulateur consommerait comme un vert nul sans jamais le dire à l'exploitant.
 */
function duree(v: unknown, quoi: string, avertissements: string[]): number | null {
  const n = nombre(v)
  if (n === null) return null
  if (n < 0) {
    avertissements.push(`${quoi} : durée négative (${n} s) hors domaine, valeur écartée.`)
    return null
  }
  return n
}

/** Vert minimal et maximal d'une phase, débarrassés des valeurs hors domaine (négatives, maxi < mini). */
function bornesDeVert(
  miniBrut: unknown,
  maxiBrut: unknown,
  quoi: string,
  avertissements: string[],
): { mini: number | null; maxi: number | null } {
  const mini = duree(miniBrut, quoi, avertissements)
  let maxi = duree(maxiBrut, quoi, avertissements)
  if (mini !== null && maxi !== null && maxi < mini) {
    // Un maxi inférieur au mini rendrait la marge de prolongation négative : le maxi est ramené au mini.
    avertissements.push(`${quoi} : vert maximal (${maxi} s) inférieur au vert minimal (${mini} s) ; le maximum est ramené au minimum.`)
    maxi = null
  }
  return { mini, maxi }
}

/** Un champ du dossier porte-t-il une information ? Un tableau ou un texte vide ne déclare rien. */
function renseigne(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  if (estObjet(v)) return Object.keys(v).length > 0
  return true
}

/* ------------------------------------------------------------------ */
/*  Normalisation des libellés de voies                                */
/* ------------------------------------------------------------------ */

/**
 * Abréviations courantes des dossiers et des plans, ramenées au mot entier.
 * Une `Map` et non un objet : un mot de voie nommé « constructor » lirait sinon une propriété héritée
 * d'`Object.prototype` et remplacerait le mot par du code.
 */
const ABREVIATIONS = new Map<string, string>(Object.entries({
  av: 'avenue', ave: 'avenue', aven: 'avenue',
  bd: 'boulevard', bld: 'boulevard', blvd: 'boulevard', boul: 'boulevard',
  rte: 'route', rt: 'route',
  r: 'rue',
  ch: 'chemin', chem: 'chemin',
  pl: 'place',
  imp: 'impasse',
  all: 'allee', allee: 'allee',
  sq: 'square',
  crs: 'cours',
  mte: 'montee',
  st: 'saint', ste: 'sainte', sts: 'saints', stes: 'saintes',
  gal: 'general', gnl: 'general', gen: 'general', gral: 'general',
  dr: 'docteur',
  mal: 'marechal',
  pdt: 'president', pst: 'president',
  cdt: 'commandant',
  fg: 'faubourg',
  gd: 'grand', gde: 'grande',
  crf: 'carrefour',
  trav: 'traversee', tp: 'traversee',
}))

/** Mots de type de voie, retirés en tête pour comparer les noms propres entre eux. */
const TYPES_VOIE = new Set([
  'rue', 'ruelle', 'avenue', 'boulevard', 'route', 'chemin', 'place', 'impasse', 'allee', 'allees',
  'square', 'cours', 'quai', 'montee', 'voie', 'esplanade', 'rond', 'point', 'giratoire', 'carrefour',
  'traversee', 'traversees', 'passage', 'pieton', 'pietons', 'pietonne', 'pietonnes', 'sente', 'faubourg',
  'branche', 'axe', 'direction', 'sens',
])

/** Particules et articles, retirés en tête et en queue du noyau. */
const PARTICULES = new Set(['de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'et', 'en', 'sur', 'sous'])

function sansAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Libellé de voie comparable : forme complète normalisée + noyau (nom propre seul). */
export interface LibelleVoie {
  /** Libellé d'origine, pour les messages destinés à l'exploitant. */
  brut: string
  /** Forme normalisée complète (« avenue de la liberation »). */
  plein: string
  /** Nom propre seul (« liberation »), type de voie et articles retirés. */
  noyau: string
}

/**
 * Normalise un libellé : accents, casse, ponctuation, abréviations, numéros de route départementale.
 * « Av. Gal de Gaulle » et « Avenue du Général de Gaulle » se ramènent au même noyau « general de gaulle ».
 */
export function normaliserVoie(brut: string): LibelleVoie | null {
  const base = sansAccents(brut.toLowerCase())
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!base) return null
  // Routes numérotées : « RD 1082 », « route departementale 1082 » et « D1082 » sont la même voie.
  const numerotee = base
    .replace(/\b(?:rd|route departementale|departementale)\s*(\d+)\b/g, 'd$1')
    .replace(/\b(?:rn|route nationale|nationale)\s*(\d+)\b/g, 'n$1')
  const mots = numerotee.split(' ').filter(Boolean).map((m) => ABREVIATIONS.get(m) ?? m)
  if (!mots.length) return null
  const plein = mots.join(' ')
  let debut = 0
  while (debut < mots.length - 1 && (TYPES_VOIE.has(mots[debut]) || PARTICULES.has(mots[debut]))) debut++
  let fin = mots.length
  while (fin > debut + 1 && PARTICULES.has(mots[fin - 1])) fin--
  const noyau = mots.slice(debut, fin).join(' ')
  return { brut: brut.trim(), plein, noyau: noyau || plein }
}

/** Découpe un libellé composé (« Av. de Gaulle / Croix des Pères », « Libération (RD 1082) ») en voies. */
export function libellesDeVoies(brut: unknown): LibelleVoie[] {
  const out: LibelleVoie[] = []
  for (const texte of listeDeChaines(brut)) {
    for (const part of texte.split(/[/,;()–—]|\bx\b/i)) {
      const v = normaliserVoie(part)
      // Un fragment de deux caractères ne discrimine rien : il ferait autant de faux rattachements.
      if (v && v.noyau.length >= 3) out.push(v)
    }
  }
  return out
}

function contientMots(botte: string, aiguille: string): boolean {
  return ` ${botte} `.includes(` ${aiguille} `)
}

/** Deux libellés désignent-ils la même voie ? Égalité du noyau, ou inclusion d'un noyau assez long. */
export function memeVoie(a: LibelleVoie, b: LibelleVoie): boolean {
  if (a.plein === b.plein || a.noyau === b.noyau) return true
  if (a.noyau.length >= 5 && contientMots(b.noyau, a.noyau)) return true
  if (b.noyau.length >= 5 && contientMots(a.noyau, b.noyau)) return true
  return false
}

/* ------------------------------------------------------------------ */
/*  Heures et jours du calendrier                                      */
/* ------------------------------------------------------------------ */

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

function normaliserTexte(s: string): string {
  return sansAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Toutes les heures d'un texte, en minutes depuis minuit (« 6h30-9h » → [390, 540]). */
export function heuresDuTexte(texte: string): number[] {
  const out: number[] = []
  const re = /(\d{1,2})\s*[h:.]\s*(\d{2})?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(texte))) {
    const h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    if (h > 24 || min > 59) continue
    out.push(h * 60 + min)
  }
  return out
}

/**
 * Toutes les plages d'un texte, en paires d'heures : « 07h00-09h00 et 16h30-19h00 » en donne deux.
 * Ne retenir que les deux premières heures ferait disparaître la tranche du soir sans le dire.
 */
export function plagesDuTexte(texte: string): { plages: [number, number][]; heureOrpheline: boolean } {
  const h = heuresDuTexte(texte)
  const plages: [number, number][] = []
  for (let i = 0; i + 1 < h.length; i += 2) plages.push([h[i], h[i + 1]])
  return { plages, heureOrpheline: h.length % 2 === 1 }
}

/** Une heure isolée (champ `debut`, `fin`), en minutes depuis minuit. */
export function heureEnMinutes(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Un nombre seul est une heure pleine (« 7 ») ; au-delà de 24 il est déjà exprimé en minutes.
    return v <= 24 ? Math.round(v * 60) : Math.round(v)
  }
  const s = chaine(v)
  if (!s) return null
  const heures = heuresDuTexte(s)
  if (heures.length) return heures[0]
  if (/^\d{1,2}$/.test(s)) {
    const h = Number(s)
    return h <= 24 ? h * 60 : null
  }
  return null
}

/**
 * Jours désignés par un libellé de type de jour, numérotés 1 (lundi) à 7 (dimanche).
 * Liste vide = tous les jours. `null` = libellé non reconnu (l'appelant avertit plutôt que de supposer).
 */
export function joursDuLibelle(brut: string): number[] | null {
  const s = normaliserTexte(brut)
  if (!s) return null
  if (/\b(tous|toute|toutes|tout|chaque|quotidien|permanent|7j|7 j)\b/.test(s)) return []
  const positions: { jour: number; index: number }[] = []
  for (let i = 0; i < JOURS.length; i++) {
    const idx = s.indexOf(JOURS[i])
    if (idx >= 0) positions.push({ jour: i + 1, index: idx })
  }
  positions.sort((a, b) => a.index - b.index)
  if (positions.length === 2) {
    const entre = s.slice(positions[0].index + JOURS[positions[0].jour - 1].length, positions[1].index)
    // « lundi_vendredi », « lundi au vendredi » : plage ; « samedi et dimanche » : énumération (même résultat ici).
    if (!/\bet\b/.test(entre) && positions[0].jour < positions[1].jour) {
      const out: number[] = []
      for (let j = positions[0].jour; j <= positions[1].jour; j++) out.push(j)
      return out
    }
  }
  if (positions.length) {
    const jours = new Set(positions.map((p) => p.jour))
    // Les jours fériés sont assimilés au dimanche, faute de calendrier civil dans le simulateur.
    if (/\bferie/.test(s)) jours.add(7)
    return [...jours].sort((a, b) => a - b)
  }
  if (/\b(semaine|ouvrable|ouvrables|ouvre|ouvres)\b/.test(s)) return [1, 2, 3, 4, 5]
  if (/\bweek\s?end\b/.test(s)) return [6, 7]
  if (/\bferie/.test(s)) return [7]
  return null
}

/* ------------------------------------------------------------------ */
/*  Index des carrefours du réseau                                     */
/* ------------------------------------------------------------------ */

interface NoeudCandidat {
  id: NodeId
  libelles: LibelleVoie[]
  dejaFeux: boolean
  /** Étiquette lisible du carrefour, pour les messages. */
  etiquette: string
}

/**
 * Carrefours du réseau susceptibles de porter un dossier : les nœuds déjà à feux et les nœuds
 * de trois branches ou plus (un simple point de coupure de rue n'est pas un carrefour).
 */
function indexerCarrefours(network: Network, adj: Adjacency): NoeudCandidat[] {
  const out: NoeudCandidat[] = []
  for (const node of Object.values(network.nodes)) {
    if (node.boundary) continue
    const incidents = [...(adj.incoming.get(node.id) ?? []), ...(adj.outgoing.get(node.id) ?? [])]
    if (!incidents.length) continue
    const voisins = new Set<NodeId>()
    const noms = new Set<string>()
    for (const e of incidents) {
      voisins.add(e.from === node.id ? e.to : e.from)
      if (e.name) noms.add(e.name)
    }
    const dejaFeux = network.controls[node.id]?.type === 'signals'
    if (!dejaFeux && voisins.size < 3) continue
    const libelles: LibelleVoie[] = []
    for (const nom of noms) {
      const v = normaliserVoie(nom)
      if (v) libelles.push(v)
    }
    out.push({
      id: node.id,
      libelles,
      dejaFeux,
      etiquette: node.label || [...noms].slice(0, 2).join(' / ') || node.id,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  Conversion d'un dossier                                            */
/* ------------------------------------------------------------------ */

/** Un mouvement du carrefour, avec les libellés normalisés de son approche et de sa sortie. */
interface MouvementNomme {
  mouvement: Movement
  approche: LibelleVoie | null
  sortie: LibelleVoie | null
}

/**
 * Type d'un groupe d'après le libellé porté par le dossier, `null` si le libellé n'est pas reconnu.
 *
 * La reconnaissance est large parce que les dossiers écrivent aussi bien « pieton » que « traversée
 * piétonne » ou « TP » : un groupe piéton pris pour un groupe véhicule ouvrirait les mouvements qu'il doit
 * au contraire fermer, et le carrefour rendrait plus de débit qu'en réalité. Quand rien n'est reconnu,
 * l'appelant se rabat sur le préfixe de l'identifiant et le dit, plutôt que de supposer « véhicule ».
 */
export function typeDeGroupeDeclare(libelle: string): 'pieton' | 'vehicule' | null {
  const s = normaliserTexte(libelle)
  if (!s) return null
  if (/pieton/.test(s) || /travers/.test(s) || /(?:^|[^a-z])tp(?:[^a-z]|$)/.test(s)) return 'pieton'
  if (/vehicul/.test(s) || /voiture/.test(s) || /(?:^|[^a-z])(?:v|vl|vp)(?:[^a-z]|$)/.test(s)) return 'vehicule'
  return null
}

/**
 * Un dossier ne distingue pas le tourne-à-gauche à l'intérieur d'un groupe : il est donné « permis »,
 * comme dans le plan par défaut. Le déclarer protégé le ferait traverser le flux d'en face sans céder.
 */
function typeDeVert(m: Movement): GreenKind {
  return m.turn === 'left' || m.turn === 'uturn' ? 'permitted' : 'protected'
}

function slug(s: string): string {
  return sansAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dossier'
}

function identifiantLibre(base: string, pris: Set<string>): string {
  if (!pris.has(base)) return base
  for (let i = 2; ; i++) {
    const candidat = `${base}_${i}`
    if (!pris.has(candidat)) return candidat
  }
}

/** Le jaune le plus fréquent du dossier sert de jaune par défaut du contrôleur (repli hors matrice). */
function jauneRepresentatif(parGroupe: Record<string, number>): number {
  const valeurs = Object.values(parGroupe).filter((v) => v > 0)
  if (!valeurs.length) return DEFAULT_SIGNAL_TIMING.amber
  const comptes = new Map<number, number>()
  for (const v of valeurs) comptes.set(v, (comptes.get(v) ?? 0) + 1)
  let meilleure = valeurs[0]
  let meilleurCompte = 0
  for (const [v, n] of comptes) {
    if (n > meilleurCompte || (n === meilleurCompte && v > meilleure)) { meilleure = v; meilleurCompte = n }
  }
  return meilleure
}

/** Mode de marche déduit du dossier : adaptatif ou fixe, avec ou sans escamotage des phases. */
interface Fonctionnement {
  mode: SignalController['mode']
  /** Sauter une phase sans demande : réservé à un véritable escamotage. */
  skipEmpty: boolean
  /** Ce qui a fait basculer en adaptatif, cité tel quel dans l'avertissement. */
  motif: string
  /** Le dossier se déclare en fonctionnement cyclique. */
  cyclique: boolean
}

/**
 * Le fonctionnement escamotable ou la prolongation sur détecteur donnent un contrôleur adaptatif, mais
 * les deux ne se valent pas : une phase escamotable ne s'ouvre que sur appel, alors qu'une phase
 * seulement prolongeable s'ouvre à chaque cycle et n'est jamais sautée. Confondre les deux ferait
 * disparaître du cycle des phases que le dossier ouvre systématiquement.
 */
function lireFonctionnement(dossier: Rec, phases: Rec[]): Fonctionnement {
  const identification = estObjet(dossier.identification) ? dossier.identification : {}
  const mode = identification.mode_fonctionnement
  const escamotages: string[] = []
  const prolongations: string[] = []
  let cyclique = false
  if (typeof mode === 'string') {
    const s = normaliserTexte(mode)
    if (/escamot/.test(s)) escamotages.push(`le mode de fonctionnement « ${mode.trim()} » de l'identification`)
    if (/cyclique/.test(s)) cyclique = true
  } else if (estObjet(mode)) {
    for (const [cle, valeur] of Object.entries(mode)) {
      if (valeur !== true) continue
      const s = normaliserTexte(cle)
      if (/escamot/.test(s)) escamotages.push(`la case « ${cle} » cochée à l'identification`)
      if (/cyclique/.test(s)) cyclique = true
    }
  }
  for (const phase of phases) {
    const nom = chaine(phase.nom) || 'sans nom'
    if (/escamot/.test(normaliserTexte(`${chaine(phase.nom)} ${chaine(phase.type)}`))) {
      escamotages.push(`la phase « ${nom} » déclarée escamotable`)
    } else if (renseigne(phase.appel)) {
      escamotages.push(`l'appel sur détecteur de la phase « ${nom} »`)
    } else if (renseigne(phase.prolongation) || renseigne(phase.regulation)) {
      prolongations.push(`la prolongation de vert sur détecteur de la phase « ${nom} »`)
    }
  }
  const escamotable = escamotages.length > 0
  const adaptatif = escamotable || prolongations.length > 0
  return {
    mode: adaptatif ? 'actuated' : 'fixed',
    skipEmpty: escamotable,
    motif: (escamotable ? escamotages : prolongations)[0] ?? '',
    cyclique,
  }
}

/** Intervalle véhicule (s) annoncé par la prolongation d'une phase, à défaut le temps de suite par défaut. */
function intervalleVehicule(phase: Rec): number {
  const source = phase.prolongation ?? phase.regulation
  if (source === undefined || source === null) return DEFAULT_SIGNAL_TIMING.gap
  const texte = typeof source === 'string' ? source : JSON.stringify(source)
  const m = /intervalle[^0-9]{0,30}(\d+(?:[.,]\d+)?)/i.exec(sansAccents(texte))
  if (!m) return DEFAULT_SIGNAL_TIMING.gap
  const v = Number(m[1].replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SIGNAL_TIMING.gap
}

/* --------------------- Formes attendues et formes rencontrées --------------------- */

/** Clés qui trahissent un plan de feux donné seul, en objet, plutôt qu'en liste d'un seul élément. */
const CLES_DE_PLAN = ['nom', 'phases', 'cycle_s', 'periode', 'description', 'point_repos_s', 'regles']

/**
 * Plans de feux du dossier, quelle que soit la forme donnée à `plans_de_feux`.
 *
 * N'accepter que le tableau ferait disparaître sans un mot les réglages horaires d'un dossier qui donne
 * son plan unique en objet ou ses plans en dictionnaire : le contrôleur tournerait alors sur les seules
 * durées des phases, et le rapport d'import ne dirait rien.
 */
function lirePlansBruts(valeur: unknown, avertissements: string[]): Rec[] {
  if (valeur === undefined || valeur === null) return []
  if (Array.isArray(valeur)) {
    const plans = valeur.filter(estObjet)
    if (plans.length !== valeur.length) {
      avertissements.push(`Plans de feux : ${valeur.length - plans.length} entrée(s) ignorée(s), ce ne sont pas des objets.`)
    }
    return plans
  }
  if (estObjet(valeur)) {
    if (CLES_DE_PLAN.some((cle) => Object.prototype.hasOwnProperty.call(valeur, cle))) {
      avertissements.push(`Plans de feux : « plans_de_feux » est un objet et non une liste ; il a été lu comme un plan unique « ${chaine(valeur.nom) || 'sans nom'} ».`)
      return [valeur]
    }
    const entrees = Object.entries(valeur).filter(([, v]) => estObjet(v)) as [string, Rec][]
    if (entrees.length) {
      avertissements.push(`Plans de feux : « plans_de_feux » est un dictionnaire et non une liste ; ${entrees.length} plan(s) en ont été lus, chacun nommé par sa clé.`)
      return entrees.map(([cle, plan]) => (chaine(plan.nom) ? plan : { ...plan, nom: cle }))
    }
  }
  avertissements.push(`Plans de feux : « plans_de_feux » est ${typeDeValeur(valeur)} au lieu d'une liste et n'a pas pu être lu ; les verts minimaux et maximaux portés par les phases s'appliquent en permanence.`)
  return []
}

/** Clés d'une ligne de matrice donnée en tableau : le groupe qui perd le vert. */
const CLES_NOM_LIGNE = ['groupe', 'de', 'ligne', 'depuis', 'source', 'nom', 'id']
/** Clés d'entête d'une matrice, qui ne sont pas des lignes. */
const CLES_ENTETE_MATRICE = new Set(['convention', 'groupes', 'valeurs', 'valeur_jaune_s', 'valeur_securite_s',
  'vitesses_degagement_adoptees', 'note', 'notes', 'unite'])

/** Matrice lue : ses lignes (groupe qui perd le vert → colonnes) et l'objet qui porte les jaunes. */
interface MatriceLue {
  entete: Rec
  lignes: [string, Rec][]
}

/** Lignes d'une matrice donnée en tableau : `[{ groupe: 'V1', valeurs: { P2: 5 } }]` ou à plat. */
function lignesEnTableau(items: unknown[]): [string, Rec][] {
  const out: [string, Rec][] = []
  for (const item of items) {
    if (!estObjet(item)) continue
    const cleNom = CLES_NOM_LIGNE.find((cle) => chaine(item[cle]))
    if (!cleNom) continue
    const colonnes = estObjet(item.valeurs) ? item.valeurs : estObjet(item.colonnes) ? item.colonnes : null
    if (colonnes) { out.push([chaine(item[cleNom]), colonnes]); continue }
    // Ligne à plat : les autres clés numériques sont les colonnes. Objet sans prototype pour que
    // `reste['__proto__']` reste une clé propre, filtrée et signalée plus loin comme toutes les autres.
    const reste = Object.create(null) as Rec
    for (const [cle, v] of Object.entries(item)) {
      if (cle !== cleNom && nombre(v) !== null) reste[cle] = v
    }
    out.push([chaine(item[cleNom]), reste])
  }
  return out
}

/**
 * Matrice d'inter-verts du dossier, quelle que soit la forme rencontrée.
 *
 * Sans matrice, le contrôleur retombe sur un jaune et un rouge intégral constants : les temps de sécurité
 * du dossier sont alors remplacés par des valeurs par défaut, ce qui ne peut pas rester silencieux.
 */
function lireMatriceInterVerts(valeur: unknown, avertissements: string[]): MatriceLue | null {
  const abandon = (raison: string): null => {
    avertissements.push(`Matrice d'inter-verts : ${raison} ; à défaut, le jaune et le rouge intégral par défaut du contrôleur séparent les phases.`)
    return null
  }
  if (valeur === undefined || valeur === null) return null
  if (Array.isArray(valeur)) {
    const lignes = lignesEnTableau(valeur)
    if (!lignes.length) return abandon(`la clé est une liste sans ligne exploitable`)
    avertissements.push(`Matrice d'inter-verts : donnée en tableau et non en objet ; ${lignes.length} ligne(s) en ont été lues.`)
    return { entete: {}, lignes }
  }
  if (!estObjet(valeur)) return abandon(`la clé est ${typeDeValeur(valeur)} au lieu d'un objet`)
  const valeurs = valeur.valeurs
  if (estObjet(valeurs)) {
    return { entete: valeur, lignes: Object.entries(valeurs).filter(([, l]) => estObjet(l)) as [string, Rec][] }
  }
  if (Array.isArray(valeurs)) {
    const lignes = lignesEnTableau(valeurs)
    if (!lignes.length) return abandon(`« valeurs » est une liste sans ligne exploitable`)
    avertissements.push(`Matrice d'inter-verts : « valeurs » donné en tableau de lignes ; ${lignes.length} ligne(s) en ont été lues.`)
    return { entete: valeur, lignes }
  }
  if (valeurs !== undefined) return abandon(`« valeurs » est ${typeDeValeur(valeurs)} au lieu d'un objet`)
  // Pas de clé « valeurs » : la matrice est peut-être donnée à plat, { V1: { P2: 5 } }.
  const lignes = Object.entries(valeur).filter(([cle, l]) => estObjet(l) && !CLES_ENTETE_MATRICE.has(cle)) as [string, Rec][]
  if (!lignes.length) return abandon(`aucune case n'a pu être lue (clé « valeurs » absente)`)
  avertissements.push(`Matrice d'inter-verts : clé « valeurs » absente ; les ${lignes.length} ligne(s) ont été lues à la racine de la matrice.`)
  return { entete: valeur, lignes }
}

/* --------------------- Rapprochement des libellés de plans --------------------- */

/** Libellé de plan réduit à sa forme comparable : « PF 1 », « pf-1 » et « PF1 » désignent le même plan. */
function clePlan(s: string): string {
  return normaliserTexte(s).replace(/ /g, '')
}

/**
 * Un libellé peut-il être le préfixe de l'autre ? Le reste doit être vide ou ne pas commencer par un
 * chiffre : sans cette réserve, « PF12 » serait rattaché au plan « PF1 », c'est-à-dire au mauvais plan.
 */
function prefixeCompatible(court: string, long: string): boolean {
  if (!long.startsWith(court)) return false
  const reste = long.slice(court.length)
  return reste === '' || !/^[0-9]/.test(reste)
}

/** Plan du dossier désigné par un libellé, et si le rattachement vient d'un repli plutôt que d'une égalité. */
function resoudrePlan(
  libelle: string,
  plans: Map<string, { id: string; nom: string }>,
): { id: string; nom: string; repli: boolean } | null {
  const cle = clePlan(libelle)
  if (!cle) return null
  const exact = plans.get(cle)
  if (exact) return { ...exact, repli: false }
  for (const [cleConnue, plan] of plans) {
    if (prefixeCompatible(cle, cleConnue) || prefixeCompatible(cleConnue, cle)) return { ...plan, repli: true }
  }
  return null
}

/* ----------------------------- Calendrier ----------------------------- */

const CLES_PLAN = ['plan', 'plan_de_feux', 'plan_de_feu', 'plan_feux', 'nom_plan', 'plan_applique', 'pf']
const CLES_HORAIRE = ['plage', 'plage_horaire', 'plages_horaires', 'horaire', 'horaires', 'heures', 'heure',
  'periode', 'tranche', 'tranche_horaire', 'creneau']
const CLES_JOURS = ['jours', 'jour', 'type_jour', 'type_de_jour', 'types_jours', 'jour_type', 'jours_semaine']
const PAIRES_DEBUT_FIN: [string, string][] = [
  ['debut', 'fin'], ['heure_debut', 'heure_fin'], ['debut_h', 'fin_h'], ['de', 'a'], ['from', 'to'], ['start', 'end'],
]

/**
 * Clés qui structurent un calendrier sans désigner un type de jour : leur libellé ne doit pas être
 * signalé comme « type de jour non reconnu », faute de quoi chaque dossier bien formé produirait un
 * avertissement inutile.
 */
const CLES_STRUCTURE_CALENDRIER = new Set([
  ...CLES_PLAN, ...CLES_HORAIRE, ...CLES_JOURS,
  'calendrier', 'plages', 'periodes', 'programme', 'programmes', 'entrees', 'liste', 'lignes', 'regles',
  'note', 'notes', 'commentaire', 'saison', 'saisons',
])

interface EntreeCalendrier {
  plan: string
  fromMin: number
  toMin: number
  jours: number[]
  /** Libellé de jour non reconnu, à signaler à l'exploitant. */
  joursDouteux?: string
  /** Plage horaire absente : le plan a été supposé applicable toute la journée. */
  horaireSuppose?: boolean
  /** Texte d'horaire dont une heure n'a pas pu être appariée, à signaler tel quel. */
  horaireOrphelin?: string
}

function premiereValeur(obj: Rec, cles: string[]): unknown {
  for (const c of cles) {
    // Propriétés propres seulement : un `Object.prototype` pollué par ailleurs inventerait un plan de feux.
    if (!Object.prototype.hasOwnProperty.call(obj, c)) continue
    if (obj[c] !== undefined && obj[c] !== null) return obj[c]
  }
  return undefined
}

/** Toutes les entrées portées par un objet du calendrier : une par plage horaire trouvée. */
function extraireEntrees(obj: Rec, jours: number[] | null, joursBrut: string, horaireContexte: string): EntreeCalendrier[] {
  const plan = chaine(premiereValeur(obj, CLES_PLAN))
  if (!plan) return []
  let plages: [number, number][] = []
  let orphelin: string | undefined
  const horaire = premiereValeur(obj, CLES_HORAIRE)
  if (typeof horaire === 'string') {
    const lu = plagesDuTexte(horaire)
    plages = lu.plages
    if (lu.plages.length && lu.heureOrpheline) orphelin = horaire
  }
  if (!plages.length) {
    for (const [cd, cf] of PAIRES_DEBUT_FIN) {
      const d = heureEnMinutes(obj[cd])
      const f = heureEnMinutes(obj[cf])
      if (d !== null && f !== null) { plages = [[d, f]]; break }
    }
  }
  if (!plages.length && horaireContexte) {
    const lu = plagesDuTexte(horaireContexte)
    plages = lu.plages
    if (lu.plages.length && lu.heureOrpheline) orphelin = horaireContexte
  }
  const joursObjet = chaine(premiereValeur(obj, CLES_JOURS))
  const joursFinaux = joursObjet ? joursDuLibelle(joursObjet) : jours
  const libelleJours = joursObjet || joursBrut
  const commun = {
    plan,
    jours: joursFinaux ?? [],
    joursDouteux: joursFinaux === null && libelleJours ? libelleJours : undefined,
  }
  if (!plages.length) return [{ ...commun, fromMin: 0, toMin: 24 * 60, horaireSuppose: true }]
  return plages.map(([d, f]) => ({ ...commun, fromMin: d, toMin: f, horaireOrphelin: orphelin }))
}

/**
 * Parcourt un calendrier de forme inconnue : les dossiers rangent les plages tantôt par type de jour,
 * tantôt par plage horaire, tantôt à plat. On collecte les couples (plan, plage, jours) où qu'ils soient.
 */
function collecterCalendrier(
  valeur: unknown,
  jours: number[] | null,
  joursBrut: string,
  horaire: string,
  out: EntreeCalendrier[],
  profondeur = 0,
): void {
  if (profondeur > 5 || out.length > 200) return
  if (Array.isArray(valeur)) {
    for (const item of valeur) collecterCalendrier(item, jours, joursBrut, horaire, out, profondeur + 1)
    return
  }
  if (!estObjet(valeur)) return
  const entrees = extraireEntrees(valeur, jours, joursBrut, horaire)
  if (entrees.length) { out.push(...entrees); return }
  for (const [cle, v] of Object.entries(valeur)) {
    const lu = plagesDuTexte(cle)
    const joursCle = joursDuLibelle(cle)
    if (typeof v === 'string' && (lu.plages.length || joursCle !== null)) {
      // Formes compactes { "06:00-09:00": "PF1" } ou { "lundi_vendredi": "PF1" }.
      const commun = { plan: v, jours: (joursCle ?? jours) ?? [], joursDouteux: undefined }
      if (!lu.plages.length) out.push({ ...commun, fromMin: 0, toMin: 24 * 60, horaireSuppose: true })
      else {
        for (const [d, f] of lu.plages) {
          out.push({ ...commun, fromMin: d, toMin: f, horaireOrphelin: lu.heureOrpheline ? cle : undefined })
        }
      }
      continue
    }
    // Une clé non reconnue qui n'est pas une clé de structure est un type de jour illisible : la
    // propager permet à l'avertissement de partir, au lieu d'appliquer la plage « tous les jours ».
    const structurelle = CLES_STRUCTURE_CALENDRIER.has(normaliserTexte(cle).replace(/ /g, '_'))
      || lu.plages.length > 0 || /^\d+$/.test(cle.trim())
    collecterCalendrier(
      v,
      joursCle ?? jours,
      joursCle !== null || !structurelle ? cle : joursBrut,
      lu.plages.length ? cle : horaire,
      out,
      profondeur + 1,
    )
  }
}

/* ------------------------------------------------------------------ */
/*  Point d'entrée                                                     */
/* ------------------------------------------------------------------ */

interface Racine {
  carrefours: Rec[]
  avertissements: string[]
}

function lireRacine(raw: unknown): Racine {
  const avertissements: string[] = []
  let valeur = raw
  if (typeof valeur === 'string') {
    const texte = valeur.trim()
    if (!texte) return { carrefours: [], avertissements: ['Le fichier de dossiers est vide.'] }
    try {
      valeur = JSON.parse(texte)
    } catch {
      return { carrefours: [], avertissements: ["Le fichier n'est pas un JSON valide : aucun dossier n'a pu être lu."] }
    }
  }
  if (valeur === null || valeur === undefined) {
    return { carrefours: [], avertissements: ['Aucun contenu à importer.'] }
  }
  let liste: unknown
  if (Array.isArray(valeur)) liste = valeur
  else if (estObjet(valeur)) liste = valeur.carrefours ?? valeur.dossiers
  else {
    return {
      carrefours: [],
      avertissements: ["Le contenu n'est pas un objet JSON : ce n'est pas un fichier de dossiers de carrefour."],
    }
  }
  if (!Array.isArray(liste)) {
    return {
      carrefours: [],
      avertissements: ["Le fichier ne contient pas de liste « carrefours » : ce n'est pas un fichier de dossiers de carrefour."],
    }
  }
  const carrefours = liste.filter(estObjet)
  if (carrefours.length !== liste.length) {
    avertissements.push(`${liste.length - carrefours.length} entrée(s) de « carrefours » ignorée(s) : ce ne sont pas des objets.`)
  }
  if (!carrefours.length) avertissements.push('La liste « carrefours » est vide : aucun dossier à importer.')
  const annonce = estObjet(valeur) ? nombre(valeur.nombre_dossiers) : null
  if (annonce !== null && annonce !== carrefours.length) {
    avertissements.push(`Le fichier annonce ${annonce} dossier(s) mais en contient ${carrefours.length}.`)
  }
  return { carrefours, avertissements }
}

/** Rattachement d'un dossier à un carrefour du réseau, avant arbitrage des doublons. */
interface Candidature {
  dossier: Rec
  dossierId: string
  nom: string
  voies: LibelleVoie[]
  groupes: Rec[]
  meilleur: NoeudCandidat | null
  score: number
  voiesReconnues: string[]
  exAequo: NoeudCandidat[]
}

function evaluerCandidature(dossier: Rec, index: number, carrefours: NoeudCandidat[]): Candidature {
  const dossierId = chaine(dossier.id) || `dossier ${index + 1}`
  const nom = chaine(dossier.nom) || dossierId
  const groupes = tableau(dossier.groupes).filter(estObjet)
  // Les voies du dossier : entête (`voies`/`voies_plan`) et voies portées par les groupes.
  const voies: LibelleVoie[] = [
    ...libellesDeVoies(dossier.voies ?? dossier.voies_plan),
    ...groupes.flatMap((g) => libellesDeVoies(g.voie)),
  ]
  // Un même nom écrit de deux façons ne compte qu'une fois.
  const parNoyau = new Map<string, LibelleVoie>()
  for (const v of voies) if (!parNoyau.has(v.noyau)) parNoyau.set(v.noyau, v)
  const distinctes = [...parNoyau.values()]

  let meilleur: NoeudCandidat | null = null
  let score = 0
  let voiesReconnues: string[] = []
  let exAequo: NoeudCandidat[] = []
  for (const noeud of carrefours) {
    const reconnues: string[] = []
    for (const v of distinctes) {
      if (noeud.libelles.some((l) => memeVoie(v, l))) reconnues.push(v.brut)
    }
    if (!reconnues.length) continue
    if (reconnues.length > score) {
      score = reconnues.length
      meilleur = noeud
      voiesReconnues = reconnues
      exAequo = [noeud]
    } else if (reconnues.length === score) {
      exAequo.push(noeud)
    }
  }
  return { dossier, dossierId, nom, voies: distinctes, groupes, meilleur, score, voiesReconnues, exAequo }
}

export function importDossiersFeux(raw: unknown, opts: DossierImportOptions): DossierImportResult {
  const resultat: DossierImportResult = { controllers: {}, controls: {}, matches: [], avertissements: [] }
  try {
    const network = opts.network
    const racine = lireRacine(raw)
    resultat.avertissements.push(...racine.avertissements)
    if (!racine.carrefours.length) return resultat

    const adj = buildAdjacency(network)
    const carrefours = indexerCarrefours(network, adj)
    if (!carrefours.length) {
      resultat.avertissements.push('Le réseau ne comporte aucun carrefour : aucun dossier ne peut être rattaché.')
    }

    const candidatures = racine.carrefours.map((d, i) => evaluerCandidature(d, i, carrefours))

    // Deux dossiers ne peuvent pas décrire le même carrefour : le moins bien reconnu est laissé de côté.
    const revendications = new Map<NodeId, Candidature[]>()
    for (const c of candidatures) {
      if (!c.meilleur || c.exAequo.length > 1) continue
      const liste = revendications.get(c.meilleur.id)
      if (liste) liste.push(c)
      else revendications.set(c.meilleur.id, [c])
    }
    const evinces = new Map<Candidature, string>()
    for (const [, liste] of revendications) {
      if (liste.length < 2) continue
      const meilleurScore = Math.max(...liste.map((c) => c.score))
      const tetes = liste.filter((c) => c.score === meilleurScore)
      for (const c of liste) {
        if (tetes.length === 1 && c === tetes[0]) continue
        const autres = liste.filter((x) => x !== c).map((x) => x.dossierId).join(', ')
        evinces.set(c, `le carrefour reconnu est aussi revendiqué par ${autres} : rattachement laissé à l'exploitant`)
      }
    }

    const idsPris = new Set<string>(Object.keys(network.controllers))
    for (const candidature of candidatures) {
      try {
        traiterDossier(candidature, evinces.get(candidature), network, adj, idsPris, resultat)
      } catch (err) {
        resultat.matches.push({
          dossierId: candidature.dossierId,
          nom: candidature.nom,
          nodeId: null,
          controllerId: null,
          confiance: 'aucune',
          raison: `dossier illisible : ${message(err)}`,
          groupesRattaches: 0,
          groupesNonRattaches: candidature.groupes.map((g) => chaine(g.id)).filter(Boolean),
          avertissements: ['Le contenu de ce dossier n’a pas pu être converti ; il est ignoré.'],
        })
      }
    }
    return resultat
  } catch (err) {
    return {
      controllers: {},
      controls: {},
      matches: [],
      avertissements: [`Le fichier de dossiers n’a pas pu être lu (${message(err)}) : aucun carrefour importé.`],
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ */
/*  Conversion d'un dossier rattaché                                   */
/* ------------------------------------------------------------------ */

function traiterDossier(
  c: Candidature,
  eviction: string | undefined,
  network: Network,
  adj: Adjacency,
  idsPris: Set<string>,
  resultat: DossierImportResult,
): void {
  const avertissements: string[] = []
  const tousGroupes = c.groupes.map((g) => chaine(g.id)).filter(Boolean)

  const echec = (confiance: DossierMatch['confiance'], raison: string): void => {
    resultat.matches.push({
      dossierId: c.dossierId,
      nom: c.nom,
      nodeId: null,
      controllerId: null,
      confiance,
      raison,
      groupesRattaches: 0,
      groupesNonRattaches: tousGroupes,
      avertissements,
    })
  }

  if (!c.voies.length) {
    echec('aucune', 'le dossier ne nomme aucune voie : aucun rattachement possible')
    return
  }
  if (eviction) {
    echec('incertaine', eviction)
    return
  }
  if (!c.meilleur || c.score === 0) {
    echec('aucune', `aucune des voies du dossier (${c.voies.map((v) => v.brut).slice(0, 3).join(', ')}) ne correspond à un tronçon du réseau`)
    return
  }
  if (c.exAequo.length > 1) {
    const noms = c.exAequo.map((n) => n.etiquette || n.id).slice(0, 3).join(', ')
    echec('incertaine', `${c.exAequo.length} carrefours du réseau correspondent aussi bien (${noms}) : rattachement laissé à l'exploitant`)
    return
  }

  const noeud = c.meilleur
  const confiance: DossierMatch['confiance'] = c.score >= 2 ? 'sure' : 'probable'
  const raison = c.score >= 2
    ? `${c.score} voies du dossier retrouvées au carrefour (${c.voiesReconnues.join(', ')})`
    : `une seule voie du dossier retrouvée au carrefour (${c.voiesReconnues.join(', ')}) : à confirmer`

  // Un carrefour déjà à feux garde son contrôleur (et son regroupement de nœuds) : le dossier le remplace.
  const controleExistant = network.controls[noeud.id]
  const existant = controleExistant?.type === 'signals' && controleExistant.controllerId
    ? network.controllers[controleExistant.controllerId]
    : undefined
  const controllerId = existant ? existant.id : identifiantLibre(`c_dossier_${slug(c.dossierId)}`, idsPris)
  idsPris.add(controllerId)
  const nodeIds = existant && existant.nodeIds.includes(noeud.id) ? [...existant.nodeIds] : [noeud.id]

  const construit = construireControleur(c, controllerId, nodeIds, network, adj, avertissements)
  resultat.controllers[controllerId] = construit.controleur
  for (const id of nodeIds) resultat.controls[id] = { nodeId: id, type: 'signals', controllerId }

  resultat.matches.push({
    dossierId: c.dossierId,
    nom: c.nom,
    nodeId: noeud.id,
    controllerId,
    confiance,
    raison,
    groupesRattaches: construit.rattaches,
    groupesNonRattaches: construit.nonRattaches,
    avertissements,
  })
}

interface ControleurConstruit {
  controleur: SignalController
  rattaches: number
  nonRattaches: string[]
}

function construireControleur(
  c: Candidature,
  controllerId: ControllerId,
  nodeIds: NodeId[],
  network: Network,
  adj: Adjacency,
  avertissements: string[],
): ControleurConstruit {
  const stub: SignalController = {
    id: controllerId, name: c.nom, nodeIds, mode: 'fixed', offset: 0,
    amber: DEFAULT_SIGNAL_TIMING.amber, allRed: DEFAULT_SIGNAL_TIMING.allRed, phases: [],
    actuated: { skipEmpty: true },
  }
  const mouvements: MouvementNomme[] = controllerMovements(network, stub, adj).map((m) => ({
    mouvement: m,
    approche: network.edges[m.from]?.name ? normaliserVoie(network.edges[m.from].name as string) : null,
    sortie: network.edges[m.to]?.name ? normaliserVoie(network.edges[m.to].name as string) : null,
  }))
  const typeParCle = new Map<MovementKey, GreenKind>()
  for (const m of mouvements) typeParCle.set(m.mouvement.key, typeDeVert(m.mouvement))

  /* --- Groupes --- */
  const phasesBrutes = ordonnerPhases(c.dossier, avertissements)
  const rappelParGroupe = new Set<string>()
  for (const phase of phasesBrutes) {
    if (phase.pietons_en_rappel === true) for (const g of listeDeChaines(phase.pietons)) rappelParGroupe.add(g)
  }
  const groupes: SignalGroup[] = []
  const nonRattaches: string[] = []
  const voiesDeGroupes = new Map<string, string[]>()
  let pietonApproximatif = false
  const idsDeGroupes = new Set<string>()
  for (const brut of c.groupes) {
    const id = chaine(brut.id)
    if (!id) { avertissements.push('Un groupe sans identifiant a été ignoré.'); continue }
    if (idsDeGroupes.has(id)) {
      // Phases et matrices désignent les groupes par leur identifiant : sur un doublon, seul le dernier
      // est retenu et le premier n'ouvre plus rien. C'est une erreur de saisie du dossier, pas un choix.
      avertissements.push(`Deux groupes portent l'identifiant « ${id} » : seul le dernier est retenu par les phases et les inter-verts.`)
    }
    idsDeGroupes.add(id)
    const typeDeclare = chaine(brut.type)
    const typeReconnu = typeDeGroupeDeclare(typeDeclare)
    // Type illisible ou absent : le préfixe de l'identifiant tranche (P1, TP2 = piéton).
    const type: SignalGroup['type'] = typeReconnu ?? (/^(?:tp|p)/i.test(id) ? 'pieton' : 'vehicule')
    if (!typeReconnu && typeDeclare) {
      avertissements.push(`Groupe ${id} : type « ${typeDeclare} » non reconnu ; groupe traité comme ${type === 'pieton' ? 'piéton' : 'véhicule'} d'après le préfixe de son identifiant.`)
    }
    const voies = libellesDeVoies(brut.voie)
    const movements: MovementKey[] = []
    for (const m of mouvements) {
      const concerne = type === 'vehicule'
        ? voies.some((v) => m.approche && memeVoie(v, m.approche))
        // Faute de géométrie fiable dans le dossier, une traversée est réputée franchie par tout mouvement
        // qui entre ou sort par la voie traversée.
        : voies.some((v) => (m.approche && memeVoie(v, m.approche)) || (m.sortie && memeVoie(v, m.sortie)))
      if (concerne) movements.push(m.mouvement.key)
    }
    if (type === 'pieton' && movements.length) pietonApproximatif = true
    const groupe: SignalGroup = { id, type, movements }
    if (voies.length) groupe.label = voies.map((v) => v.brut).join(' / ')
    if (rappelParGroupe.has(id) || brut.rappel === true || brut.pietons_en_rappel === true) groupe.recall = true
    groupes.push(groupe)
    if (!movements.length) nonRattaches.push(id)
    if (chaine(brut.source_voie)) {
      avertissements.push(`Groupe ${id} : la voie « ${voies.map((v) => v.brut).join(' / ') || '?'} » vient de la lecture du plan (source_voie) et reste à confirmer.`)
    }
    for (const v of voies) {
      const liste = voiesDeGroupes.get(`${type}:${v.noyau}`)
      if (liste) liste.push(id)
      else voiesDeGroupes.set(`${type}:${v.noyau}`, [id])
    }
  }
  for (const [cle, ids] of voiesDeGroupes) {
    if (ids.length > 1 && cle.startsWith('vehicule:')) {
      avertissements.push(`Groupes ${ids.join(', ')} : même voie « ${cle.slice('vehicule:'.length)} », leurs mouvements sont identiques faute de distinction dans le dossier.`)
    }
  }
  if (pietonApproximatif) {
    avertissements.push('Traversées piétonnes : les mouvements interdits ont été déduits du nom de la voie traversée (entrée ou sortie), le dossier ne donnant pas la géométrie des traversées.')
  }
  if (nonRattaches.length) {
    avertissements.push(`${nonRattaches.length} groupe(s) sans mouvement au carrefour : ${nonRattaches.join(', ')}.`)
  }
  const groupesConnus = new Set(groupes.map((g) => g.id))
  const parGroupe = new Map(groupes.map((g) => [g.id, g]))

  /* --- Phases --- */
  const phases: SignalPhase[] = []
  const idParNom = new Map<string, string>()
  const idParLettre = new Map<string, string>()
  /** Plan propre à une phase : libellé du dossier et forme comparable, pour parler à l'exploitant. */
  const planDeLaPhase = new Map<string, { brut: string; cle: string }>()
  phasesBrutes.forEach((brut, i) => {
    const nom = chaine(brut.nom) || `Phase ${i + 1}`
    const idPhase = `p${i + 1}`
    const { mini, maxi } = bornesDeVert(brut.mini_s, brut.maxi_s, `Phase « ${nom} »`, avertissements)
    const ids = [...listeDeChaines(brut.vehicules), ...listeDeChaines(brut.pietons)]
    const inconnus = ids.filter((g) => !groupesConnus.has(g))
    if (inconnus.length) {
      avertissements.push(`Phase « ${nom} » : groupe(s) inconnu(s) ${inconnus.join(', ')} ignoré(s).`)
    }
    const retenus = ids.filter((g) => groupesConnus.has(g))
    const movements: Record<MovementKey, GreenKind> = {}
    const vehiculesDeLaPhase: string[] = []
    for (const g of retenus) {
      const groupe = parGroupe.get(g)
      if (groupe?.type !== 'vehicule') continue
      vehiculesDeLaPhase.push(g)
      for (const k of groupe.movements) movements[k] = typeParCle.get(k) ?? 'protected'
    }
    const ouvertsAvantPietons = Object.keys(movements).length
    // §14.5 : un vert piéton interdit les mouvements qui franchissent sa traversée, même si un groupe
    // véhicule les autorise ; sans cela le carrefour rendrait plus de débit qu'en réalité.
    for (const g of retenus) {
      const groupe = parGroupe.get(g)
      if (groupe?.type !== 'pieton') continue
      for (const k of groupe.movements) delete movements[k]
    }
    if (retenus.length && !Object.keys(movements).length) {
      // Trois causes très différentes se cachaient derrière un message unique : parler de traversées
      // piétonnes quand le dossier n'en a aucune envoie le technicien sur une fausse piste.
      if (ouvertsAvantPietons > 0) {
        avertissements.push(`Phase « ${nom} » : aucun mouvement au vert après prise en compte des traversées piétonnes.`)
      } else if (vehiculesDeLaPhase.length) {
        avertissements.push(`Phase « ${nom} » : aucun mouvement au vert, le(s) groupe(s) véhicule ${vehiculesDeLaPhase.join(', ')} n'étant rattaché(s) à aucune approche du carrefour.`)
      } else {
        avertissements.push(`Phase « ${nom} » : aucun mouvement au vert, la phase ne comporte aucun groupe véhicule.`)
      }
    }
    const phase: SignalPhase = {
      id: idPhase,
      name: nom,
      green: mini ?? DEFAULT_SIGNAL_TIMING.minGreen,
      movements,
      minGreen: mini ?? DEFAULT_SIGNAL_TIMING.minGreen,
      maxGreen: maxi ?? mini ?? DEFAULT_SIGNAL_TIMING.maxGreen,
      gap: intervalleVehicule(brut),
    }
    if (retenus.length) phase.groups = retenus
    phases.push(phase)
    const cle = normaliserTexte(nom)
    if (cle && !idParNom.has(cle)) idParNom.set(cle, idPhase)
    else if (cle) avertissements.push(`Deux phases portent le même nom « ${nom} » : la seconde ne pourra pas être référencée par un plan.`)
    const lettre = /\bphase\s+([a-z0-9]+)\b/.exec(cle)?.[1] ?? (/^[a-z0-9]$/.test(cle) ? cle : '')
    if (lettre) {
      if (idParLettre.has(lettre)) idParLettre.set(lettre, '')
      else idParLettre.set(lettre, idPhase)
    }
    const planPropre = chaine(brut.plan)
    if (planPropre) planDeLaPhase.set(idPhase, { brut: planPropre, cle: clePlan(planPropre) })
  })
  if (!phases.length) avertissements.push('Le dossier ne décrit aucune phase : le contrôleur reste sans plan.')

  const resoudrePhase = (libelle: string): string | null => {
    const cle = normaliserTexte(libelle)
    if (!cle) return null
    const direct = idParNom.get(cle)
    if (direct) return direct
    const lettre = /\bphase\s+([a-z0-9]+)\b/.exec(cle)?.[1] ?? (/^[a-z0-9]$/.test(cle) ? cle : '')
    if (lettre) {
      const parLettre = idParLettre.get(lettre)
      if (parLettre) return parLettre
    }
    // Même réserve que pour les plans : « Phase 12 » ne doit pas se rattacher à « Phase 1 ».
    for (const [nom, id] of idParNom) if (prefixeCompatible(cle, nom) || prefixeCompatible(nom, cle)) return id
    return null
  }

  /* --- Plans de feux --- */
  const plans: SignalPlan[] = []
  const idParPlan = new Map<string, { id: string; nom: string }>()
  const idsPlans = new Set<string>()
  for (const brut of lirePlansBruts(c.dossier.plans_de_feux, avertissements)) {
    const nom = chaine(brut.nom) || `Plan ${plans.length + 1}`
    const id = identifiantLibre(slug(nom), idsPlans)
    idsPlans.add(id)
    const timings: Record<string, PlanPhaseTiming> = {}
    for (const phaseBrute of tableau(brut.phases).filter(estObjet)) {
      const libelle = chaine(phaseBrute.nom) || chaine(phaseBrute.phase) || chaine(phaseBrute.id)
      const idPhase = resoudrePhase(libelle)
      if (!idPhase) {
        avertissements.push(`Plan « ${nom} » : phase « ${libelle || '?'} » absente de la liste des phases, réglage ignoré.`)
        continue
      }
      const { mini, maxi } = bornesDeVert(
        phaseBrute.mini_s, phaseBrute.maxi_s, `Plan « ${nom} », phase « ${libelle} »`, avertissements,
      )
      const phase = phases.find((p) => p.id === idPhase)
      timings[idPhase] = {
        green: mini ?? phase?.green ?? DEFAULT_SIGNAL_TIMING.minGreen,
        minGreen: mini ?? phase?.minGreen ?? DEFAULT_SIGNAL_TIMING.minGreen,
        maxGreen: maxi ?? mini ?? phase?.maxGreen ?? DEFAULT_SIGNAL_TIMING.maxGreen,
      }
    }
    // Une phase déclarée propre à un autre plan reste fermée dans celui-ci : sans cela elle tournerait
    // dans tous les plans et allongerait le cycle des heures creuses d'une phase que le dossier n'y ouvre pas.
    for (const [idPhase, planPropre] of planDeLaPhase) {
      if (planPropre.cle && planPropre.cle !== clePlan(nom) && !timings[idPhase]) {
        const nomPhase = phases.find((ph) => ph.id === idPhase)?.name ?? idPhase
        timings[idPhase] = { green: 0, skipped: true }
        // Le libellé du dossier, jamais la forme normalisée interne : l'exploitant cherche « PF3 » dans
        // son dossier, pas « pf3 ».
        avertissements.push(`Plan « ${nom} » : la phase « ${nomPhase} » n'appartient qu'au plan « ${planPropre.brut} » du dossier, elle est donc fermée dans ce plan.`)
      }
    }
    const plan: SignalPlan = {
      id,
      name: nom,
      cycle: duree(brut.cycle_s, `Plan « ${nom} » : cycle`, avertissements) ?? 0,
      offset: 0,
      phases: timings,
    }
    const periode = chaine(brut.periode) || chaine(brut.description)
    if (periode) plan.period = periode
    plans.push(plan)
    idParPlan.set(clePlan(nom), { id, nom })
  }

  /* --- Calendrier --- */
  const schedule: PlanSchedule[] = []
  const calendrier = c.dossier.calendrier
  if (calendrier !== undefined && calendrier !== null) {
    const entrees: EntreeCalendrier[] = []
    collecterCalendrier(calendrier, null, '', '', entrees)
    if (!entrees.length && plans.length > 1) {
      avertissements.push('Le calendrier n’a pas pu être lu : le premier plan de feux s’appliquera en permanence.')
    }
    const joursDouteux = new Set<string>()
    const replis = new Set<string>()
    const orphelins = new Set<string>()
    for (const e of entrees) {
      const trouve = resoudrePlan(e.plan, idParPlan)
      if (!trouve) {
        avertissements.push(`Calendrier : plan « ${e.plan} » inconnu, plage horaire ignorée.`)
        continue
      }
      // Un rattachement par repli n'est pas une égalité : il se dit, sinon « PF12 » deviendrait « PF1 »
      // en silence.
      if (trouve.repli) replis.add(`« ${e.plan} » → « ${trouve.nom} »`)
      if (e.joursDouteux) joursDouteux.add(e.joursDouteux)
      if (e.horaireOrphelin) orphelins.add(e.horaireOrphelin)
      if (e.horaireSuppose) {
        avertissements.push(`Calendrier : plage horaire absente pour le plan « ${e.plan} », supposé applicable toute la journée.`)
      }
      schedule.push({ planId: trouve.id, fromMin: e.fromMin, toMin: e.toMin, days: e.jours })
    }
    for (const repli of replis) {
      avertissements.push(`Calendrier : ${repli} rattaché par rapprochement de libellés et non par égalité, à vérifier.`)
    }
    for (const texte of orphelins) {
      avertissements.push(`Calendrier : la plage « ${texte} » comporte un nombre impair d'heures ; la dernière n'a pas pu être appariée.`)
    }
    for (const libelle of joursDouteux) {
      avertissements.push(`Calendrier : type de jour « ${libelle} » non reconnu, la plage est appliquée tous les jours.`)
    }
  }

  /* --- Matrices --- */
  const interGreen: InterGreenMatrix = {}
  const amberByGroup: Record<string, number> = {}
  const matrice = lireMatriceInterVerts(c.dossier.matrice_inter_verts, avertissements)
  if (matrice) {
    // Les lignes s'assemblent dans une `Map` : `interGreen[de]` avec une clé venant du fichier
    // remonterait jusqu'à `Object.prototype`, et l'écriture qui suit polluerait toute la session.
    const lignes = new Map<string, Record<string, number>>()
    const reservees = new Set<string>()
    for (const [de, ligne] of matrice.lignes) {
      if (cleReservee(de)) { reservees.add(de); continue }
      for (const [vers, v] of Object.entries(ligne)) {
        if (cleReservee(vers)) { reservees.add(vers); continue }
        const n = nombre(v)
        if (n === null) continue
        if (n < 0) {
          avertissements.push(`Matrice d'inter-verts : temps négatif (${n} s) de ${de} vers ${vers}, case ignorée.`)
          continue
        }
        let colonnes = lignes.get(de)
        if (!colonnes) { colonnes = {}; lignes.set(de, colonnes) }
        colonnes[vers] = n
      }
    }
    for (const [de, colonnes] of lignes) interGreen[de] = colonnes
    // §5 du format : la matrice est annoncée symétrique. On le vérifie sans corriger : une asymétrie est
    // une anomalie de saisie qu'il revient à l'exploitant de trancher.
    const asymetries: string[] = []
    for (const [de, ligne] of Object.entries(interGreen)) {
      for (const vers of Object.keys(ligne)) {
        if (caseDe(interGreen, vers, de) === undefined) asymetries.push(`${de} → ${vers}`)
      }
    }
    if (asymetries.length) {
      avertissements.push(`Matrice d'inter-verts asymétrique : ${asymetries.slice(0, 5).join(', ')}${asymetries.length > 5 ? '…' : ''} sans valeur en sens inverse (valeurs conservées telles quelles).`)
    }
    const inconnus = new Set<string>()
    for (const [de, ligne] of Object.entries(interGreen)) {
      if (!groupesConnus.has(de)) inconnus.add(de)
      for (const vers of Object.keys(ligne)) if (!groupesConnus.has(vers)) inconnus.add(vers)
    }
    if (inconnus.size) {
      avertissements.push(`Matrice d'inter-verts : groupe(s) absent(s) de la liste des groupes (${[...inconnus].join(', ')}).`)
    }
    const jaunes = estObjet(matrice.entete.valeur_jaune_s) ? matrice.entete.valeur_jaune_s : {}
    for (const [g, v] of Object.entries(jaunes)) {
      if (cleReservee(g)) { reservees.add(g); continue }
      const n = nombre(v)
      if (n !== null && n > 0) amberByGroup[g] = n
    }
    if (reservees.size) {
      avertissements.push(`Matrice d'inter-verts : clé(s) ${[...reservees].map((k) => `« ${k} »`).join(', ')} écartée(s), ces noms sont réservés par le langage et ne peuvent pas désigner un groupe.`)
    }
  }
  // §5 du format : aucune phase ne doit réunir deux groupes déclarés incompatibles.
  for (const phase of phases) {
    const ids = phase.groups ?? []
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (caseDe(interGreen, ids[i], ids[j]) !== undefined || caseDe(interGreen, ids[j], ids[i]) !== undefined) {
          avertissements.push(`Phase « ${phase.name} » : les groupes ${ids[i]} et ${ids[j]} sont déclarés incompatibles par la matrice d'inter-verts.`)
        }
      }
    }
  }

  /* --- Contrôleur --- */
  const fonctionnement = lireFonctionnement(c.dossier, phasesBrutes)
  if (fonctionnement.mode === 'actuated' && fonctionnement.cyclique) {
    // Le dossier se contredit : il faut que l'exploitant sache laquelle des deux lectures a été retenue.
    avertissements.push(`Le dossier annonce un fonctionnement cyclique mais décrit ${fonctionnement.motif} : le contrôleur passe en adaptatif ${fonctionnement.skipEmpty ? 'avec escamotage des phases sans demande' : 'sans escamotage, une prolongation de vert n’escamotant pas la phase'}.`)
  }
  const controleur: SignalController = {
    id: controllerId,
    name: c.nom,
    nodeIds,
    mode: fonctionnement.mode,
    offset: 0,
    amber: jauneRepresentatif(amberByGroup),
    allRed: DEFAULT_SIGNAL_TIMING.allRed,
    phases,
    actuated: { skipEmpty: fonctionnement.skipEmpty },
    source: `dossier ${c.dossierId}`,
  }
  if (groupes.length) controleur.groups = groupes
  if (Object.keys(interGreen).length) controleur.interGreen = interGreen
  if (Object.keys(amberByGroup).length) controleur.amberByGroup = amberByGroup
  if (plans.length) controleur.plans = plans
  if (schedule.length) controleur.schedule = schedule

  repartirCycle(controleur, avertissements)

  const notes = listeDeChaines(c.dossier.notes_extraction)
  if (notes.length) {
    avertissements.push(`Le dossier signale ${notes.length} réserve(s) de lecture (notes d'extraction) : à consulter avant exploitation.`)
  }

  return { controleur, rattaches: groupes.length - nonRattaches.length, nonRattaches }
}

/**
 * Répartit le temps de cycle annoncé par un plan entre ses phases.
 *
 * Un dossier donne, par plan, le cycle et les mini/maxi de chaque phase, mais jamais le vert réellement
 * appliqué : dans un plan à cycle fixe, ce vert est le minimum augmenté de la part du temps qui reste une
 * fois les inter-verts retirés. S'en tenir aux minima ferait tourner le carrefour sur un cycle plus court
 * que la réalité, et lui prêterait donc moins de capacité qu'il n'en a. La part est distribuée au prorata
 * de la marge (maxi − mini) de chaque phase, ce qui donne le gros du temps disponible à la phase de repos.
 */
function repartirCycle(controleur: SignalController, avertissements: string[]): void {
  const toutes = controleur.phases
  if (!toutes.length) return
  for (const plan of controleur.plans ?? []) {
    if (plan.cycle <= 0) continue
    // Une phase fermée par ce plan ne participe ni au cycle ni aux inter-verts : la répartition ne porte
    // que sur les phases réellement ouvertes, et son drapeau de fermeture doit survivre à la répartition.
    const phases = planPhases(controleur, plan)
    if (!phases.length) continue
    let interVerts = 0
    for (let i = 0; i < phases.length; i++) {
      interVerts += phaseTransition(controleur, phases[i], phases[(i + 1) % phases.length]).total
    }
    const timings = phases.map((p) => planPhaseTiming(p, plan))
    const minis = timings.map((t) => t.minGreen)
    const sommeMinis = minis.reduce((a, b) => a + b, 0)
    let disponible = plan.cycle - interVerts - sommeMinis
    if (disponible < -0.5) {
      avertissements.push(`Plan « ${plan.name} » : cycle annoncé de ${plan.cycle} s plus court que la somme des verts minimaux et des inter-verts (${Math.round(interVerts + sommeMinis)} s) ; les minima sont conservés.`)
      disponible = 0
    }
    const verts = [...minis]
    let marges = timings.map((t, i) => Math.max(0, t.maxGreen - minis[i]))
    let sommeMarges = marges.reduce((a, b) => a + b, 0)
    let reste = Math.max(0, disponible)
    // Deux passes : la seconde redistribue ce que les verts maximaux ont refusé à la première.
    for (let passe = 0; passe < 2 && reste > 0.5 && sommeMarges > 0; passe++) {
      const aRepartir = reste
      for (let i = 0; i < verts.length; i++) {
        if (marges[i] <= 0) continue
        const place = Math.max(0, timings[i].maxGreen - verts[i])
        const part = Math.min(place, (aRepartir * marges[i]) / sommeMarges)
        verts[i] += part
        reste -= part
      }
      marges = verts.map((v, i) => Math.max(0, timings[i].maxGreen - v))
      sommeMarges = marges.reduce((a, b) => a + b, 0)
    }
    if (reste > 0.5) {
      avertissements.push(`Plan « ${plan.name} » : ${Math.round(reste)} s du cycle annoncé ne peuvent être attribuées, les verts maximaux étant atteints.`)
    }
    const arrondis = verts.map((v) => Math.round(v))
    // L'écart d'arrondi (au plus une seconde par phase) va à la phase la plus longue, le point de repos.
    const ecart = Math.round(plan.cycle - interVerts) - arrondis.reduce((a, b) => a + b, 0)
    if (ecart !== 0 && Math.abs(ecart) <= phases.length) {
      let plusLongue = 0
      for (let i = 1; i < arrondis.length; i++) if (arrondis[i] > arrondis[plusLongue]) plusLongue = i
      arrondis[plusLongue] = Math.max(0, arrondis[plusLongue] + ecart)
    }
    for (let i = 0; i < phases.length; i++) {
      plan.phases[phases[i].id] = { green: arrondis[i], minGreen: minis[i], maxGreen: timings[i].maxGreen }
    }
  }
}

/** Phases du dossier, remises dans l'ordre du cycle quand `ordre_phases` le donne. */
function ordonnerPhases(dossier: Rec, avertissements: string[]): Rec[] {
  const phases = tableau(dossier.phases).filter(estObjet)
  const ordre = listeDeChaines(dossier.ordre_phases)
  if (!ordre.length || !phases.length) return phases
  const restantes = [...phases]
  const triees: Rec[] = []
  for (const libelle of ordre) {
    const cle = normaliserTexte(libelle)
    const i = restantes.findIndex((p) => {
      const nom = normaliserTexte(chaine(p.nom))
      return nom === cle || nom.startsWith(cle) || cle.startsWith(nom)
    })
    if (i >= 0) triees.push(...restantes.splice(i, 1))
    else avertissements.push(`Ordre des phases : « ${libelle} » ne correspond à aucune phase du dossier.`)
  }
  return [...triees, ...restantes]
}
