/**
 * Readout and bulk actions for the shared selection.
 *
 * It reports two numbers on purpose. Selection is never silently pruned when
 * the query narrows — losing a careful selection because a filter moved is
 * worse than a number that needs explaining — so the bar makes the difference
 * between "selected" and "selected and currently visible" explicit.
 */

import { useMemo } from 'react'
import { useSelectionStore } from './store'
import { formatCount } from '../../shared/format'
import { SELECTION_SHORTCUTS, displayHotkey } from './shortcuts'

interface Props {
  orderedIds: readonly string[]
}

export function SelectionBar({ orderedIds }: Props) {
  const selectedIds = useSelectionStore((state) => state.ids)
  const apply = useSelectionStore((state) => state.apply)
  const clear = useSelectionStore((state) => state.clear)

  const visible = useMemo(
    () => orderedIds.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0),
    [orderedIds, selectedIds],
  )
  const offscreen = selectedIds.size - visible

  return (
    <div className="selection-bar">
      <p className="selection-bar__count" role="status">
        <strong>{formatCount(selectedIds.size)}</strong> selected
        {offscreen > 0 ? (
          <span className="selection-bar__muted">
            {' '}
            · {formatCount(offscreen)} outside the current query
          </span>
        ) : null}
      </p>

      <div className="selection-bar__actions">
        <button
          type="button"
          className="button"
          disabled={orderedIds.length === 0}
          onClick={() =>
            apply(orderedIds, 'replace', { anchorId: orderedIds[0] ?? null })
          }
        >
          Select all
        </button>
        <button
          type="button"
          className="button"
          disabled={orderedIds.length === 0}
          onClick={() => apply(orderedIds, 'toggle')}
        >
          Invert
        </button>
        <button
          type="button"
          className="button"
          disabled={selectedIds.size === 0}
          onClick={() => clear()}
        >
          Clear
        </button>
      </div>

      <p className="selection-bar__hint">
        Drag to marquee · <kbd>⇧</kbd>/<kbd>⌘</kbd> add · <kbd>⌥</kbd> subtract ·{' '}
        <kbd>⇧</kbd> range in table
        {SELECTION_SHORTCUTS.map(({ hotkey, label }) => (
          <span key={hotkey}>
            {' · '}
            <kbd>{displayHotkey(hotkey)}</kbd> {label}
          </span>
        ))}
      </p>
    </div>
  )
}
