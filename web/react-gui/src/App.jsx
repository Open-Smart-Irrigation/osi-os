import { useState, useEffect } from 'react'
import Dashboard from './components/Dashboard'
import { getAvailableSensors } from './services/dataService'

function App() {
  const [sensors, setSensors] = useState([])
  const [selectedSensor, setSelectedSensor] = useState(null)

  useEffect(() => {
    // Load available sensors
    const loadSensors = async () => {
      const availableSensors = await getAvailableSensors()
      setSensors(availableSensors)
      if (availableSensors.length > 0) {
        setSelectedSensor(availableSensors[0].id)
      }
    }
    loadSensors()
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1>Open Smart Irrigation</h1>
          <p className="subtitle">Real-time Monitoring System</p>
        </div>
      </header>
      <Dashboard
        sensors={sensors}
        selectedSensor={selectedSensor}
        onSensorChange={setSelectedSensor}
      />
    </div>
  )
}

export default App
