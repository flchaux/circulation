/**
 * Champ numérique : saisie libre (virgule décimale acceptée), validation à la sortie du champ,
 * unité affichée et badge « estimée » pour les valeurs déduites en l'absence de tag OpenStreetMap.
 *
 * La valeur n'est propagée qu'une fois valide : pendant la frappe, le texte reste local, ce qui évite
 * qu'une saisie intermédiaire (« 1 », « », « 1,2 ») ne déclenche une action annulable dans le store.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { JSX } from 'react'
import { S } from '@/ui/strings'

export interface NumberFieldProps {
  label: string
  value: number
  onChange(v: number): void
  min?: number
  max?: number
  step?: number
  unit?: string
  estimated?: boolean
  disabled?: boolean
}

/** Représentation éditable d'un nombre (décimale française, pas de séparateur de milliers). */
function toText(value: number): string {
  if (!Number.isFinite(value)) return ''
  return String(Math.round(value * 1e6) / 1e6).replace('.', ',')
}

function parse(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!normalized) return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

export function NumberField(props: NumberFieldProps): JSX.Element {
  const { label, value, onChange, min, max, step, unit, estimated, disabled } = props
  const id = useId()
  const [text, setText] = useState(() => toText(value))
  const [invalid, setInvalid] = useState(false)
  const editing = useRef(false)

  // Une valeur modifiée ailleurs (annuler, chargement de projet) rafraîchit le champ au repos.
  useEffect(() => {
    if (!editing.current) setText(toText(value))
  }, [value])

  function clamp(v: number): number {
    let out = v
    if (min !== undefined) out = Math.max(min, out)
    if (max !== undefined) out = Math.min(max, out)
    return out
  }

  function commit(): void {
    const parsed = parse(text)
    if (parsed === null) {
      setInvalid(true)
      setText(toText(value))
      return
    }
    setInvalid(false)
    const next = clamp(parsed)
    setText(toText(next))
    if (next !== value) onChange(next)
  }

  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">
        {label}
        {estimated ? <span className="badge" title={S.reseau.estimeeAide}>{S.reseau.estimee}</span> : null}
      </span>
      <span className={`field-input${invalid ? ' invalid' : ''}`}>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onFocus={() => { editing.current = true }}
          onChange={(e) => { setText(e.target.value); setInvalid(false) }}
          onBlur={() => { editing.current = false; commit() }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.currentTarget.blur(); return }
            if (e.key === 'Escape') { setText(toText(value)); setInvalid(false); e.currentTarget.blur(); return }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            // Incrément clavier sur la valeur validée, sans quitter le champ.
            e.preventDefault()
            const base = parse(text) ?? value
            const next = clamp(Math.round((base + (e.key === 'ArrowUp' ? 1 : -1) * (step ?? 1)) * 1e6) / 1e6)
            setText(toText(next))
            if (next !== value) onChange(next)
          }}
        />
        {unit ? <span className="field-unit">{unit}</span> : null}
      </span>
    </label>
  )
}
