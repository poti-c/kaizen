import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import type { KaizenSettings } from '@/types'

const DEFAULT_SETTINGS: KaizenSettings = {
  primary_color: '#0891b2',
  accent_color: '#06b6d4',
  sidebar_color: '#1c2b3a',
  background_color: '#f9fafb',
}

interface ThemeContextValue {
  settings: KaizenSettings
  updateSettings: (updates: Partial<KaizenSettings>) => Promise<void>
  loading: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyTheme(settings: KaizenSettings) {
  const root = document.documentElement

  // Convert hex to RGB for Tailwind custom colors
  function hexToRgb(hex: string) {
    // Accept #abc shorthand as well as #aabbcc.
    const short = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex)
    const full = short
      ? `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
      : (/^#?([a-f\d]{6})$/i.exec(hex)?.[1] ?? null)
    if (!full) return { r: 30, g: 58, b: 95 }
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
  }

  function lighten(hex: string, amount: number) {
    const { r, g, b } = hexToRgb(hex)
    // Clamp to [0,255]: a negative amount (darken) must not produce a negative channel → "#-..".
    const ch = (c: number) => Math.max(0, Math.min(255, Math.round(c + (255 - c) * amount)))
    return `#${ch(r).toString(16).padStart(2, '0')}${ch(g).toString(16).padStart(2, '0')}${ch(b).toString(16).padStart(2, '0')}`
  }

  root.style.setProperty('--brand-primary', settings.primary_color)
  root.style.setProperty('--brand-accent', settings.accent_color)
  root.style.setProperty('--brand-sidebar', settings.sidebar_color)
  const bg = settings.background_color || '#f9fafb'
  root.style.setProperty('--brand-background', bg)

  // Dark "console" mode: when a preset uses a dark page background (e.g.
  // Cyberpunk), flip the app to a dark surface scheme — cards blend into the
  // background and are picked out by a gold border; primary text/nav go gold.
  const { r, g, b } = hexToRgb(bg)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  const dark = luminance < 0.4
  root.classList.toggle('theme-dark', dark)
  if (dark) {
    const GOLD = '#e3b341'  // logo-style gold
    root.style.setProperty('--brand-surface', lighten(bg, 0.05))        // card fill (slightly above bg)
    root.style.setProperty('--brand-surface-2', lighten(bg, 0.10))      // inputs / hover
    root.style.setProperty('--brand-card-border', 'rgba(227,179,65,0.55)')
    root.style.setProperty('--brand-border', 'rgba(227,179,65,0.18)')
    root.style.setProperty('--brand-text', '#e8edf3')
    root.style.setProperty('--brand-text-muted', '#9aa6b6')
    root.style.setProperty('--brand-gold', GOLD)
  }
  root.style.setProperty('--brand-50', lighten(settings.primary_color, 0.95))
  root.style.setProperty('--brand-100', lighten(settings.primary_color, 0.85))
  root.style.setProperty('--brand-200', lighten(settings.primary_color, 0.70))
  root.style.setProperty('--brand-500', settings.primary_color)
  root.style.setProperty('--brand-600', lighten(settings.primary_color, -0.1))
  root.style.setProperty('--brand-700', lighten(settings.primary_color, -0.2))
  root.style.setProperty('--brand-800', lighten(settings.primary_color, -0.3))
  root.style.setProperty('--brand-900', lighten(settings.primary_color, -0.4))
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeCompany } = useCompany()
  const [settings, setSettings] = useState<KaizenSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  const fetchSettings = useCallback(async (companyId: string | null) => {
    let query = supabase.from('kaizen_settings').select('key, value')
    if (companyId) query = query.eq('company_id', companyId)

    const { data } = await query

    if (data && data.length > 0) {
      const merged: Partial<KaizenSettings> = {}
      data.forEach((row: { key: string; value: unknown }) => {
        if (row.key in DEFAULT_SETTINGS) {
          (merged as Record<string, unknown>)[row.key] = row.value
        }
      })
      const final = { ...DEFAULT_SETTINGS, ...merged }
      setSettings(final)
      applyTheme(final)
    } else {
      applyTheme(DEFAULT_SETTINGS)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchSettings(activeCompany?.id ?? null)
  }, [fetchSettings, activeCompany?.id])

  async function updateSettings(updates: Partial<KaizenSettings>) {
    const newSettings = { ...settings, ...updates }
    setSettings(newSettings)
    applyTheme(newSettings)

    for (const [key, value] of Object.entries(updates)) {
      await supabase
        .from('kaizen_settings')
        .upsert(
          { key, value, company_id: activeCompany?.id ?? null },
          { onConflict: 'key,company_id' }
        )
    }
  }

  return (
    <ThemeContext.Provider value={{ settings, updateSettings, loading }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
