/**
 * The keyboard shortcuts, declared once as data.
 *
 * `useSelectionHotkeys` registers from this list and `SelectionBar` renders its
 * hint from the same list, so a binding and its on-screen label cannot drift
 * apart. Display strings come from `formatForDisplay`, which resolves `Mod` to
 * ⌘ or Ctrl per platform — previously those symbols were hardcoded and wrong
 * on Windows.
 */

import { formatForDisplay, type Hotkey } from '@tanstack/react-hotkeys'

export type SelectionCommand = 'selectAll' | 'invert' | 'clear'

export interface ShortcutSpec {
  command: SelectionCommand
  hotkey: Hotkey
  label: string
}

export const SELECTION_SHORTCUTS: readonly ShortcutSpec[] = [
  { command: 'selectAll', hotkey: 'Mod+A', label: 'select all' },
  { command: 'invert', hotkey: 'Mod+I', label: 'invert' },
  { command: 'clear', hotkey: 'Escape', label: 'clear' },
]

export const displayHotkey = (hotkey: Hotkey) => formatForDisplay(hotkey)
