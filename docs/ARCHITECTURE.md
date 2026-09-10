# Architecture — simulateur de circulation et de signalisation

Application web 100 % navigateur pour étudier l'effet de changements de signalisation (feux, stops, sens uniques,
zones 30, giratoires…) sur la circulation d'une commune française. Interface en français, desktop.

## 1. Décisions de cadrage (validées par l'utilisateur le 2026-09-04)

| Sujet | Décision |
|---|---|
| Moteur | Mésoscopique à files d'attente, véhicules individuels animés, pas de 1 s |
| Emprise | Commune entière (contour administratif geo.api.gouv.fr), avertissement au-delà de 5 000 tronçons |
| Demande | Débits par entrée **et** matrice OD **et** trafic interne **et** import CSV |
| Feux | Plans fixes par mouvement (phases, orange, rouge intégral, décalage, tourne-à-gauche protégé/permis, clignotant) **et** mode adaptatif sur détecteurs |
| Édition | Déplacer/fusionner/supprimer des nœuds, attributs de tronçon (sens, vitesse, voies, fermeture), type de carrefour, interdictions de tourner, ajout de tronçon ; annuler/rétablir |
| Résultats | Référence figée vs variante à variables aléatoires communes, tableau des écarts, carte des deltas |
| Sauvegarde | IndexedDB (autosauvegarde + bibliothèque de projets) + import/export JSON autonome versionné |
| Démo | Veauche (42323) embarquée — sans feux dans OSM : le scénario type est de convertir un stop en feux ; Saint-Just-Saint-Rambert (42279) en second extrait |

## 2. Pile technique et arborescence

