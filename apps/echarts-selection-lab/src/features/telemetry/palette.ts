/**
 * Telemetry's own series colours — the slot assignment belongs to this feature,
 * not to the chart or to app chrome.
 *
 * Three categories, and that is a data-visualisation constraint rather than a
 * modelling one: a scatter puts every colour pair on screen at once, and the
 * reference palette only clears the all-pairs CVD floors for its first three
 * slots. Validated with `--pairs all`: light CVD ΔE 9.2 / normal-vision 24.0,
 * dark 9.4 / 20.9. Light-mode aqua sits at 2.74:1 against the surface, which
 * triggers the relief rule — hence direct labels on selected points and the
 * full table view.
 */

import type { ThemeMode } from '../../shared/theme'
import type { Category } from './types'

export const CATEGORY_COLOR: Record<ThemeMode, Record<Category, string>> = {
  light: {
    compute: '#2a78d6',
    storage: '#eb6834',
    network: '#1baf7a',
  },
  dark: {
    compute: '#3987e5',
    storage: '#d95926',
    network: '#199e70',
  },
}

/** The trend line is an annotation, not a fourth category — it wears ink. */
export const TREND_COLOR: Record<ThemeMode, string> = {
  light: '#52514e',
  dark: '#c3c2b7',
}

export const CATEGORY_LABEL: Record<Category, string> = {
  compute: 'Compute',
  storage: 'Storage',
  network: 'Network',
}
