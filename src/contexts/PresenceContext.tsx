import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from './AuthContext'

// Real-time online presence: each signed-in client joins a per-company channel
// and tracks itself by user id. Supabase Realtime removes a client the instant
// it disconnects (tab close, logout, network drop), so online/offline is live.
interface PresenceContextValue {
  onlineIds: Set<string>
  isOnline: (userId?: string | null) => boolean
}

const PresenceContext = createContext<PresenceContextValue>({
  onlineIds: new Set(),
  isOnline: () => false,
})

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const { user, profile } = useAuth()
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const companyId = profile?.company_id
    if (!user || !companyId) return

    const channel = supabase.channel(`presence:${companyId}`, {
      config: { presence: { key: user.id } },
    })

    channel
      .on('presence', { event: 'sync' }, () => {
        setOnlineIds(new Set(Object.keys(channel.presenceState())))
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track({ online_at: new Date().toISOString() })
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, profile?.company_id])

  const isOnline = (userId?: string | null) => !!userId && onlineIds.has(userId)

  return (
    <PresenceContext.Provider value={{ onlineIds, isOnline }}>
      {children}
    </PresenceContext.Provider>
  )
}

export function usePresence() {
  return useContext(PresenceContext)
}
