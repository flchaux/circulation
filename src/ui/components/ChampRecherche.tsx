/**
 * Champ de recherche compact posé au-dessus d'une liste ou d'un tableau.
 *
 * Il ne porte pas d'étiquette visible — la liste qu'il filtre est juste en dessous — mais un
 * `aria-label` explicite pour les lecteurs d'écran. La croix et la touche « Échap » vident la saisie.
 */
import type { JSX } from 'react'
import { S } from '@/ui/strings'

export interface ChampRechercheProps {
  value: string
  onChange(value: string): void
  /** Ce que la recherche filtre, au pluriel : « les tronçons », « les carrefours à feux ». */
  label: string
  testId?: string
}

export function ChampRecherche({ value, onChange, label, testId }: ChampRechercheProps): JSX.Element {
  return (
    <div className="recherche">
      <svg className="recherche-icone" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        className="recherche-champ"
        value={value}
        aria-label={`${S.recherche.rechercherDans} ${label}`}
        placeholder={S.recherche.placeholder}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
      />
      {value ? (
        <button type="button" className="recherche-vider" aria-label={S.recherche.vider} onClick={() => onChange('')}>
          ×
        </button>
      ) : null}
    </div>
  )
}
