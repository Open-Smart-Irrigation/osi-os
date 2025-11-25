# Open Smart Irrigation Dashboard

A modern React-based dashboard for monitoring smart irrigation systems with real-time soil humidity and water flow data.

## Features

- Real-time monitoring of soil humidity levels
- Water flow tracking from smart valves
- Interactive charts showing 24-hour historical data
- Multiple sensor support with easy switching
- Temperature monitoring
- Valve status indicators
- Responsive design for desktop and mobile
- Dark theme optimized for visibility

## Getting Started

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The application will be available at `http://localhost:3000`

### Production Build

```bash
npm run build
```

The production-ready files will be in the `dist` folder.

## Integration with Node-RED

The application is structured to easily integrate with Node-RED flows. Here's how to connect your real data:

### Data Service (src/services/dataService.js)

The data service has three main functions that currently use dummy data:

#### 1. Get Available Sensors

```javascript
export const getAvailableSensors = async () => {
  // Replace with your Node-RED endpoint
  const response = await fetch('/api/sensors')
  return response.json()
}
```

Expected response format:
```json
[
  {
    "id": "sensor-1",
    "name": "Garden Zone A",
    "location": "North Garden"
  }
]
```

#### 2. Get Current Sensor Data

```javascript
export const getSensorData = async (sensorId) => {
  // Replace with your Node-RED endpoint
  const response = await fetch(`/api/sensors/${sensorId}/current`)
  return response.json()
}
```

Expected response format:
```json
{
  "humidity": 55,
  "flow": 12.5,
  "temperature": 22,
  "valveStatus": "open",
  "lastUpdate": "2024-01-01T12:00:00Z"
}
```

#### 3. Get Historical Data

```javascript
export const getSensorHistory = async (sensorId, hours = 24) => {
  // Replace with your Node-RED endpoint
  const response = await fetch(`/api/sensors/${sensorId}/history?hours=${hours}`)
  return response.json()
}
```

Expected response format:
```json
[
  {
    "timestamp": 1234567890000,
    "time": "12:00",
    "humidity": 55,
    "flow": 12.5
  }
]
```

### WebSocket Support (Real-time Updates)

For real-time updates, uncomment and configure the WebSocket code in `subscribeSensorUpdates`:

```javascript
export const subscribeSensorUpdates = (sensorId, callback) => {
  const ws = new WebSocket(`ws://localhost:1880/sensor/${sensorId}`)

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data)
    callback(data)
  }

  ws.onerror = (error) => {
    console.error('WebSocket error:', error)
  }

  return () => ws.close()
}
```

### Node-RED Flow Example

Create HTTP endpoints in Node-RED:

1. **GET /api/sensors** - Returns list of available sensors
2. **GET /api/sensors/:id/current** - Returns current readings
3. **GET /api/sensors/:id/history** - Returns historical data
4. **WebSocket /sensor/:id** - (Optional) Real-time updates

### Example Node-RED HTTP Response Node

```javascript
// Current sensor data
msg.payload = {
  humidity: msg.payload.soilMoisture,
  flow: msg.payload.waterFlow,
  temperature: msg.payload.temp,
  valveStatus: msg.payload.valve ? 'open' : 'closed',
  lastUpdate: new Date().toISOString()
}
return msg;
```

## Project Structure

```
gui/
├── src/
│   ├── components/
│   │   ├── Dashboard.jsx       # Main dashboard container
│   │   ├── SensorSelector.jsx  # Sensor switching component
│   │   ├── MetricsGrid.jsx     # Current metrics display
│   │   ├── HumidityChart.jsx   # Humidity visualization
│   │   └── FlowChart.jsx       # Water flow visualization
│   ├── services/
│   │   └── dataService.js      # Data fetching service
│   ├── App.jsx                 # Root component
│   ├── App.css                 # Global styles
│   └── main.jsx                # Application entry point
├── package.json
├── vite.config.js
└── index.html
```

## Customization

### Changing Colors

Edit `src/App.css` to customize the color scheme. Main colors:
- Primary Blue: `#3b82f6`
- Success Green: `#10b981`
- Background Dark: `#0f172a`
- Card Background: `#1e293b`

### Adding New Metrics

1. Update the data service to include new fields
2. Add new metric cards in `MetricsGrid.jsx`
3. Create new chart components if needed

### Adjusting Data Refresh Rate

Change the interval in `subscribeSensorUpdates` (currently 5 seconds):

```javascript
const interval = setInterval(() => {
  callback(generateCurrentReading())
}, 5000) // Change this value (in milliseconds)
```

## Technologies Used

- React 18
- Vite
- Recharts (for charts and graphs)
- Modern CSS with responsive design

## License

MIT
