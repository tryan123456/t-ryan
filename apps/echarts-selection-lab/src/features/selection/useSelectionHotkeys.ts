/**
 * Keyboard selection commands.
 *
 * They operate on `orderedIds` — the rows currently visible in the table's
 * current sort — so "select all" never reaches rows the query excluded.
 *
 * One `useHotkeys` call registers the whole list, which keeps it valid to drive
 * the bindings from data. TanStack Hotkeys re-syncs callbacks every render, so
 * there is no dependency array here and no stale-closure hazard: the callbacks
 * always see the current `orderedIds`.
 */

import { useHotkeys } from '@tanstack/react-hotkeys'
import { useSelectionStore } from './store'
import { SELECTION_SHORTCUTS, type SelectionCommand } from './shortcuts'

export function useSelectionHotkeys(orderedIds: readonly string[]) {
  const run: Record<SelectionCommand, () => void> = {
    selectAll: () =>
      useSelectionStore
        .getState()
        .apply(orderedIds, 'replace', { anchorId: orderedIds[0] ?? null }),
    invert: () => useSelectionStore.getState().apply(orderedIds, 'toggle'),
    clear: () => useSelectionStore.getState().clear(),
  }

  useHotkeys(
    SELECTION_SHORTCUTS.map(({ hotkey, command }) => ({
      hotkey,
      callback: run[command],
    })),
    {
      preventDefault: true,
      // `ignoreInputs` otherwise defaults to false for Mod combos and Escape,
      // which would hijack Cmd+A and Esc while the user is typing in the search
      // box. Filter fields keep their native editing behaviour.
      ignoreInputs: true,
    },
  )
}
