// Data service that interfaces with Node-RED REST API
// Configure API base URL - change this based on your environment
const API_BASE_URL = window.location.origin  // Uses same host as the React app
const USE_REAL_API = true  // Set to false to use dummy data for development

// Fallback dummy data for development when Node-RED is not available
const DUMMY_SENSORS = [
  { id: 'sensor-1', name: 'Garden Zone A', location: 'North Garden' },
  { id: 'sensor-2', name: 'Garden Zone B', location: 'South Garden' },
  { id: 'sensor-3', name: 'Greenhouse', location: 'Greenhouse 1' },
  { id: 'sensor-4', name: 'Lawn Area', location: 'Front Lawn' }
]

const generateHistoricalData = (hours = 24) => {
  const data = []
  const now = Date.now()
  for (let i = hours; i >= 0; i--) {
    const timestamp = now - (i * 60 * 60 * 1000)
    data.push({
      timestamp,
      time: new Date(timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      }),
      humidity: Math.floor(Math.random() * 30) + 40,
      flow: Math.random() * 15 + 5
    })
  }
  return data
}

const generateCurrentReading = () => ({
  humidity: Math.floor(Math.random() * 30) + 40,
  flow: Math.random() * 15 + 5,
  temperature: Math.floor(Math.random() * 15) + 15,
  valveStatus: Math.random() > 0.5 ? 'open' : 'closed',
  lastUpdate: new Date().toISOString()
})

// Helper function to handle API calls with fallback
const apiCall = async (url, fallbackData) => {
  if (!USE_REAL_API) {
    return fallbackData
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return await response.json()
  } catch (error) {
    console.warn(`API call failed for ${url}, using fallback data:`, error)
    return fallbackData
  }
}

// Get list of available sensors
export const getAvailableSensors = async () => {
  return apiCall(`${API_BASE_URL}/api/sensors`, DUMMY_SENSORS)
}

// Get current sensor data
export const getSensorData = async (sensorId) => {
  return apiCall(
    `${API_BASE_URL}/api/sensors/${sensorId}/current`,
    generateCurrentReading()
  )
}

// Get historical sensor data
export const getSensorHistory = async (sensorId, hours = 24) => {
  return apiCall(
    `${API_BASE_URL}/api/sensors/${sensorId}/history?hours=${hours}`,
    generateHistoricalData(hours)
  )
}

// Subscribe to real-time sensor updates
export const subscribeSensorUpdates = (sensorId, callback) => {
  // For now, poll the API every 5 seconds
  // TODO: Implement WebSocket for true real-time updates
  const interval = setInterval(async () => {
    try {
      const data = await getSensorData(sensorId)
      callback(data)
    } catch (error) {
      console.error('Error fetching sensor updates:', error)
    }
  }, 5000)

  return () => clearInterval(interval)
}
