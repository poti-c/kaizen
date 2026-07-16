import React, { createContext, useContext, useEffect, useState } from 'react'

// The layout now adapts purely to screen size — no manual override.
interface ViewModeContextValue {
  showSidebar: boolean
  showBottomNav: boolean
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null)

// Read the current breakpoint. Prefer matchMedia — it reflects the *CSS* viewport width
// (the same px Tailwind breakpoints use) and stays correct even when innerWidth is briefly
// wrong. On old Android WebViews the viewport meta is applied a beat AFTER the first script
// runs, so a one-time innerWidth read at startup can wrongly latch the app to desktop.
function readIsDesktop(): boolean {
  if (typeof window === 'undefined') return true
  if (typeof window.matchMedia === 'function') return window.matchMedia('(min-width: 768px)').matches
  return window.innerWidth >= 768
}

export function ViewModeProvider({ children }: { children: React.ReactNode }) {
  const [isDesktop, setIsDesktop] = useState(readIsDesktop)

  useEffect(() => {
    const update = () => setIsDesktop(readIsDesktop())
    // Re-measure once on mount: corrects the startup latch on old Android once the
    // viewport has settled (the first render may have read a pre-viewport width).
    update()

    const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null
    if (mql) {
      // addEventListener('change') is unsupported on old Safari/Android WebView — fall back to addListener.
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', update)
      else if (typeof mql.addListener === 'function') mql.addListener(update)
    }
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      if (mql) {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', update)
        else if (typeof mql.removeListener === 'function') mql.removeListener(update)
      }
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  // Desktop (>=768px) → sidebar layout. Mobile → bottom nav.
  const showSidebar = isDesktop
  const showBottomNav = !isDesktop

  return (
    <ViewModeContext.Provider value={{ showSidebar, showBottomNav }}>
      {children}
    </ViewModeContext.Provider>
  )
}

export function useViewMode() {
  const ctx = useContext(ViewModeContext)
  if (!ctx) throw new Error('useViewMode must be used within ViewModeProvider')
  return ctx
}
