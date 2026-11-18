import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { HotelReportUpload } from '@/components/HotelReportUpload'
import { canUploadHotelReport } from '@/lib/hotelReports'

// Standalone home for the "Upload Hotel Report" card. Managers and super admins
// already get the card on the Dashboard; staff can't reach the Dashboard from the
// sidebar, so Front Office staff open it from their own sidebar item instead.
// The same canUploadHotelReport() gate as the Dashboard card (RLS enforces it).
export function HotelReportPage() {
  const { profile } = useAuth()
  if (!profile) return null
  if (!canUploadHotelReport(profile)) {
    return <Navigate to={profile.role === 'staff' ? '/cases' : '/dashboard'} replace />
  }
  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      <HotelReportUpload />
    </div>
  )
}
