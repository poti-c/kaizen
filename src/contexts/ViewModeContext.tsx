import React, { createContext, useContext, useEffect, useState } from 'react'

// auto  = adapt to screen size (default)
// desktop = force sidebar layout even on small screens
// mobile  = force bottom-nav layout even on large screens
type ViewMode = 'auto' | 'desktop' | 'mobile'

interface ViewModeContextValue {
  viewMode: ViewMode
  toggleViewMode: () => void
  showSidebar: boolean
  showBottomNav: boolean
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null)

export function ViewModeProvider({ children }: { children: React.ReactNode }) {
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem('kaizen-view') as ViewMode) || 'auto'
  )
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 768)

  useEffect(() => {
    const handler = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  function toggleViewMode() {
    let next: ViewMode
    if (viewMode === 'auto') {
      // From auto: flip to the opposite of what the current screen naturally shows
      next = isDesktop ? 'mobile' : 'desktop'
    } else {
      // From a forced mode: return to auto
      next = 'auto'
    }
    setViewMode(next)
    localStorage.setItem('kaizen-view', next)
  }

  const showSidebar = viewMode === 'desktop' || (viewMode === 'auto' && isDesktop)
  const showBottomNav = viewMode === 'mobile' || (viewMode === 'auto' && !isDesktop)

  return (
    <ViewModeContext.Provider value={{ viewMode, toggleViewMode, showSidebar, showBottomNav }}>
      {children}
    </ViewModeContext.Provider>
  )
}

export function useViewMode() {
  const ctx = useContext(ViewModeContext)
  if (!ctx) throw new Error('useViewMode must be used within ViewModeProvider')
  return ctx
}
