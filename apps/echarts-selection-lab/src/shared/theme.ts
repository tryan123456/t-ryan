/**
 * App chrome tokens and the light/dark switch.
 *
 * Canvas cannot read CSS custom properties, so the palette exists twice: here
 * as literals for the chart, and in `styles/tokens.css` for DOM chrome. Same
 * hexes, same roles. Dark is a separately stepped, separately validated set —
 * not an inversion.
 *
 * `ChartChrome` is the chart slice's own type: the app resolves its tokens into
 * the shape the slice asks for. That dependency runs host → slice only, which
 * is what keeps the slice portable.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChartChrome } from '../features/scatter-select-chart'

export type ThemeMode = 'light' | 'dark'

export const CHROME: Record<ThemeMode, ChartChrome> = {
  light: {
    surface: '#fcfcfb',
    textPrimary: '#0b0b0b',
    textSecondary: '#52514e',
    textMuted: '#898781',
    gridline: '#e1e0d9',
    axisLine: '#c3c2b7',
    tooltipBg: '#ffffff',
    brushFill: 'rgba(42,120,214,0.10)',
    brushBorder: '#2a78d6',
  },
  dark: {
    surface: '#1a1a19',
    textPrimary: '#ffffff',
    textSecondary: '#c3c2b7',
    textMuted: '#898781',
    gridline: '#2c2c2a',
    axisLine: '#383835',
    tooltipBg: '#232322',
    brushFill: 'rgba(57,135,229,0.16)',
    brushBorder: '#3987e5',
  },
}

const prefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

interface ThemeState {
  mode: ThemeMode
  toggle: () => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: prefersDark() ? 'dark' : 'light',
  toggle: () => set((state) => ({ mode: state.mode === 'dark' ? 'light' : 'dark' })),
}))

export const useThemeMode = () => useThemeStore((state) => state.mode)

export const useChartChrome = () => CHROME[useThemeMode()]

/** Keeps the DOM stamp in sync so CSS custom properties resolve. */
export function useThemeStamp() {
  const mode = useThemeMode()
  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])
}
