import React, { createContext, useContext, useEffect, useState } from 'react'

// The layout now adapts purely to screen size — no manual override.
interface ViewModeContextValue {
  showSidebar: boolean
  showBottomNav: boolean
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null)

export function ViewModeProvider({ children }: { children: React.ReactNode }) {
  const [isDesktop, setIsDesktop] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  )

  useEffect(() => {
    const handler = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
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
