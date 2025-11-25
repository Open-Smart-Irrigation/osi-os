function SensorSelector({ sensors, selectedSensor, onSensorChange }) {
  return (
    <div className="sensor-selector">
      <label htmlFor="sensor-select">Select Sensor:</label>
      <select
        id="sensor-select"
        value={selectedSensor || ''}
        onChange={(e) => onSensorChange(e.target.value)}
        className="sensor-select"
      >
        {sensors.map((sensor) => (
          <option key={sensor.id} value={sensor.id}>
            {sensor.name} - {sensor.location}
          </option>
        ))}
      </select>
    </div>
  )
}

export default SensorSelector
