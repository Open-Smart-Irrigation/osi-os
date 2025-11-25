import { useState, useEffect } from 'react'

function ApiStatus() {
  const [status, setStatus] = useState('checking')
  const [lastCheck, setLastCheck] = useState(null)

  useEffect(() => {
    const checkApi = async () => {
      try {
        const response = await fetch(`${window.location.origin}/api/sensors`)
        if (response.ok) {
          setStatus('connected')
        } else {
          setStatus('error')
        }
      } catch (error) {
        setStatus('offline')
      }
      setLastCheck(new Date())
    }

    checkApi()
    const interval = setInterval(checkApi, 10000) // Check every 10 seconds

    return () => clearInterval(interval)
  }, [])

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return '#10b981'
      case 'offline':
        return '#ef4444'
      case 'error':
        return '#f59e0b'
      default:
        return '#6b7280'
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'Node-RED API Connected'
      case 'offline':
        return 'Node-RED API Offline (Using fallback data)'
      case 'error':
        return 'API Error'
      default:
        return 'Checking...'
    }
  }

  return (
    <div className="api-status">
      <div className="api-status-indicator" style={{ backgroundColor: getStatusColor() }}></div>
      <span className="api-status-text">{getStatusText()}</span>
      {lastCheck && (
        <span className="api-status-time">
          Last check: {lastCheck.toLocaleTimeString()}
        </span>
      )}
    </div>
  )
}

export default ApiStatus