React 19 + TypeScript + Vite 8, Zustand (+ immer avec patches pour l'historique), Leaflet (fond de carte OSM) +
Canvas 2D superposé pour réseau/véhicules, moteur dans un Web Worker, Vitest, Playwright.

```
scripts/extract-city.mjs          pré-extraction d'une commune (public/demo/<slug>.osm.json)
public/demo/*.osm.json            extraits de démonstration (format OsmExtract)
src/model/types.ts                modèle JSON du projet (contrat — ne pas modifier sans mettre à jour ce doc)
src/model/defaults.ts             défauts français, demande par défaut, régulation implicite
src/model/geometry.ts             angles, tourne-à-gauche/droite, conflits de mouvements, nodeMovements()
src/model/signals.ts              [A] plan de feux par défaut, cycle, validation d'un contrôleur
src/model/schema.ts               [C] validation + migration du JSON de projet
src/geo/types.ts                  types OSM / communes
src/geo/projection.ts             [A] WGS84 ↔ mètres locaux
src/geo/communes.ts               [A] client geo.api.gouv.fr (autocomplete nom / code postal, contour)
src/geo/overpass.ts               [A] client Overpass (miroirs, timeout, cache IndexedDB)
src/geo/osm2graph.ts              [A] extrait OSM → Network (découpage au contour, simplification, feux, restrictions)
src/engine/protocol.ts            protocole worker (contrat)
src/engine/rng.ts                 [B] PRNG déterministe (sfc32 + splitmix32), flux nommés
src/engine/demand.ts              [B] génération des arrivées (variables aléatoires communes)
src/engine/routing.ts             [B] Dijkstra sur tronçons avec interdictions de tourner, tables par destination
src/engine/itineraires.ts         [B] les k itinéraires les plus courts entre deux nœuds (Yen), pour l'outil de carte
src/engine/signals.ts             [B] contrôleurs de feux (fixe, adaptatif, clignotant), états par mouvement
src/engine/priority.ts            [B] règles de priorité hors feux, créneaux critiques, capacité de cession
src/engine/simulation.ts          [B] classe Simulation (files, décharge, remontées, stats)
src/engine/stats.ts               [B] agrégation des indicateurs et séries
src/engine/worker.ts              [B] point d'entrée du Worker (cadence, frames)
src/engine/client.ts              [B] SimClient : wrapper typé du Worker côté interface
src/state/storeTypes.ts           contrat du store (contrat)
src/state/store.ts                [C] implémentation Zustand + historique
src/state/edits.ts                [C] opérations pures sur Network/Demand (déplacer, fusionner, direction…)
src/state/persistence.ts          [C] IndexedDB (autosauvegarde, bibliothèque, cache OSM), export/import JSON
src/state/csv.ts                  [C] import/export CSV de la demande
src/ui/map/MapView.tsx            [D] carte Leaflet + calque canvas, interactions
src/ui/map/renderer.ts            [D] dessin du réseau, des véhicules, des feux, des couleurs par indicateur
src/ui/map/colors.ts              [D] échelles de couleur par mode
src/ui/panels/*.tsx               [E] panneaux latéraux (Ville, Réseau, Feux, Trafic, Résultats, Comparer)
src/ui/components/*               [E] composants partagés (champs numériques, tableaux triables, recherche, graphique SVG)
src/ui/App.tsx, src/main.tsx      [E] coquille : barre supérieure, onglets, carte, légende
src/styles.css                    [E]
```

`[A]…[E]` = lot d'implémentation propriétaire du fichier. Un lot ne modifie pas les fichiers d'un autre lot ; il
signale les besoins d'évolution des contrats dans son compte rendu.

## 3. Modèle de données (src/model/types.ts)

- Tronçons **orientés**. Rue à double sens = deux `NetEdge` liés par `reverseOf` (symétrique).
- `NetNode.boundary` = nœud d'entrée/sortie : premier nœud OSM hors du contour adjacent à un nœud intérieur.
  Un nœud frontière est entrée s'il a un tronçon sortant, sortie s'il a un tronçon entrant (souvent les deux).
- `Network.controls` ne contient que les régulations explicites ; `effectiveControl()` (defaults.ts) fournit
  l'implicite : `roundabout` si un tronçon entrant est un anneau ou si `miniRoundabout`, sinon `priority_class`.
- Un `SignalController` couvre un ou plusieurs nœuds (`nodeIds`). Ses phases listent les mouvements au vert
  (`MovementKey` = `from>to`) avec le type `protected` (sans cession) ou `permitted` (cède aux mouvements verts en conflit).
  Les tronçons **internes** au regroupement (les deux extrémités dans `nodeIds`) sont toujours franchissables :
  seuls les mouvements dont l'approche vient de l'extérieur du regroupement sont pilotés par les phases.
  Le regroupement se construit depuis le panneau Feux (`setControllerNodes`) : c'est le cas d'une armoire qui
  commande un carrefour décalé, qu'OpenStreetMap découpe en deux nœuds voisins, ou deux carrefours proches.
  Un nœud n'appartient qu'à **un** contrôleur : le regrouper le retire du sien, qui disparaît s'il n'en garde
  aucun — deux contrôleurs sur les mêmes mouvements donneraient au carrefour deux plans de feux simultanés.
  Un dossier de carrefour importé s'applique à l'ensemble des nœuds du contrôleur (§14).
- Cycle d'un contrôleur = Σ(vert + orange + rouge intégral) des phases (orange/rouge intégral de la phase ou du contrôleur).
- `Demand.entries`/`exits` sont indexés par identifiant de nœud frontière. `reconcileDemand()` les resynchronise après
  toute modification du réseau (entrées créées avec `estimated: true`, entrées orphelines supprimées).
- `Project.reference` est un instantané complet (réseau, demande, réglages, résultats) : la comparaison ne dépend pas de l'état courant.
- Le JSON exporté est le `Project` tel quel (`format`, `version`). `schema.ts` valide la structure et migre les versions antérieures.

## 4. Import OSM → graphe (lot A, `osm2graph.ts`)

Entrée : `OsmExtract` (commune + contour + éléments Overpass). Sortie : `{ network, warnings, stats }`.

1. **Projection** (`projection.ts`) : origine = `commune.centre` (recopiée dans `meta.center`) ; `x = (lon − lon0)·cos(lat0)·R`,
   `y = (lat − lat0)·R`, R = 6 371 008,8 m, calcul en radians, coordonnées arrondies au centimètre.
2. **Filtrage des ways** : `highway` ∈ `HIGHWAY_CLASSES` ; ignorer `access=no|private` sauf si `motor_vehicle=yes` ;
   ignorer `area=yes`. Nœuds absents (extrait tronqué) → way ignoré avec avertissement.
3. **Découpage au contour** : point-dans-polygone (Polygon ou MultiPolygon, trous respectés) sur chaque nœud.
   Parcourir les nœuds de chaque way ; conserver les suites de nœuds intérieurs en y ajoutant le premier nœud extérieur
   de chaque côté, marqué `boundary: true` (coordonnées conservées, même hors polygone). Un way peut produire plusieurs suites.
4. **Nœuds topologiques** : nœud frontière, extrémité de suite, nœud partagé par ≥ 2 suites (compté sur toutes les suites
   retenues), nœud `highway=traffic_signals` ou `mini_roundabout` situé à une extrémité ou partagé. Les nœuds
   `traffic_signals`, `stop`, `give_way` **non** topologiques ne créent pas de nœud : ils sont rattachés (étape 8).
5. **Tronçons** : chaque suite est coupée aux nœuds topologiques en segments. Sens :
   `oneway=yes|true|1` → avant seul ; `oneway=-1|reverse` → arrière seul ; `junction=roundabout|circular`, `highway=motorway`
   et `motorway_link` impliquent sens unique avant ; sinon deux tronçons liés par `reverseOf`.
   Identifiants : `e{wayId}_{n}` et `e{wayId}_{n}r`. Nœuds : `n{osmId}`.
   - `lanes` : `lanes:forward` / `lanes:backward` sinon `lanes` (sens unique : toutes ; double sens : ⌈lanes/2⌉ avant,
     ⌊lanes/2⌋ arrière, minimum 1) ; absent → `DEFAULT_LANES` et `estimated.lanes = true`.
   - `maxspeed` : entier, `xx mph` (×1,609), `FR:urban` 50, `FR:rural` 80, `FR:zone30` 30, `FR:motorway` 130, `walk` 5,
     `none` 130 ; sinon `zone:maxspeed=FR:30` / `source:maxspeed=FR:zone30` → 30, `maxspeed:type=FR:urban` → 50 ;
     absent → `DEFAULT_MAXSPEED` et `estimated.maxspeed = true`. `living_street` sans tag → 20.
   - `length` = longueur de la polyligne locale ; `geometry` = tous les points OSM du segment (sens de circulation).
   - `name` = `name` sinon `ref` sinon absent.
6. **Composantes** : garder les composantes faiblement connexes qui contiennent au moins un nœud frontière ;
   les autres sont supprimées (avertissement avec le nombre de tronçons retirés).
7. **Interdictions de tourner** (relations `type=restriction`, `restriction` ou `restriction:motorcar`) avec
   `from` (way), `via` (node), `to` (way) : tronçon `from` = celui d'`osmWayId` = from arrivant en via ; tronçon `to` = celui
   partant de via. `no_*` → `bannedTo` ; `only_*` → bannir toutes les autres sorties de via depuis `from`. `via` en way → ignoré (avertissement).
   Les demi-tours sont déjà exclus par `nodeMovements()` hors impasse.
8. **Stops et cédez-le-passage** : nœud `highway=stop|give_way` avec `direction=forward|backward` : l'approche concernée est
   le tronçon (dans ce sens) qui contient ce nœud et le nœud topologique atteint ensuite dans ce sens ; sans `direction`,
   choisir le nœud topologique le plus proche (≤ 40 m) dans un seul sens si l'autre est plus loin, sinon les deux.
   Résultat : `controls[node] = { type: 'stop'|'give_way', yieldEdges: [...] }` (fusion si plusieurs). `stop=all` → toutes les approches.
9. **Feux** : nœuds `traffic_signals` (topologiques ou rattachés au nœud topologique le plus proche ≤ 30 m dans le sens
   `traffic_signals:direction` s'il existe). Regroupement union-find des nœuds à feux distants de ≤ `SIGNAL_CLUSTER_DISTANCE_M`
   (30 m) → un `SignalController` par groupe, `controls[node] = { type: 'signals', controllerId }`, plan par défaut
   (`createDefaultSignalPlan`, §5.4). `crossing=traffic_signals` isolé (passage piéton) → ignoré.
10. **Labels** de nœud : noms distincts des tronçons incidents (max 2) joints par « / ».
11. **Statistiques** renvoyées : nombre de ways lus, tronçons, nœuds, entrées, sorties, feux, stops, restrictions, avertissements.
12. Performance : cible < 1 s pour 5 000 ways. Pas de balayage O(n²) (index par nœud).

`communes.ts` : `searchCommunes(query, signal?)` → saisie de 5 chiffres : `?codePostal=` (plusieurs communes partagent un code
postal, toutes sont renvoyées) ; saisie de 1 à 4 chiffres : renvoie `[]` sans requête (l'interface affiche « saisissez les
5 chiffres du code postal ») ; sinon `?nom=`. Toujours
`fields=nom,code,codesPostaux,centre,population,surface&boost=population&limit=10`, résultats triés par population décroissante.
`fetchCommune(code, signal?)` ajoute `contour`. Erreurs réseau relayées en français.

`overpass.ts` : requête identique à `scripts/extract-city.mjs` (poly simplifié Douglas-Peucker 1,5·10⁻⁴ °, un filtre `poly:` par
anneau extérieur d'un MultiPolygon), POST `data=`, timeout 180 s, miroirs `overpass-api.de` → `overpass.kumi.systems` →
`lz4.overpass-api.de`, erreurs 429/504 relayées en français, `onProgress` pour l'interface.
**Le lot A ne touche pas à IndexedDB** : le cache `osm:<code>` appartient à `persistence.ts` (lot C), qui appelle
`getCachedExtract` avant `fetchOsmExtract` et `putCachedExtract` après.

## 5. Moteur (lot B)

### 5.1 Structures internes
Tableaux typés indexés par tronçon (`edgeIndex`) et par mouvement. Vehicle : `{ id, route: number[] (indices de tronçons),
routeIdx, edgeEnterTime, arrivalTime (au bout du tronçon en écoulement libre), departTime, originKey, destKey, delay, dist }`.
Par tronçon : file FIFO (tableau circulaire ou array), `capacity = max(lanes, ⌊length / vehicleLength⌋ × lanes)`,
`budget` (véhicules déchargeables accumulés), `travelTimeEma`.

### 5.2 Pas de simulation (dt = 1 s), temps `t`
1. **Feux** : mettre à jour chaque contrôleur (§5.4) ; obtenir l'état de chaque mouvement piloté : `red | green(protected|permitted) | amber`.
2. **Injection** : arrivées d'horodatage ≤ t (générées à l'init, §5.3). Itinéraire calculé à l'injection (§5.5). Si aucun
   itinéraire → comptabilisé `notInjected` avec avertissement agrégé. Si le premier tronçon est plein → le véhicule attend
   à l'entrée (file virtuelle, `waitingAtEntries`). En fin de simulation, les véhicules restés en attente sont `notInjected`.
3. **Décharge** aux nœuds, tronçons parcourus dans un ordre mélangé par pas (PRNG dédié). Budget **par place** :
   `budgetLane: Float64Array(lanes)`, chaque place `k` accumule `saturationFlow / 3600` par pas, plafonné à 1.
   Examiner les `lanes` premiers véhicules de la file ayant `arrivalTime ≤ t` (en tête) ; le k-ième véhicule examiné
   n'utilise que `budgetLane[k]` (un véhicule bloqué gaspille le budget de sa place, sans report sur les autres) :
   - véhicule à destination (tronçon courant = dernier de l'itinéraire) → retiré, statistiques de sortie ;
   - mouvement `m = courant>suivant` : rouge → bloqué (occupe une « voie ») ; tronçon suivant plein (`count ≥ capacity`) → bloqué ;
   - démarrage : si le vert du mouvement a commencé il y a < `startupLostTime` → bloqué ;
   - orange : franchissable seulement pendant les `amberUsable` premières secondes ;
   - cession (mouvement `permitted`, ou carrefour sans feux où `m` n'est pas prioritaire, §5.6) : capacité `c_m` (véh/s)
     calculée sur le flux conflictuel (§5.6) ; `budgetM[m] += c_m` **plafonné à 1** et **remis à 0** dès qu'aucun véhicule
     n'est en tête pour `m` (pas d'accumulation pendant l'attente) ; franchissement seulement si `budgetM[m] ≥ 1` ;
     au stop : en plus, le véhicule doit être en tête depuis ≥ `stopDelay` s ;
   - sinon si `budgetLane[k] ≥ 1` : transfert vers le tronçon suivant (`budgetLane[k] −= 1`, `budgetM[m] −= 1`), `edgeEnterTime = t`,
     `arrivalTime = t + length / v`, statistiques du tronçon quitté (temps de parcours, retard = temps − temps libre),
     comptage du franchissement pour les flux conflictuels (`flowEma[m]`, constante 60 s).
   Un véhicule bloqué consomme l'une des `lanes` places examinées : les véhicules derrière lui sur la file ne sont pas examinés
   au-delà des `lanes` premiers (blocage par la tête de file, approximation multi-voies).
4. **Files** : un véhicule est « en file » si `arrivalTime ≤ t` et non transféré ; longueur de file = nombre de véhicules en file.
5. **Statistiques** (§5.7) et détection de fin : `t ≥ warmup + duration` ⇒ `done` (les véhicules encore en circulation sont comptés `inCirculation`).

Position pour l'animation : `min(v·(t − edgeEnterTime), length − idxDepuisLaTête × vehicleLength / lanes)`. Frames :
véhicules `[id, edgeIdx, pos, enFile]` (`VEHICLE_STRIDE = 4`) en `Float32Array` transférable ; `id` est stable pendant
toute la simulation (numérotation dans l'ordre des arrivées) pour permettre l'interpolation côté interface.

### 5.3 Demande et variables aléatoires communes (`demand.ts`)
`generateArrivals(network, demand, settings) → Arrival[]` triés par temps, sur `[0, warmup + duration)`.
- Un flux PRNG nommé par entrée (`seed ⊕ hash("entry:" + nodeId)`) : processus de Poisson d'intensité `flow × globalFactor / 3600`.
  Ajouter ou modifier une entrée ne change pas les tirages des autres.
- Destination : avec probabilité `internal.entryInternalShare` (si `internal.enabled`) → tronçon interne tiré au sort
  (poids `INTERNAL_TRIP_WEIGHT[highway] × length`, hors tronçons touchant un nœud frontière) ; sinon sortie tirée selon la
  ligne OD de l'entrée (mode `od`, ligne présente et non nulle) ou selon les poids de sortie, en excluant la sortie portée
  par le même nœud que l'entrée (retirage, puis sortie suivante si impossible).
- Trafic interne : flux PRNG `"internal"`, Poisson `generationRate × globalFactor / 3600`, origine tirée au sort comme ci-dessus,
  destination interne avec probabilité `internalDestinationShare` (≠ origine) sinon sortie selon les poids.
- Résultat déterministe pour (demande, ensemble des entrées/sorties/tronçons internes, graine) : la référence et la variante
  partagent les mêmes arrivées tant que la demande et les nœuds frontières sont identiques.

### 5.4 Feux (`engine/signals.ts` + `model/signals.ts`)
- **Fixe** : temps de cycle local `τ = (t − offset) mod cycle` ; parcours des phases : vert (durée `green`) → orange (`amber`) →
  rouge intégral (`allRed`) ; l'état des mouvements de la phase courante : `green protected|permitted` pendant le vert,
  `amber` pendant l'orange, rouge sinon. Les mouvements absents de toutes les phases restent rouges (avertissement à la validation).
- **Adaptatif** (détecteur à la ligne d'arrêt) : phase i en vert depuis `g` s ; on passe à l'orange si `g ≥ maxGreen`, ou si
  `g ≥ minGreen` et qu'aucun véhicule d'une approche verte de la phase n'a **franchi la ligne d'arrêt** ni n'est **arrivé en
  tête de file** (`arrivalTime` franchi) depuis `gap` s — une file qui se décharge prolonge donc jusqu'à `maxGreen` ;
  après orange + rouge intégral, phase suivante ; si `skipEmpty`, sauter les phases sans véhicule en file ni arrivé sur leurs
  approches (retour à la première phase avec demande ; si aucune, rester sur la phase courante au vert). `offset` ignoré.
- **Clignotant** / **off** : les nœuds du contrôleur se comportent comme `priority_class` (`flashing`) ou `priority_class` (`off`),
  état renvoyé `flashing`/`off` pour l'affichage.
- `updateSignals` à chaud : reconstruire les contrôleurs et les régulations, conserver les véhicules ; un contrôleur inchangé
  (même JSON) conserve son état courant.
- `createDefaultSignalPlan(network, nodeIds, settings?)` (model/signals.ts) : approches externes classées par cap ; axe
  principal = approche de classe la plus élevée (puis voies, puis longueur) et l'approche quasi opposée (écart ≥ 135°) ;
  axe secondaire = les autres. Phase 1 « Axe principal » : `through` et `right` de l'axe en `protected`, `left` en `permitted` ;
  Phase 2 « Axe secondaire » : idem pour les autres approches. Carrefour à 3 branches ou plus de 4 : même principe (les approches
  non appariées vont en phase 2 ; s'il n'y a qu'un axe, une seule phase + phase piétonne de rouge intégral n'existe pas : deux phases identiques
  ne sont pas créées, le contrôleur n'a qu'une phase). Vert = (cycle − Σ(orange + rouge intégral)) réparti au prorata des voies des
  approches (minimum 7 s). Orange 3 s (5 s si une approche > 50 km/h), rouge intégral 2 s, décalage 0, `minGreen 7`, `maxGreen 60`, `gap 3`.
  Fournir aussi `controllerCycle(c)`, `validateController(network, c) → string[]` (mouvements jamais verts, conflits protégés
  simultanés (deux mouvements `protected` en conflit dans une même phase), durées ≤ 0), `controllerMovements(network, c) → Movement[]`
  (mouvements pilotés : approche externe au regroupement).

### 5.5 Itinéraires (`routing.ts`)
- Graphe de tronçons : successeurs de `e` = `nodeMovements(network, e.to)` filtrés sur `from === e`. Tronçons fermés exclus.
  Un tronçon dont `to` est un nœud frontière n'a aucun successeur (`nodeMovements` renvoie `[]`) : on ne traverse pas la frontière.
- **Temps de référence** d'un tronçon = temps de parcours libre `length / v` **+ retard structurel du
  carrefour qu'il aborde** (`structuralDelays`) : retard uniforme de Webster à saturation nulle pour un feu
  (`C (1 − part de vert)² / 2`, part de vert fournie par le moteur de feux), temps d'arrêt + temps perdu au
  redémarrage pour un stop, temps perdu au redémarrage pour une cession sans arrêt. Sans ce terme, le coût
  d'un tronçon jamais emprunté ne contenait que sa longueur : une rue de lotissement à huit croisements
  paraissait aussi rapide qu'un axe, le routage y envoyait tout le monde pour l'apprendre à ses dépens —
  puis l'oubliait, la mémoire des mesures décroissant vers ce même temps à vide optimiste. Le temps de
  référence est le plancher de cette décroissance : la leçon ne s'efface plus. Il s'applique aussi en
  routage statique, où il est simplement une meilleure estimation du temps de parcours.
- En routage dynamique, le coût est recalculé toutes les `routingIntervalMin` minutes (et à t = 0) sur
  **l'état courant** du tronçon, et non sur le seul souvenir de ses derniers passages :
  `coût = max(EMA des temps mesurés ramenée vers le temps de référence, référence + retard de la file présente)`.
  - La moyenne des temps mesurés n'est alimentée qu'à la sortie d'un véhicule. Sans correctif, un tronçon que
    le routage cesse d'alimenter n'est plus jamais mesuré : sa moyenne reste figée sur la congestion passée,
    le routage continue de l'éviter, et rien ne le réhabilite. Elle décroît donc vers le temps libre en
    fonction du temps écoulé depuis la dernière observation (`decayTowardFree`, même constante de 300 s) :
    l'absence de mesure est en soi l'indice que personne n'y circule.
  - Symétriquement, un tronçon bouché dont aucun véhicule ne sort est lui aussi dépourvu de mesure ; le laisser
    retomber au temps libre le rendrait attractif au pire moment. Le terme `queueDelay` majore donc le coût à
    partir de la file moyenne présente, du stockage et du débit de décharge.
  - La file retenue est une moyenne glissante et non un relevé instantané : pris au hasard dans un cycle de
    feux, un relevé donne tantôt le creux tantôt la pointe et fait osciller le routage d'un itinéraire à l'autre.
  - **Amortissement à la hausse** (`smoothCosts`, α = 0,5) : la table observée ne remplace pas la précédente,
    elle s'y mêle — mais seulement quand le coût monte. Une dégradation doit être confirmée sur plusieurs
    recalculs avant de détourner le trafic, alors qu'un tronçon qui vient de se vider est réessayé tout de
    suite. Sans cette asymétrie, on retomberait sur le défaut inverse : l'itinéraire congestionné puis
    délaissé à jamais (`repro-routage.test.ts`).
  - **Partage entre variantes** (`variantFactors`, 3 jeux de coûts, ±15 %) : chaque véhicule est affecté,
    selon la graine et son rang d'arrivée, à l'un de trois jeux de coûts — celui du modèle, et deux
    perturbés en sens opposés (variantes appariées : la moyenne des perturbations est nulle sur chaque
    tronçon, et l'itinéraire réellement le plus rapide garde au moins la part de la variante non perturbée).
    Deux itinéraires de coûts voisins se partagent ainsi le flux au lieu de se le disputer d'un intervalle
    à l'autre. C'est l'affectation stochastique de Burrell, et elle ne s'applique qu'en routage dynamique :
    sans recalcul, le plus court chemin doit rester le plus court chemin.
  - Effet mesuré sur les dossiers réels de Veauche (4 graines, 60 min), retard moyen — réseau sain, puis
    même réseau avec un carrefour bloqué : 67 s / 430 s à l'origine ; 21 s / 226 s avec l'amortissement et
    le partage ; **15 s / 41 s** une fois le coût de carrefour ajouté, soit le niveau du routage statique
    (15 s / 39 s) sans en perdre les bénéfices (sur la démonstration chargée à 4 600 véhicules, le routage
    dynamique reste meilleur que le statique : 150 s contre 182 s). L'amortissement seul ne suffit pas
    (53 s / 549 s) : il ne partage rien, et sur un réseau saturé il retarde surtout la fuite.
  - **Essayé et écarté** : borner la part du flux qui bascule à chaque recalcul, en ne rafraîchissant
    qu'une variante sur trois à tour de rôle (moyennes successives sur les flux). Mesuré : 55 s / 387 s,
    soit nettement pire que sans. La raison est symétrique de l'effet recherché — deux tiers des véhicules
    gardent une vision du réseau vieille de cinq à quinze minutes, et continuent donc de s'engouffrer dans
    un contournement déjà saturé. Le défaut ne venait pas de la vitesse d'adaptation mais de l'estimation
    elle-même : c'est le coût de carrefour qui le corrige.
  - Limite qui demeure : à l'intérieur d'une variante, l'affectation reste « tout ou rien » — trois jeux de
    coûts partagent le flux en trois, pas en un continuum. Un équilibre au sens strict demanderait une
    affectation itérative (Frank-Wolfe) que le moteur, qui simule en temps réel, ne peut pas faire.
- Destinations « sortie » : Dijkstra inverse par nœud de sortie → `costToGo[edge]` (Float64Array), itinéraire construit
  par descente gloutonne (`argmin cost(e') + costToGo(e')`) au moment de l'injection.
- Destinations « tronçon interne » : Dijkstra direct à cible unique depuis le tronçon d'origine, cache `(origine, destination)`
  vidé à chaque recalcul. Itinéraire = liste d'indices de tronçons, du premier tronçon (sortant de l'entrée, ou tronçon d'origine)
  au dernier (entrant dans la sortie, ou tronçon de destination).
- `shortestPathNodes(network, from, to)` utilitaire exporté (onde verte, ajout de tronçon) : chemin en nœuds sur temps libre.
- **Les k itinéraires les plus courts** (`itineraires.ts`, outil de carte « itinéraires », §7) :
  `itinerairesLesPlusCourts(network, from, to, { count, settings })` rend les `count` chemins (5 par défaut) les
  plus rapides d'un nœud à un autre, du meilleur au moins bon, sans boucle ni doublon. Algorithme de Yen sur le
  **même** graphe de tronçons que le moteur : sens uniques, interdictions de tourner, demi-tours, tronçons fermés
  et nœuds frontières s'appliquent donc sans qu'on ait à les redire. Les coûts sont ceux du temps de référence
  ci-dessus (`settings` fournis : `SignalEngine` + `buildPriorityTables` + `structuralDelays`), à ceci près que le
  retard d'un carrefour n'est compté que s'il est **traversé** — le dernier tronçon n'en subit rien, on y arrive.
  Le retard porte donc l'arc du graphe (transition tronçon → tronçon) et non le sommet, ce qui reste un Dijkstra à
  coûts positifs. Un itinéraire affiché est ainsi un itinéraire que la simulation pourrait choisir, et son temps
  celui qu'elle lui prête à réseau vide. Le nombre de recherches est plafonné (`MAX_RECHERCHES`) : au-delà, la
  liste est complétée par les meilleurs candidats déjà rencontrés — ce sont de vrais itinéraires, seul leur rang
  exact n'est plus garanti. Mesure sur Veauche (1 638 tronçons), traversée de la commune de bout en bout : 5
  itinéraires en ~90 ms, calcul synchrone dans le fil de l'interface.
- **Itinéraire par point de passage** (`itineraireParPassage(network, from, passage, to, opts)`) : le plus
  court chemin contraint à **traverser** un nœud, ajouté à la liste précédente. Ce n'est pas la
  concaténation de `from → passage` et `passage → to` : leur jonction serait un mouvement quelconque au
  carrefour de passage, demi-tour ou tourne-à-gauche interdit compris. La contrainte porte donc le
  **mouvement** : une exploration depuis l'origine, une exploration inverse vers la destination (`cout[f]` =
  coût de l'engagement sur `f` jusqu'à l'arrivée), puis le minimum de `amont[e] + retard[e] + aval[f]` sur
  les mouvements autorisés du nœud de passage. Un nœud frontière n'a aucun mouvement : il ne peut donc pas
  être imposé, ce qui est la bonne réponse — on ne le traverse pas. L'itinéraire obtenu peut réemprunter un
  tronçon déjà parcouru (détour puis retour, le demi-tour restant interdit) ; c'est le propre d'un passage
  imposé, et le seul cas où un itinéraire de la liste n'est pas élémentaire.

### 5.6 Priorités hors feux (`priority.ts`)
Pour chaque nœud non signalisé (ou `flashing`/`off`), précalculer par mouvement `m` la liste des mouvements auxquels il cède.
Conflit = `movementsConflict()` (geometry.ts). Position relative des approches = `relativeSide()` (`right` / `left` / `opposite`,
tolérance ±30° autour de l'opposition). Règles (`control.type`) :
- **Règle « priorité à droite » (utilisée par plusieurs cas ci-dessous)** : `m` cède à `n` (conflictuels) si l'approche de `n`
  est `right` ; si elles sont `opposite`, `m` cède seulement si `m.turn` ∈ {`left`, `uturn`} et `n.turn` ∈ {`through`, `right`}.
- `stop` / `give_way` : un mouvement dont l'approche ∈ `yieldEdges` cède à tout mouvement conflictuel d'une approche ∉ `yieldEdges`
  (créneau `stop` 6 s / `giveWay` 5 s). Entre deux approches ∈ `yieldEdges`, et entre deux approches ∉ `yieldEdges`,
  appliquer la règle « priorité à droite » (créneau `priorityRight`). `yieldEdges` vide = toutes les approches cèdent.
- `priority_class` : `m` cède à `n` si `highwayRank(approche de n) < highwayRank(approche de m)` (créneau `giveWay`) ;
  à rang égal, règle « priorité à droite » (créneau `priorityRight`). Les bretelles `*_link` ont un rang intermédiaire
  (§ types.ts) : une bretelle cède à sa voie mère.
- `priority_right` : règle « priorité à droite » (créneau `priorityRight`).
- `roundabout` avec anneau : un mouvement entrant (approche non anneau) cède aux mouvements **conflictuels** dont l'approche
  est un tronçon d'anneau (créneau `roundabout`).
- `roundabout` sans anneau (mini-giratoire) : `m` cède à `n` si `passesEntry(n, m)` (geometry.ts) — `n` circule sur l'anneau
  virtuel devant l'entrée de `m` (créneau `roundabout`). Le test de conflit de cordes ne s'applique pas.
- Feux, mouvement `permitted` : `m` cède aux mouvements conflictuels actuellement verts qui ne sont pas eux-mêmes `permitted`
  cédant à `m` ; entre deux `permitted` en conflit, règle « priorité à droite ». Créneau `permittedLeft`.
Capacité de cession (véh/s) : `qc` = somme sur les mouvements prioritaires conflictuels `n` de
`max(flowEma[n], (n a un véhicule en tête prêt à franchir et son aval n'est pas plein) ? lanes(n) × saturationFlow / 3600 : 0)` —
le second terme annule la capacité tant qu'une file prioritaire se décharge (cas du tourne-à-gauche permis en début de vert).
Un mouvement prioritaire dont le tronçon aval est plein ou dont le mouvement est au rouge ne compte pas dans `qc`.
`c = qc·exp(−qc·tc) / (1 − exp(−qc·tf))` si `qc > 0`, sinon `1 / tf` (tc = créneau critique, tf = `followUpTime`).

### 5.7 Statistiques (`stats.ts`)
Hors chauffe. Par tronçon : `entered`, `exited`, temps de parcours et retard cumulés, échantillonnage par pas de la file
(max, moyenne), `flowVehH = exited / duration × 3600`, `meanSpeedKmh = length / meanTravelTime`, `saturation = flowVehH /
(saturationFlow × lanes × partDeVert)` avec partDeVert = part du cycle où au moins un mouvement du tronçon est vert (1 sans feux).
Par sortie : `count`, `flowVehH`, temps de parcours et retard moyens origine→sortie. Par carrefour : par approche `vehicles`,
`meanDelayS` (retard sur le tronçon d'approche), `maxQueue`. Réseau : `entered`, `exited`, `inCirculation` (à la fin),
`notInjected`, `totalDelayS`, `meanDelayS` (par véhicule sorti), `meanTravelTimeS`, `vehKm`.
Séries par intervalle de `statsIntervalMin` (temps de début, chauffe comprise pour l'axe mais valeurs calculées sur l'intervalle) :
tronçon `flow` (véh/h), `delay` (s), `queue` (moyenne) ; sortie `count` ; réseau `entered`, `exited`, `inCirculation`, `meanDelay`.

### 5.8 Worker (`worker.ts`, `client.ts`)
Boucle `setTimeout` : en mode cadencé, exécuter `speed × Δréel` pas (max 200 pas par tour), envoyer une frame toutes les
≥ 50 ms réelles ; en mode rapide, tours de 250 ms réels avec une frame par tour. `status` à chaque changement et chaque seconde
(`stepsPerSecond` mesuré). `stats` à chaque fin d'intervalle. `done` avec résultats complets. Erreurs capturées → `error`.
`SimClient` (côté interface) : `new SimClient(onMessage)`, méthodes typées pour chaque `ToWorker`, `dispose()`. Le Worker est
créé avec `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.

## 6. Store et persistance (lot C)

- Zustand + `immer` (`produceWithPatches`) : chaque action annulable applique une recette au `project` et empile
  `{ label, patches, inversePatches }` (100 entrées max). `undo`/`redo` appliquent les patches et marquent `sim.stale`.
  Les actions d'édition appellent `reconcileDemand()` après toute modification de topologie et ajoutent une ligne à `project.changes`.
- Le glisser vit **hors du projet** : `beginNodeDrag`/`dragNode` n'écrivent que `AppState.drag` (pas d'immer, pas de `stale`,
  pas d'autosauvegarde) et le renderer superpose la position transitoire aux tronçons incidents. `endNodeDrag` applique une
  seule `produceWithPatches` (position, extrémités des géométries incidentes, `length`, fusion si `dropOn`) et n'empile rien si
  la position finale est identique. Coordonnées arrondies au centimètre. `reconcileDemand`/`sanitizeNetwork` sont calculés hors
  recette immer (ou sur `current(draft)`) pour éviter le coût des proxys.
- `mergeNodes(source, target)` : rebrancher les tronçons de `source` sur `target`, supprimer les tronçons devenus boucles,
  fusionner les doublons `from/to` identiques (garder le plus court), mettre à jour `reverseOf`, `bannedTo`, `controls`, `controllers.nodeIds`.
- `setEdgeDirection` : `oneway` supprime le tronçon inverse ; `reverse` échange from/to, inverse la géométrie, supprime l'inverse ;
  `twoway` crée l'inverse (copie des attributs, géométrie inversée). Interdictions de tourner et mouvements de phases
  référencés par un tronçon supprimé sont nettoyés (`sanitizeNetwork()` dans edits.ts, exporté et testé).
- `setNodeControl(node, {type:'signals'})` sans contrôleur : crée `createDefaultSignalPlan(network, [node])`. Passer d'un
  contrôleur à autre chose retire le nœud du contrôleur (supprimé s'il n'a plus de nœud).
- `applyGreenWave(a, b)` : chemin `shortestPathNodes` ; pour les contrôleurs rencontrés dans l'ordre, `offset[k] = (offset[k−1] +
  tempsLibre(k−1→k)) mod cycle[k]` ; le premier garde son décalage.
- Simulation : `simStart` fait `init` si `stale` ou jamais initialisé, puis `run(speed)` ; `frame` et `stats` écrivent
  `sim.frame` / `sim.results` **hors immer** (pas de gel profond, pas de `dirty`, pas d'autosauvegarde) ; `project.lastResults`
  n'est écrit qu'à `done`. Le client moteur (Worker) n'est instancié qu'au premier `simStart` (`AppStoreOptions.createClient`
  permet de le remplacer en test).
  Toute modification de feux/régulation pendant une simulation non stale envoie `updateSignals` ; toute autre édition met `stale = true`.
- Persistance (`idb-keyval`) : `project:current` autosauvegardé (debounce 800 ms) **uniquement** après une action annulable,
  `done`, `freezeReference`/`clearReference` ou `setProjectName` — jamais sur `frame`/`stats` ; sérialisation par
  `JSON.stringify` dans un `requestIdleCallback` (repli `setTimeout`), la chaîne étant stockée telle quelle.
  `library:index` + `library:<id>` ;
  `osm:<code>` cache d'extrait ; `fake-indexeddb` pour les tests. Au démarrage : projet courant sinon démo Veauche.
- Export : `JSON.stringify(project)`, nom `circulation-<slug>-<AAAA-MM-JJ>.json`. Import : `validateProject()` (schema.ts) → erreurs en français.
- `sanitizeNetwork(network)` (edits.ts, pur, exporté et testé) rétablit la validité topologique : `bannedTo[i]` conservé seulement si
  `edges[bannedTo[i]].from === edge.to` ; clé de phase `a>b` conservée seulement si `edges[a]` et `edges[b]` existent,
  `edges[a].to === edges[b].from` et ce nœud ∈ `controller.nodeIds` ; `controller.nodeIds` purgé des nœuds disparus, contrôleur
  sans nœud supprimé ; `controls` purgé des nœuds disparus et des `yieldEdges` disparus ; `reverseOf` non symétrique effacé.
  Appelé après **toute** action topologique, y compris `setEdgeDirection('reverse')` (dont les `bannedTo` sont vidés) et `mergeNodes`.
- Après toute action annulable (undo/redo et chargement compris), `selection`, `hover` et `ui.toolNodes` sont purgés des
  identifiants disparus ; l'historique est vidé au chargement d'un projet.
- `bootstrap()` : `refreshLibrary()`, puis `project:current` s'il existe, sinon `loadDemo('veauche')`. Idempotent.
- `loadExtract` renseigne `meta.import = { stats, warnings }` et ajoute en tête des avertissements
  « Réseau de N tronçons (> 5 000) : la simulation peut être lente » le cas échéant.
- CSV (`csv.ts`) : séparateur `;` ou `,` détecté, en-tête optionnel, décimales avec virgule acceptées.
  Format A `entree;debit` (identifiant de nœud ou label exact, débit véh/h) ; format B `entree;sortie;part` (alimente `od` et passe `destinationMode = 'od'`).
  Export : format A pour les entrées + lignes `# sorties` puis `sortie;poids`.

## 7. Interface (lots D et E)

Disposition : barre supérieure (nom du projet éditable, annuler/rétablir, enregistrer, importer, exporter JSON, contrôles de
simulation : lecture/pause, réinitialiser, vitesse ×1…×120, calcul rapide, horloge `mm:ss` et barre de progression, indicateurs
véhicules en circulation / entrés / sortis) ; barre latérale gauche à onglets (Ville, Réseau, Feux, Trafic, Résultats, Comparer, 380 px) ;
carte à droite avec légende (mode de couleur) et bascule fond de carte / véhicules / étiquettes.

### Carte (lot D)
- Leaflet, tuiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, attribution ODbL. **Deux** canvas superposés dans le même pane :
  *statique* (tronçons, nœuds, étiquettes, surbrillance, hachures), redessiné seulement sur `moveend`, `zoomend` ou changement
  d'identité de `network`, `colorMode`, `selection`, `results` ou `drag` ; *dynamique* (véhicules, points de feux, chemin de l'outil),
  redessiné par `requestAnimationFrame` seulement quand `sim.status === 'running'`. Sur `zoomanim` : `L.DomUtil.setTransform` sur les
  deux calques ; sur `move` : `L.DomUtil.setPosition`. Cache par tronçon indexé sur l'identité de l'objet `NetEdge` (immuable) :
  pixels projetés pour le zoom courant et longueurs cumulées (`Float32Array`) pour placer un véhicule par recherche dichotomique ;
  ce cache sert aussi au test de sélection à 8 px. En dessous du zoom 14 : ni véhicules ni classes `residential`/`living_street`.
  Interpolation des véhicules par `id` entre deux frames quand le tronçon est identique, sinon position brute ; véhicule absent
  de la nouvelle frame = supprimé. Conversion mètres locaux → LatLng via `projection.ts`.
- Dessin : tronçons (largeur selon voies et zoom, couleur selon `colorMode`, tronçons fermés hachurés, sens unique : chevrons),
  nœuds (cercle ; frontière : carré ; feux : icône), état des feux au niveau des lignes d'arrêt (point vert/orange/rouge par approche
  externe pilotée), véhicules (rectangles orientés le long de la polyligne, interpolés entre frames), étiquettes (noms de rue,
  valeurs numériques du mode de couleur au zoom ≥ 16), surbrillance sélection/survol, chemin en cours (outil onde verte),
  itinéraires comparés (outil « itinéraires »).
- **Itinéraires comparés** : les cinq chemins les plus courts entre deux nœuds (§5.5) sont dessinés sur le calque
  statique, par-dessus les étiquettes, du plus lent au plus rapide pour que le meilleur reste visible là où tous se
  superposent — ce qui est le cas de l'essentiel de leur longueur. Chaque ruban porte la couleur de son rang
  (`itineraireColor`, cinq teintes franchement séparées) et est **écarté latéralement** d'un rang à l'autre
  (`offsetPolyline`, 3,5 px) : là où deux itinéraires se confondent on lit une bande rayée, là où ils divergent
  chaque ruban part de son côté. Le temps de parcours est écrit dans une étiquette posée sur un tronçon qui
  n'appartient qu'à cet itinéraire — au milieu du trajet, les cinq étiquettes se superposeraient sur la partie
  commune. Survoler une ligne du tableau (`ui.itineraires.actif`) met son itinéraire au premier plan et estompe
  les autres. Un aperçu périmé (réseau modifié depuis le calcul) n'est pas dessiné : `MapView` le remplace par
  `null` dans la scène et le panneau propose de recalculer. Un itinéraire par point de passage porte en plus
  un anneau à sa couleur sur le nœud imposé : sans lui, on lirait bien qu'il est plus long, mais pas où il a
  été obligé de passer. La palette compte huit teintes et non cinq, chaque point de passage ajoutant un
  itinéraire à la liste.
- Étiquettes : les valeurs sont posées d'abord, les noms de rue ensuite (repli, une fois par nom), dans une grille d'occupation
  qui réserve le **rectangle** de chaque étiquette — un nom ne prend donc jamais la place d'un chiffre et rien ne se chevauche.
  Les deux sens d'un tronçon à double sens tiennent dans une **seule** étiquette à deux lignes, posée entre les deux chaussées,
  chaque ligne précédée d'une flèche orientée dans le sens qu'elle chiffre et coloriée par l'échelle ; sur un sens unique,
  l'étiquette reste à une ligne, la couleur de l'échelle passant par le trait sous le chiffre.
- Interactions : clic = sélection (tolérance 8 px, nœuds prioritaires), glisser d'un nœud = `beginNodeDrag`/`dragNode`/`endNodeDrag`
  (Leaflet `dragging` désactivé pendant), dépôt sur un autre nœud (surligné) = fusion, `Suppr` = supprimer la sélection,
  molette = zoom Leaflet, outils à deux clics via `toolClickNode` (onde verte, ajout de tronçon, itinéraires). L'outil `addNode` fait exception : il agit
  sur un clic **n'importe où** et non sur un clic de nœud, la décision étant prise par `mapClickAction(tool, hit)`
  (pure, donc vérifiable sans navigateur). Un nœud posé naît isolé : il ne devient utile qu'une fois raccordé
  avec « Ajouter un tronçon », ce que dit l'aide de l'outil.
- `colors.ts` : échelles séquentielles (flux, retard, saturation, file), divergente (deltas), qualitative (classes). Légende avec bornes.

### Panneaux (lot E)
- **Ville** : recherche avec autocomplete (debounce 250 ms, nom ou code postal, liste nom + code postal + population), bouton
  charger (indicateur de progression : contour → Overpass → graphe), démos embarquées, bibliothèque (liste, charger, supprimer),
  statistiques du réseau chargé et avertissements d'import, attribution.
- **Réseau** : selon la sélection. Nœud : label, type de régulation (liste), approches qui s'arrêtent/cèdent (cases), matrice
  d'interdictions de tourner (approches × sorties), supprimer. Tronçon : nom, classe, voies, vitesse (avec badge « estimée »),
  sens (sens unique / inverser / double sens), fermé, appliquer aussi au sens opposé, supprimer. Sans sélection : aide + outils
  (poser un nœud, ajouter un tronçon, onde verte, itinéraires). Sous les outils, le résultat de l'outil
  « itinéraires » : les cinq chemins classés (rang et pastille de couleur, temps, écart au plus rapide,
  longueur), le survol d'une ligne mettant l'itinéraire correspondant en avant sur la carte, et un bouton
  « ajouter un itinéraire par un point de passage » qui arme un outil à **un seul clic** : le nœud cliqué
  devient un passage imposé, l'itinéraire correspondant prend son rang au temps dans la même liste et est
  mis en avant. Un passage déjà situé sur un itinéraire de la liste ne le duplique pas : celui qui répond
  déjà à la question est mis en avant, et on le dit. Le bloc
  survit au changement d'outil — la comparaison sert à décider d'une modification, qu'il faut pouvoir faire sans
  perdre la réponse — mais pas à une modification du réseau, qui le périme et propose un recalcul.
- **Feux** : liste des contrôleurs (nom, nœuds, cycle, mode, avertissements de validation) ; éditeur : mode, décalage, orange,
  rouge intégral, phases (cartes réordonnables : nom, vert, min/max/gap en adaptatif, schéma du carrefour cliquable : chaque
  mouvement = flèche, cycle clic : rouge → protégé → permis), ajouter/supprimer une phase, régénérer, diagramme temporel du cycle
  (barres par phase). Schéma : approches placées par `approachAngle`, flèches courbes vers `exitAngle`.
- **Trafic** : curseur global, graine, tableau des entrées (label, classe, débit, activée, estimé, recherche), sorties (poids, recherche), mode de
  destination, matrice OD (tableau éditable, parts en %), trafic interne, import/export CSV, réglages de simulation (durée,
  chauffe, routage dynamique, paramètres avancés repliés).
- **Résultats** : synthèse réseau (tuiles), tableaux triables et filtrables tronçons / sorties / carrefours (clic = sélection sur la carte),
  courbe temporelle de l'élément sélectionné (SVG), export CSV des tableaux, mode de couleur de la carte.
- **Comparer** : « Figer comme référence » (avec ses résultats), tableau référence / variante / écart pour la synthèse,
  écarts par tronçon et par sortie (tri par |Δ|), boutons carte Δ retard / Δ débit, effacer la référence.
- Composants : `NumberField` (validation, unités), `DataTable` (tri, filtrage, formatage), `ChampRecherche`,
  `Sparkline`/`LineChart` SVG, `Modal`.
- **Recherche rapide** : toute liste d'au moins `SEUIL_RECHERCHE` lignes (tronçons, carrefours à feux, entrées, sorties)
  porte un champ de recherche. La comparaison ignore casse, accents et forme de l'apostrophe ; les mots saisis sont
  cumulatifs et sans ordre imposé (`src/ui/components/recherche.ts`). Dans un `DataTable`, le filtre porte sur les colonnes
  textuelles et s'applique **avant** le bornage `maxRows` : une voie est trouvée même au-delà des lignes affichées.
  Pour les carrefours à feux, la recherche porte aussi sur les rues qui s'y croisent.
- Toutes les chaînes en français dans `src/ui/strings.ts`. Nombres formatés `fr-FR`.

## 8. Tests et qualité

- Vitest, environnement node (jsdom pour les composants si nécessaire — `@testing-library/react` autorisé).
- Lot A : `osm2graph` sur un mini-extrait synthétique (rue double sens, sens unique, giratoire, stop directionnel, feux à 2 nœuds < 30 m,
  restriction `only_straight_on`, way traversant la frontière deux fois) + sur `public/demo/veauche.osm.json` (compte de tronçons > 800,
  entrées > 5, 13 restrictions traitées, aucun tronçon de longueur 0, `reverseOf` symétrique, géométries cohérentes).
- Lot B : conservation (entrés = sortis + en circulation + non injectés), décharge au débit de saturation sur un tronçon libre
  (≈ 1 800 véh/h/voie ± 5 %), remontée de file bloquant l'amont, feu fixe (aucun franchissement au rouge, cycle respecté),
  adaptatif (prolongation ≤ maxGreen), priorité (le mouvement cédant passe quand le flux prioritaire est nul), restrictions
  respectées, déterminisme (deux exécutions identiques), variables aléatoires communes (mêmes arrivées si demande identique).
- Lot C : undo/redo sur chaque action, `mergeNodes`, `setEdgeDirection`, `sanitizeNetwork`, round-trip JSON, CSV, `fake-indexeddb`.
- Lots D/E : tests de rendu légers ; Playwright e2e (`e2e/`) : chargement démo, lancement simulation, apparition des résultats,
  glisser d'un nœud, conversion d'un stop en feux, export JSON.
- `npm run build` sans erreur ; aucune dépendance supplémentaire sans justification.

## 9. Contrats inter-lots (signatures figées)

Tout appel d'un lot vers un autre passe par cette liste. Un lot qui a besoin d'autre chose l'écrit dans son compte rendu
au lieu d'inventer un nom.

**Déjà écrits (ne pas modifier)** : `src/model/types.ts`, `src/model/defaults.ts`, `src/model/geometry.ts`,
`src/model/signals.ts`, `src/engine/protocol.ts`, `src/state/storeTypes.ts`, `src/geo/types.ts`.

```ts
// src/geo/projection.ts                                                            [A]
export const EARTH_RADIUS_M = 6371008.8
export interface LocalProjection {
  center: { lon: number; lat: number }
  toLocal(lon: number, lat: number): [number, number]   // degrés → mètres locaux (arrondi au cm)
  toLonLat(x: number, y: number): { lon: number; lat: number }
}
export function createProjection(center: { lon: number; lat: number }): LocalProjection

// src/geo/communes.ts                                                              [A]
export function searchCommunes(query: string, signal?: AbortSignal): Promise<CommuneSummary[]>
export function fetchCommune(code: string, signal?: AbortSignal): Promise<CommuneDetail>

// src/geo/overpass.ts                                                              [A]
export function fetchOsmExtract(
  commune: CommuneDetail,
  opts?: { signal?: AbortSignal; onProgress?: (message: string) => void },
): Promise<OsmExtract>

// src/geo/osm2graph.ts                                                             [A]
export function osm2graph(extract: OsmExtract): ImportResult   // synchrone

// src/engine/rng.ts                                                                [B]
export function createRng(seed: number): () => number          // flottant [0,1)
export function hashString(s: string): number                  // entier 32 bits
export function randomInt(rng: () => number, maxExclusive: number): number

// src/engine/routing.ts                                                            [B]
export function shortestPathNodes(network: Network, from: NodeId, to: NodeId): NodeId[]   // [] si aucun chemin

// src/engine/itineraires.ts                                                        [B]
export const NB_ITINERAIRES = 5
export interface Itineraire {
  edges: EdgeId[]        // tronçons empruntés, du départ à l'arrivée
  nodes: NodeId[]        // nœuds traversés (edges.length + 1)
  time: number           // temps à réseau vide (s), retard des carrefours traversés compris
  length: number         // longueur cumulée (m)
  passage?: NodeId       // nœud de passage imposé (itineraireParPassage), absent sinon
}
export function itinerairesLesPlusCourts(
  network: Network,
  from: NodeId,
  to: NodeId,
  opts?: { count?: number; settings?: SimSettings },
): Itineraire[]          // du plus rapide au plus lent ; [] si nœuds confondus, inconnus ou non reliés
export function itineraireParPassage(
  network: Network,
  from: NodeId,
  passage: NodeId,       // nœud à traverser ; ni le départ, ni l'arrivée, ni un nœud frontière
  to: NodeId,
  opts?: { count?: number; settings?: SimSettings },
): Itineraire | null     // `passage` renseigné sur l'itinéraire rendu ; null si aucun ne le traverse

// src/engine/simulation.ts                                                         [B]
export class Simulation {
  constructor(init: EngineInit)
  readonly edgeIndex: EdgeId[]
  readonly warnings: string[]
  readonly time: number
  readonly endTime: number
  readonly done: boolean
  step(steps?: number): void
  frame(): Frame
  results(): SimResults
  updateSignals(controllers: Record<ControllerId, SignalController>, controls: Record<NodeId, NodeControl>): void
  reset(): void
}

// src/engine/client.ts                                                             [B]
export class SimClient implements SimClientLike {
  constructor(onMessage: (msg: FromWorker) => void)
  send(msg: ToWorker): void
  dispose(): void
}

// src/state/store.ts                                                               [C]
export const useAppStore: UseBoundStore<StoreApi<AppState>>
export function createAppStore(opts?: AppStoreOptions): UseBoundStore<StoreApi<AppState>>

// src/state/edits.ts                                                               [C]
export function sanitizeNetwork(network: Network): Network      // pur
export function moveNode(network: Network, id: NodeId, x: number, y: number): Network
export function mergeNodes(network: Network, sourceId: NodeId, targetId: NodeId): Network
export function addNode(network: Network, x: number, y: number, label?: string): Network
export function nextNodeId(network: Network): NodeId            // `x{k}`, numéroté sur les seuls nœuds

// src/state/persistence.ts                                                         [C]
export function getCachedExtract(code: string): Promise<OsmExtract | undefined>
export function putCachedExtract(extract: OsmExtract): Promise<void>

// src/state/csv.ts                                                                 [C]
export function parseDemandCsv(text: string, demand: Demand, network: Network): { demand: Demand; report: CsvImportReport }
export function serializeDemandCsv(demand: Demand, network: Network): string

// src/model/schema.ts                                                              [C]
export function validateProject(value: unknown): { ok: true; project: Project } | { ok: false; errors: string[] }

// src/model/signals.ts — dossiers de carrefour (voir §14)
export function phaseMovements(controller: SignalController, phase: SignalPhase): Record<MovementKey, GreenKind>

// src/geo/dossierFeux.ts — import du dossier d'un carrefour (voir §14)
export interface DossierImportResult {
  controller: SignalController | null      // remplace celui du carrefour désigné ; null si rien n'a été lu
  dossierId: string; nom: string
  groupesRattaches: number; groupesNonRattaches: string[]; avertissements: string[]
}
export function importDossierFeux(contenu: unknown, opts: { network: Network; controllerId: ControllerId }): DossierImportResult

// src/ui/map/colors.ts                                                             [D]
export interface ColorScale { color(value: number): string; stops: { value: number; color: string }[]; label: string; unit: string }
export function scaleFor(mode: ColorMode, results: SimResults | null, reference: SimResults | null): ColorScale
export function edgeValue(mode: ColorMode, edge: NetEdge, results: SimResults | null, reference: SimResults | null): number | null
export const HIGHWAY_COLORS: Record<HighwayClass, string>

// src/ui/map/MapView.tsx                                                           [D]
export function MapView(): JSX.Element      // lit useAppStore, plein conteneur parent

// src/ui/components/*.tsx                                                          [E]
export function NumberField(props: { label: string; value: number; onChange(v: number): void; min?: number; max?: number; step?: number; unit?: string; estimated?: boolean; disabled?: boolean }): JSX.Element
export function DataTable<T>(props: { columns: { key: string; label: string; align?: 'left'|'right'; format?(row: T): string; value(row: T): number | string }[]; rows: T[]; rowKey(row: T): string; onRowClick?(row: T): void; selectedKey?: string; initialSort?: { key: string; dir: 'asc'|'desc' }; maxRows?: number; searchLabel?: string }): JSX.Element
export function ChampRecherche(props: { value: string; onChange(v: string): void; label: string; testId?: string }): JSX.Element

// src/ui/components/recherche.ts                                                   [E]
export const SEUIL_RECHERCHE: number          // liste plus courte : pas de champ de recherche
export function normaliser(texte: string): string
export function motsDeRecherche(requete: string): string[]
export function correspond(mots: string[], champs: (string | undefined)[]): boolean
export function filtrer<T>(lignes: T[], requete: string, champs: (ligne: T) => (string | undefined)[]): T[]
export function LineChart(props: { series: { label: string; color: string; values: number[] }[]; times: number[]; unit?: string; height?: number }): JSX.Element
export function Modal(props: { title: string; onClose(): void; children: React.ReactNode }): JSX.Element
```

**Formats d'identifiants** : nœud OSM `n{osmId}` ; tronçon OSM `e{wayId}_{n}` et `…r` pour le sens inverse ;
contrôleur importé `c{plus petit osmId du groupe}` ; contrôleur créé par l'éditeur `nextControllerId()` (`src/model/signals.ts`) ;
tronçon créé par l'éditeur `x{k}` (k = max des `x\d+` existants + 1) ; inverse créé par `twoway` : `{id}r` si libre, sinon `x{k}` ;
phases `p1`, `p2`, … (nouvelles phases : `p{max+1}`).

## 10. Décisions d'implémentation notables

Points tranchés pendant la réalisation, au-delà de la spécification ci-dessus.

**Moteur**
- Une arrivée dont la sortie n'est pas atteignable depuis son entrée (sens uniques, coupure) est **redirigée**
  vers une sortie accessible, tirée au prorata des poids de sortie avec un flux aléatoire dédié
  (`reassign:<entrée>`), au lieu d'être abandonnée. Sur Veauche cela ramène la demande perdue de 19 % à 3 %.
  Une entrée qui ne dessert réellement aucune sortie est signalée nommément dans les avertissements.
- Invariants de comptage : `entered = exited + inCirculation` et `généré = entered + notInjected`.
  `notInjected` n'intègre les arrivées jamais préparées qu'une fois la simulation terminée, pour que les
  résultats intermédiaires ne comptent pas les arrivées à venir.
- La sortie du réseau consomme le budget de sa place de voie, comme un franchissement : sans cela un tronçon
  de destination déchargerait à `3600 × voies` véh/h.

**Store**
- Une modification de feux n'est appliquée « à chaud » (`updateSignals`) que si une exécution est **en cours**
  (`running` ou `paused`). À l'arrêt ou après la fin, elle marque `stale` ; le lancement suivant réinitialise
  le moteur. Sans cette règle, relancer après un changement de plan rejouait les résultats précédents et la
  comparaison référence/variante affichait un écart nul.
- Un lancement alors que la simulation est `done` réinitialise également le moteur.
- `loadProject` (donc le chargement d'une commune, d'une démonstration, d'un JSON ou d'un projet de la
  bibliothèque) déclenche l'autosauvegarde, sinon un réseau fraîchement chargé serait perdu au rechargement.
- `sanitizeNetwork` purge aussi les tronçons dont un nœud a disparu et les régulations `signals` pointant sur
  un contrôleur supprimé.
- `mergeNodes` : le nœud cible conserve ses attributs ; la régulation de la source ne migre que si la cible
  n'en a pas. `deleteEdge` ne supprime que le sens demandé.
- `validateProject` répare silencieusement ce qui peut l'être (géométrie reconstruite, longueurs recalculées,
  réglages complétés) et ne remonte que les erreurs bloquantes, plafonnées à 20.

**Interface**
- `window.__circulation` expose le store, la carte Leaflet et la projection : point d'accès de débogage,
  utilisé par les tests de bout en bout pour viser un nœud précis sur le canvas. Aucun code applicatif ne s'en sert.
- Un `<button>` se dimensionne sur son contenu même en `display: flex` : les lignes de liste portent
  `width: 100 %` pour ne pas déborder de la barre latérale.

**Import**
- `ImportStats.restrictions` compte les relations lues et comprises ; celles dont la voie `from` est hors de
  la commune sont dénombrées à part dans les avertissements.

## 11. Vérification

| Vérification | Commande | État au 4 septembre 2026 |
|---|---|---|
| Types | `npm run typecheck` | 0 erreur |
| Tests unitaires | `npm test` | 463 tests, 31 fichiers |
| Build de production | `npm run build` | réussi |
| Parcours navigateur | `npm run e2e` | 7 parcours, en local comme sur le site déployé |

Les tests de bout en bout s'exécutent sur le build de production servi par `vite preview`, sans appel réseau
externe (démonstration embarquée). Le chargement d'une commune réelle depuis l'autocomplete a été vérifié
manuellement sur Chambéry (4 887 tronçons, 31 contrôleurs de feux, 106 interdictions de tourner).

## 12. Déploiement

Le site public est <https://circulation.chaux.me>, servi par Caddy sur le VPS qui héberge déjà d'autres
sites. L'application étant entièrement statique, le déploiement se réduit à une copie de fichiers :
`npm run deploy` (script `scripts/deploy.sh`) enchaîne vérification des types, tests, build, copie vers
`/var/www/circulation.chaux.me`, validation de la configuration Caddy et contrôle du site en ligne.
`npm run deploy -- --check` rejoue ensuite les parcours navigateur sur le site déployé.

Le bloc de configuration se trouve à la fin de `/etc/caddy/Caddyfile` ; chaque intervention sur ce fichier
est précédée d'une sauvegarde `Caddyfile.bak.<horodatage>`.

**Points de configuration qui ne vont pas de soi**

- Les en-têtes de cache sur `/assets/*` et `/demo/*` sont posés via un matcher `file`, qui ne s'applique
  qu'aux fichiers réellement présents. Sans cette condition, un 404 sur un ancien bundle hériterait de
  `max-age=31536000, immutable` et serait mémorisé un an par le navigateur, sans révalidation possible :
  le cas se produit lorsqu'un onglet resté ouvert demande un morceau chargé à la demande après un
  redéploiement. Vérifié : un 404 sous `/assets/` ne porte aujourd'hui aucun en-tête de cache.
- `index.html` est servi en `no-cache` : il référence des bundles hachés, il doit donc être revalidé à
  chaque visite pour qu'une nouvelle version soit prise en compte.
- La politique de sécurité de contenu autorise exactement ce dont l'application a besoin : ses propres
  scripts, un Web Worker de même origine, les styles inline produits par React, les tuiles
  d'OpenStreetMap en images, et des connexions vers geo.api.gouv.fr et les trois miroirs Overpass.
  Toute nouvelle dépendance externe devra y être ajoutée, sinon elle sera bloquée silencieusement.
- `Strict-Transport-Security` est posé sans `includeSubDomains` : le domaine `chaux.me` porte d'autres
  sous-domaines dont l'exposition n'est pas du ressort de ce projet.

- Les réponses d'erreur ne traversent pas le bloc `header` de Caddy : un 404 ne porte donc ni les en-têtes
  de sécurité ni la suppression de la bannière `Server`. Le seul effet réellement gênant, l'héritage du
  cache d'un an, est traité par le matcher `file` ci-dessus ; le reste ne concerne que des réponses au
  corps vide et ne justifie pas de complexifier une configuration partagée avec huit autres sites.
- Le bloc en service est versionné dans `deploy/circulation.caddy` et `scripts/deploy.sh` alerte en cas de
  divergence, faute de quoi le déploiement ne serait pas reproductible sur une autre machine.

**Robustesse du chargement de commune**

Un miroir Overpass peut accepter la connexion sans jamais répondre. Le budget de calcul (180 s, aligné
sur le `[timeout:180]` de la requête) est donc doublé d'un chien de garde du premier octet de 20 s : un
miroir muet est abandonné au bout de 20 s au lieu de 3 minutes, et le suivant est essayé. Quand tous
échouent, le message final énumère la cause de chacun plutôt que la seule dernière. Enfin le chargement
est interruptible : `loadCommune` passe un `AbortSignal` et la bannière d'activité porte un bouton
« Annuler le chargement ».

## 13. Correctifs postérieurs à la mise en ligne

**Plans de feux périmés après une modification de topologie.** Fusionner deux nœuds, ajouter un tronçon ou
inverser un sens ajoute des mouvements à un carrefour à feux. Le plan existant ne les connaît pas : ils
restaient au rouge en permanence et bloquaient leur approche, sans autre signal que l'anomalie affichée dans
le panneau Feux. Cas rencontré sur un projet réel : un carrefour de 12 mouvements dont 2 seulement étaient
pilotés, 51 véhicules en file et aucun franchissement en une heure simulée.
`completeSignalPlans` (src/model/signals.ts) rattache chaque mouvement orphelin à la phase dont l'axe est le
plus proche du sien, en « protégé » si cela ne crée aucun conflit avec un mouvement protégé déjà présent,
en « permis » sinon ; un contrôleur sans aucune phase reçoit un plan par défaut complet. La fonction est
appelée par `editNetwork` après `sanitizeNetwork`, donc après **toute** modification de topologie, et par
`loadProject` afin de réparer les projets enregistrés avant ce correctif. Dans les deux cas l'opération est
consignée dans `project.changes`, et elle reste annulable puisqu'elle fait partie de la même transaction.

**Retard nul sur un tronçon bloqué.** Le retard était comptabilisé au moment où un véhicule quittait un
tronçon. Un tronçon dont aucun véhicule ne sort affichait donc un retard de zéro, précisément dans le cas le
plus grave. Il est désormais accumulé à chaque pas dans `sampleQueue` : chaque véhicule en attente accumule
`dt` secondes. Pour un véhicule qui finit par passer, la mesure est identique à l'ancienne (temps de parcours
moins temps à vide) ; elle capte en plus le retard de ceux qui restent bloqués.
`EdgeStats.totalDelayS` expose le retard cumulé en véhicules-secondes, et `EdgeStats.meanDelayS` le rapporte
désormais aux véhicules **entrés** sur le tronçon et non à ceux qui en sont sortis. `ApproachStats.vehicles`
compte pour la même raison les véhicules entrés, faute de quoi une approche bloquée pèserait zéro dans le
retard moyen de son carrefour.


## 14. Dossiers de carrefour réels

Les communes disposent, pour chaque carrefour à feux, d'un « dossier de carrefour » qui décrit les groupes de
signaux, les phases, les plans horaires et les temps de sécurité. Un format JSON documenté les transcrit,
**un fichier par carrefour** : le dossier est à la racine du fichier, sous les métadonnées de la commune
(`commune`, `date_extraction`, `glossaire`). Le simulateur sait en représenter et en exploiter la partie
qui gouverne la circulation.

**C'est l'exploitant qui désigne le carrefour** : il sélectionne le feu sur la carte, puis charge le fichier
de ce feu depuis le panneau Feux (`importDossierFeux`). Le dossier remplace le plan du contrôleur en place,
qui garde son identifiant et ses nœuds ; l'opération est annulable. Un fichier qui rassemble plusieurs
dossiers est refusé et les énumère : rien ne dirait lequel décrit le carrefour choisi. Un fichier de
l'ancien format qui n'en contient qu'un reste lu tel quel.

Pourquoi ne pas reconnaître le carrefour tout seul ? Cela a été fait, puis retiré. Le rattachement par
comparaison des noms de voies échouait précisément là où il aurait servi : le plan de la commune et celui
d'OpenStreetMap ne découpent pas les carrefours de la même façon, un carrefour décalé y devient deux nœuds
distants d'une dizaine de mètres dont aucun ne réunit toutes les branches du dossier, et sur les six dossiers
de Veauche quatre finissaient de toute façon en arbitrage manuel. Autant demander le carrefour d'emblée : il
ne reste alors qu'à rattacher les **groupes** du dossier aux mouvements de ce carrefour-là (§14.3 bis).

### 14.1 Ce qui est repris et pourquoi

| Donnée du dossier | Dans le simulateur | Effet sur la circulation |
|---|---|---|
| Groupes `Vn` / `Pn` | `SignalGroup` | Unité commune aux phases, aux inter-verts et aux piétons |
| Phases (groupes verts, mini, maxi) | `SignalPhase` + `SignalPlan` | Capacité de chaque approche |
| Plans de feux et calendrier | `SignalPlan`, `PlanSchedule` | Comparer pointe du matin et heure creuse |
| Matrice d'inter-verts | `InterGreenMatrix`, `amberByGroup` | Temps perdu réel entre deux phases |
| Groupes piétons | `SignalGroup` de type `pieton` | Vert piéton qui interdit les mouvements sécants |
| Vert de rappel piéton | `SignalGroup.recall` | Vert à chaque cycle, contre une partie des cycles sur appel |
| Phase propre à un plan | `PlanPhaseTiming.skipped` | Cycle plus court dans les plans qui ne l'ouvrent pas |

### 14.2 Ce qui n'est pas repris, et pourquoi

Une grande partie du dossier décrit le matériel et l'exploitation, sans effet sur l'écoulement du trafic :
inventaire de l'armoire et de la voirie, raccordement et affectation des cartes, alimentation électrique et
consommation, dispositifs sonores pour malvoyants, contrôles réglementaires, historique des révisions,
identité du contrôleur. Ces données appartiennent à la gestion de patrimoine, pas à un simulateur ; les
reprendre alourdirait le format de projet sans changer un seul résultat.

Deux limites tiennent aux données elles-mêmes plutôt qu'à un choix : les diagrammes linéaires (l'ouverture
seconde par seconde de chaque groupe) ne figurent pas dans le JSON, et sur les dossiers de 2007 les noms de
voies rattachés aux groupes sont une reconstitution signalée par `source_voie`, à confirmer avant tout usage.

### 14.3 Inter-verts

Quand un contrôleur porte une matrice, la durée séparant deux phases n'est plus une constante mais dépend des
groupes concernés : pour la transition de la phase *i* à la phase *j*, on retient le maximum de
`interGreen[g][h]` sur les groupes `g` qui perdent le vert et `h` qui le prennent. La part de jaune vient de
`amberByGroup` du groupe véhicule qui perd le vert (un groupe piéton n'a pas de jaune), le reste est du rouge
intégral. Sans matrice, `amber` et `allRed` du contrôleur ou de la phase s'appliquent comme auparavant.

### 14.4 Plans horaires

`SimSettings.startTimeOfDayMin` et `dayOfWeek` donnent l'heure simulée à l'instant 0. Ce sont des réglages
**de la commune**, pas du carrefour : ils se règlent avec les autres réglages de simulation (onglet Trafic),
et le panneau Feux n'en montre que l'effet — le plan que le calendrier de chaque contrôleur désigne à cette
heure-là. À chaque cycle, le
contrôleur sélectionne le plan dont la plage horaire couvre l'heure courante ; le changement de plan
n'intervient qu'en fin de cycle, jamais au milieu d'une phase. Sans `schedule`, le premier plan s'applique en
permanence ; sans `plans`, les durées portées par les phases font foi.

### 14.3 bis Rattachement des groupes aux mouvements

Le carrefour étant désigné, il reste à savoir quels mouvements chaque groupe de feux commande. Le dossier
ne le dit que par un nom de voie (« Voiture Av. Libération (arrivée ouest) », « Traversée Rue de Jourcey ») :
ce nom est comparé à celui des tronçons du carrefour. La comparaison tolère les abréviations (Dr, St, Av,
Rte…), les apostrophes typographiques, les mots outils surnuméraires et un prénom intercalé, sans jamais
rapprocher deux voies réellement différentes.

Un groupe véhicule prend les mouvements qui **arrivent** par sa voie ; une traversée piétonne prend ceux qui
entrent ou sortent par la voie franchie (§14.5). Une voie que le dossier ne désigne que par sa référence
routière (« RD 1082 ») est résolue par le nom que le dossier lui donne lui-même ailleurs entre parenthèses ;
à défaut, le groupe reste sans mouvement.

**Deux groupes sur la même rue.** Un dossier nomme couramment deux approches d'une même voie « véhicules
venant du nord » et « … du sud » : comparés sur le seul nom de rue, les deux groupes commanderaient les
mêmes mouvements, et la phase qui n'ouvre que le nord ouvrirait aussi le sud — le carrefour simulé
écoulerait un trafic que le carrefour réel arrête. Quand chaque groupe cite un côté distinct (« venant du,
branche, côté, arrivée » suivi d'un point cardinal), les mouvements sont répartis d'après la géométrie :
chacun revient au groupe dont le côté est le plus proche de l'angle du tronçon **qui porte sa voie** — pour
une traversée piétonne, l'entrée comme la sortie comptent, un mouvement qui traverse le carrefour de part
en part franchissant bien les deux traversées. La répartition est annoncée comme une déduction à vérifier,
et abandonnée si elle laissait un groupe sans mouvement : ouvrir trop reste préférable à fermer à tort.
« direction nord » n'est pas un côté mais un sens de circulation (donc le côté opposé) : il est ignoré.

Un groupe qu'aucun mouvement ne porte est **signalé**, jamais rattaché au hasard : il ne commande rien, et
c'est le signe habituel qu'on a chargé le dossier d'un autre carrefour. Le bilan de l'import le dit en toutes
lettres, à côté des réserves de lecture du dossier.

### 14.4 bis Conventions et décisions de modélisation

Ces points ne sont dictés ni par le format ni par le document d'origine : ils sont tranchés ici.

- **Phase propre à un plan.** Une phase déclarée par le dossier comme appartenant à un seul plan est
  *fermée* dans les autres (`PlanPhaseTiming.skipped`). Elle n'y consomme ni vert ni inter-vert, et le
  contrôleur enchaîne directement sur la phase ouverte suivante. Sans cela, une sous-phase de pointe
  tournerait aussi en heure creuse et allongerait le cycle d'une phase que le dossier n'y ouvre pas.
  Un plan qui fermerait toutes ses phases est ignoré, pour ne pas laisser le carrefour au rouge.
- **Plage horaire de nuit.** Une plage qui franchit minuit appartient au jour de son début : « 22 h - 6 h
  du lundi au vendredi » couvre le samedi 1 h (suite de la nuit du vendredi) et pas le lundi 1 h.
- **Bascule de plan.** Le nouveau plan prend effet à la frontière de cycle et son décalage ne recale pas le
  cycle en cours : un contrôleur réel ne peut pas écourter une phase pour se réaligner. Une onde verte peut
  donc se décaler après une bascule, jusqu'au prochain calage.
- **Part de vert et saturation.** Le dénominateur de la saturation (§5.7) est la moyenne de la part de vert
  *pondérée par la durée d'application de chaque plan* sur la fenêtre mesurée, et non la part du plan en
  vigueur au démarrage.
- **Jaune de repli.** Quand une matrice existe sans colonne « jaune » exploitable, le jaune retombe sur
  `controller.amber`, plafonné à l'inter-vert ; sans ce repli l'inter-vert entier deviendrait du rouge
  intégral. Le jaune retenu ne considère que les groupes véhicules ayant effectivement une case vers un
  groupe qui prend le vert.
- **Dégagement d'une sous-phase piétonne.** Quand une traversée s'éteint alors que le groupe véhicule qui
  la portait reste vert, son rouge de dégagement s'applique quand même aux mouvements qui rouvrent. Sans
  cela le motif courant « phase B = V3 + P2 puis phase C = V3 » rouvrirait la traversée à la seconde
  suivante, sans aucun temps de dégagement.

### 14.5 Groupes piétons

Une traversée verte **en même temps** que le groupe véhicule de sa branche ne ferme pas les mouvements qui la
franchissent : elle les fait passer de « protégé » à « permis ». C'est le fonctionnement réel d'un carrefour
français, où le véhicule qui tourne a le vert et cède aux piétons. Les fermer serait pire que faux : sur le
dossier VE001 de Veauche, huit tourne-à-droite et tourne-à-gauche se retrouvaient au rouge permanent, donc
leur approche bloquée.

Un temps piéton **protégé**, où aucun groupe véhicule de la branche n'est vert, laisse ces mouvements au rouge
comme n'importe quelle phase qui ne les ouvre pas : rien de particulier à faire.

Limite assumée : le modèle de cession calcule les créneaux sur les flux **véhicules** en conflit, or le conflit
est ici piéton et aucun dossier ne porte de demande piétonne. La capacité d'un mouvement qui ne cède qu'à des
piétons est donc optimiste. `validateController` le signale carrefour par carrefour.

**Rappel et appel.** Une traversée en rappel (`SignalGroup.recall`) est desservie à chaque cycle. Une
traversée sur bouton poussoir ne l'est qu'une partie des cycles : faute de donnée de demande piétonne dans
les dossiers, le moteur tire à chaque cycle un Bernoulli de paramètre `DEFAULT_PEDESTRIAN_CALL_SHARE` (0,5
par défaut, soit une trentaine de piétons par heure pour un cycle de 80 s sous hypothèse d'arrivées de
Poisson). Le tirage est une fonction pure de la graine, du contrôleur, du groupe et du numéro de cycle,
donc reproductible. Les durées ne dépendent jamais du tirage : un dégagement n'est jamais raccourci et le
temps de cycle reste constant, ce qui est le choix sûr.
