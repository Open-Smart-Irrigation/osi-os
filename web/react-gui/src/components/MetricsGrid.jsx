function MetricsGrid({ currentData }) {
  const formatFlow = (flow) => flow.toFixed(2)
  const formatHumidity = (humidity) => Math.round(humidity)

  return (
    <div className="metrics-grid">
      <div className="metric-card humidity">
        <div className="metric-icon">💧</div>
        <div className="metric-content">
          <div className="metric-label">Soil Humidity</div>
          <div className="metric-value">{formatHumidity(currentData.humidity)}%</div>
          <div className="metric-status">
            {currentData.humidity < 30 ? 'Low' : currentData.humidity > 60 ? 'Optimal' : 'Normal'}
          </div>
        </div>
      </div>

      <div className="metric-card flow">
        <div className="metric-icon">🚰</div>
        <div className="metric-content">
          <div className="metric-label">Water Flow</div>
          <div className="metric-value">{formatFlow(currentData.flow)} L/h</div>
          <div className="metric-status">
            {currentData.flow > 10 ? 'High Flow' : 'Normal Flow'}
          </div>
        </div>
      </div>

      <div className="metric-card temperature">
        <div className="metric-icon">🌡️</div>
        <div className="metric-content">
          <div className="metric-label">Temperature</div>
          <div className="metric-value">{Math.round(currentData.temperature)}°C</div>
          <div className="metric-status">
            {currentData.temperature < 20 ? 'Cool' : currentData.temperature > 25 ? 'Warm' : 'Normal'}
          </div>
        </div>
      </div>

      <div className="metric-card valve">
        <div className="metric-icon">⚙️</div>
        <div className="metric-content">
          <div className="metric-label">Valve Status</div>
          <div className="metric-value valve-status">
            <span className={`status-indicator ${currentData.valveStatus}`}></span>
            {currentData.valveStatus.toUpperCase()}
          </div>
          <div className="metric-status">
            Last updated: {new Date(currentData.lastUpdate).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  )
}

export default MetricsGrid
