import React from 'react'
import { reportError } from '@/lib/errorReporter'

interface State { hasError: boolean }

/** Catches React render errors, reports them to the Console, and shows a fallback. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    void reportError('react', error.message || 'React render error', {
      stack: error.stack?.slice(0, 2000),
      componentStack: info.componentStack?.slice(0, 2000),
    })
  }

  render() {
    if (this.state.hasError) {
      const th = localStorage.getItem('kaizen-lang') === 'th'
      return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-lg font-semibold">{th ? 'เกิดข้อผิดพลาด' : 'Something went wrong.'}</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            {th ? 'ระบบได้รายงานข้อผิดพลาดโดยอัตโนมัติแล้ว กรุณาโหลดหน้าใหม่เพื่อดำเนินการต่อ' : 'The error has been reported automatically. Please reload the page to continue.'}
          </p>
          <button
            onClick={() => location.reload()}
            className="mt-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-white text-sm font-medium transition-colors"
          >
            {th ? 'โหลดใหม่' : 'Reload'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
