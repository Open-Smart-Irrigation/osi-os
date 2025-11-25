import { useState, useEffect } from 'react'
import SensorSelector from './SensorSelector'
import MetricsGrid from './MetricsGrid'
import HumidityChart from './HumidityChart'
import FlowChart from './FlowChart'
import ApiStatus from './ApiStatus'
import { getSensorData, getSensorHistory, subscribeSensorUpdates } from '../services/dataService'

function Dashboard({ sensors, selectedSensor, onSensorChange }) {
  const [currentData, setCurrentData] = useState(null)
  const [historyData, setHistoryData] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!selectedSensor) return

    const loadData = async () => {
      setLoading(true)
      try {
        const [current, history] = await Promise.all([
          getSensorData(selectedSensor),
          getSensorHistory(selectedSensor, 24)
        ])
        setCurrentData(current)
        setHistoryData(history)
      } catch (error) {
        console.error('Error loading sensor data:', error)
      } finally {
        setLoading(false)
      }
    }

    loadData()

    // Subscribe to real-time updates
    const unsubscribe = subscribeSensorUpdates(selectedSensor, (data) => {
      setCurrentData(data)
    })

    return unsubscribe
  }, [selectedSensor])

  const selectedSensorData = sensors.find(s => s.id === selectedSensor)

  if (loading || !currentData) {
    return (
      <div className="dashboard">
        <div className="loading">Loading sensor data...</div>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <ApiStatus />

      <SensorSelector
        sensors={sensors}
        selectedSensor={selectedSensor}
        onSensorChange={onSensorChange}
      />

      <div className="sensor-info">
        <h2>{selectedSensorData?.name}</h2>
        <p className="location">{selectedSensorData?.location}</p>
      </div>

      <MetricsGrid currentData={currentData} />

      <div className="charts-grid">
        <div className="chart-card">
          <h3>Soil Humidity - Last 24 Hours</h3>
          <HumidityChart data={historyData} />
        </div>

        <div className="chart-card">
          <h3>Water Flow - Last 24 Hours</h3>
          <FlowChart data={historyData} />
        </div>
      </div>
    </div>
  )
}

export default Dashboard
