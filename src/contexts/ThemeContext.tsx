import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import type { KaizenSettings } from '@/types'

const DEFAULT_SETTINGS: KaizenSettings = {
  primary_color: '#0891b2',
  accent_color: '#06b6d4',
  sidebar_color: '#1c2b3a',
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
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : { r: 30, g: 58, b: 95 }
  }

  function lighten(hex: string, amount: number) {
    const { r, g, b } = hexToRgb(hex)
    const lighten = (c: number) => Math.min(255, Math.floor(c + (255 - c) * amount))
    return `#${lighten(r).toString(16).padStart(2, '0')}${lighten(g).toString(16).padStart(2, '0')}${lighten(b).toString(16).padStart(2, '0')}`
  }

  root.style.setProperty('--brand-primary', settings.primary_color)
  root.style.setProperty('--brand-accent', settings.accent_color)
  root.style.setProperty('--brand-sidebar', settings.sidebar_color)
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
