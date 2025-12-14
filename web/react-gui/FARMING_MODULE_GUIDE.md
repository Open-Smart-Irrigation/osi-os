# Open Smart irrigation Module - Implementation Guide

## Overview
Your React application has been successfully extended with a Open Smart irrigation module. The implementation includes authentication, device management, and real-time monitoring for agricultural IoT devices.

## What Was Built

### 1. **Technology Stack**
- ✅ **TypeScript** - Full type safety for better development experience
- ✅ **Tailwind CSS v4** - Modern utility-first CSS framework
- ✅ **React Router** - Client-side routing
- ✅ **Axios** - HTTP client with interceptors for auth
- ✅ **SWR** - Data fetching with automatic revalidation every 10 seconds

### 2. **Project Structure**
```
src/
├── components/
│   ├── farming/
│   │   ├── KiwiSensorCard.tsx      # Soil sensor display
│   │   ├── StregaValveCard.tsx     # Valve control interface
│   │   └── AddDeviceModal.tsx      # Device registration modal
│   └── PrivateRoute.tsx            # Route protection
├── contexts/
│   └── AuthContext.tsx             # Authentication state management
├── pages/
│   ├── Login.tsx                   # Login page
│   ├── Register.tsx                # Registration page
│   └── FarmingDashboard.tsx        # Main dashboard
├── services/
│   └── api.ts                      # API service with axios
├── types/
│   └── farming.ts                  # TypeScript type definitions
├── App.tsx                         # Main app with routing
├── main.jsx                        # Entry point
└── index.css                       # Tailwind CSS imports
```

### 3. **Features Implemented**

#### Authentication System
- **Login Page** (`/login`)
  - Username/password form
  - Error handling
  - Redirects to dashboard on success
  - Link to registration page

- **Register Page** (`/register`)
  - Username/password/confirm password form
  - Password validation (min 6 characters)
  - Success confirmation
  - Auto-redirect to login after registration

#### Device Management Dashboard (`/dashboard`)
- **Auto-polling**: Fetches devices every 10 seconds using SWR
- **Grid Layout**: Responsive 1/2/3 column grid (mobile/tablet/desktop)
- **Device Cards**: Separate components for sensors and valves
- **Add Device**: Modal with type selection, name, and DevEUI validation

#### Kiwi Sensor Card
- Displays:
  - Soil Water Tension 1 & 2 (kPa)
  - Light intensity (lux)
  - Last seen timestamp
- **Dry Warning**: Red background + warning icon when SWT1 < 30 kPa
- Large, high-contrast text for easy reading

#### Strega Valve Card
- **Status Display**: Visual indicator (green = OPEN, gray = CLOSED)
- **Control Buttons**: Large OPEN/CLOSE buttons
- **Loading States**: Spinner animation during API calls
- **Error Handling**: Shows error messages
- **Last Seen**: Displays time since last update

## API Endpoints Required (Node-RED)

Your Node-RED backend needs to implement these endpoints:

### Authentication
```
POST /auth/login
Body: { username: string, password: string }
Response: { token: string }

POST /auth/register
Body: { username: password: string }
Response: { success: boolean }
```

### Devices
```
GET /api/devices
Response: Device[] (see types/farming.ts)

POST /api/devices
Body: { deveui: string, name: string, type_id: "KIWI_SENSOR" | "STREGA_VALVE" }
Response: Device

GET /api/catalog
Response: [{ id: "KIWI_SENSOR", name: "Kiwi Soil Sensor" }, { id: "STREGA_VALVE", name: "Strega Valve" }]

POST /api/valve/:deveui
Body: { action: "OPEN" | "CLOSE" }
Response: Success status
```

## Device Data Format

```typescript
{
  deveui: "0123456789ABCDEF",
  name: "North Field",
  type_id: "KIWI_SENSOR",
  last_seen: "2025-12-14T10:30:00Z",
  latest_data: {
    swt_wm1: 45.2,      // Soil Water Tension 1 (kPa)
    swt_wm2: 42.8,      // Soil Water Tension 2 (kPa)
    light_lux: 15000    // Light (lux)
  }
}
```

For valves, add:
```typescript
{
  current_state: "OPEN",  // Current valve state
  target_state: "OPEN"    // Desired valve state (may differ during transition)
}
```

## Running the Application

### Development
```bash
cd /Users/silvanimhof/IdeaProjects/osi-os/web/react-gui
npm run dev
```
Access at: `http://localhost:3000/gui/`

### Production Build
```bash
npm run build
```
Output: `dist/` directory

## Configuration

### Vite Proxy (vite.config.js)
The dev server proxies `/api` and `/auth` requests to `http://localhost:1880`.

### Base Path
The app is configured with base path `/gui/` to match your Node-RED setup.

### Authentication
- Tokens stored in `localStorage` as `auth_token`
- Axios interceptor automatically adds `Authorization: Bearer <token>` header
- 401 responses automatically redirect to login

## UI/UX Features for Farmers

### High Contrast Design
- Dark background (slate-900/slate-800)
- White text with text shadows
- Bright accent colors (green, red, blue, yellow)

### Large Touch Targets
- All interactive elements minimum 48x48px
- Large buttons and form inputs
- Touch-friendly spacing

### Simple Navigation
- Clear visual hierarchy
- Minimal steps to common actions
- Auto-refresh for real-time updates

### Visual Feedback
- Loading spinners during operations
- Color-coded status (green = good, red = warning)
- Clear error messages

## Next Steps

1. **Implement Node-RED Backend**
   - Create the required API endpoints
   - Set up authentication middleware
   - Connect to your LoRaWAN devices

2. **Test the Integration**
   - Start Node-RED on port 1880
   - Run the React dev server
   - Register a user and add devices

3. **Customize**
   - Adjust the "too dry" threshold (currently 30 kPa) in `KiwiSensorCard.tsx:12`
   - Modify polling interval (currently 10s) in `FarmingDashboard.tsx:19`
   - Add more device types by extending `DeviceType` in `types/farming.ts`

## Troubleshooting

### Build Issues
If you encounter build errors, ensure all dependencies are installed:
```bash
npm install
```

### Proxy Not Working
Verify Node-RED is running on port 1880 and check the Vite proxy config.

### Auth Redirect Loop
Clear localStorage: `localStorage.clear()` in browser console.

## Files You Can Modify

- **Colors**: `tailwind.config.js` - Update the custom color palette
- **Polling Interval**: `pages/FarmingDashboard.tsx` - Change `refreshInterval`
- **Dry Threshold**: `components/farming/KiwiSensorCard.tsx` - Adjust the `< 30` condition
- **DevEUI Validation**: `components/farming/AddDeviceModal.tsx` - Modify the regex pattern

---

**Built with attention to:**
- Farmers in developing countries (high contrast, large touch targets)
- Real-time data updates (10s polling)
- Simple, intuitive interface
- Mobile-first responsive design
