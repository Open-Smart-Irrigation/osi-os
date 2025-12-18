# Open Smart Irrigation - Setup Guide

Simple setup guide for the Open Smart Irrigation GUI with Node-RED authentication.

## Architecture

- **Frontend**: React app (lightweight, no backend dependencies)
- **Backend**: Node-RED flows (handles authentication, API endpoints, database)
- **Database**: SQLite (`farming.db`)

## Prerequisites

- Node-RED installed and running
- The `farming.db` file (included in this directory)

---

## Step 1: Deploy Database File

Copy `farming.db` to the Node-RED server:

```bash
# On the device running Node-RED (e.g., Raspberry Pi):
sudo mkdir -p /srv/osi
sudo cp farming.db /srv/osi/farming.db
sudo chmod 666 /srv/osi/farming.db
```

**Database location:** `/srv/osi/farming.db`

This file contains:
- `users` table (for authentication)
- `devices` table (registered sensors/valves)
- `device_data` table (sensor readings)

---

## Step 2: Deploy Node-RED Flows

Copy the flows file to Node-RED:

```bash
# The flows.json file location depends on your Node-RED setup:
# Option 1: OpenWRT/embedded systems
sudo cp /path/to/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json /usr/share/flows.json

# Option 2: Standard Node-RED installation
cp /path/to/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json ~/.node-red/flows.json
```

**What's included in flows.json:**
- Authentication endpoints (`POST /auth/login`, `POST /auth/register`)
- API endpoints for devices and sensor data
- Database integration with SQLite

---

## Step 3: Configure Node-RED

Edit your Node-RED settings (if needed):

```bash
# On OpenWRT/embedded
vi /etc/node-red/settings.js

# On standard installation
vi ~/.node-red/settings.js
```

Ensure HTTP node settings allow external access:

```javascript
module.exports = {
    // ... other settings ...

    uiPort: process.env.PORT || 1880,

    // Enable CORS for React GUI
    httpNodeCors: {
        origin: "*",
        methods: "GET,PUT,POST,DELETE"
    }
}
```

---

## Step 4: Restart Node-RED

```bash
# On OpenWRT/embedded
/etc/init.d/node-red restart

# On standard installation
# Stop: Ctrl+C
node-red
```

Node-RED will now have these endpoints available:
- `POST /auth/login` - User login
- `POST /auth/register` - User registration
- `GET /api/devices` - Get user's devices
- `POST /api/devices` - Add new device
- `GET /api/catalog` - Get device types
- `POST /api/valve/:deveui` - Control valve

---

## Step 5: Deploy React GUI

### Development Mode:

```bash
cd /path/to/osi-os/web/react-gui
npm install
npm run dev
```

Access at: `http://localhost:5173/gui/`

### Production Build:

```bash
npm run build
# Output is in dist/ directory
# Copy dist/ contents to your web server
```

---

## Step 6: Test Authentication

### Register a new user:

```bash
curl -X POST http://localhost:1880/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}'
```

**Response:** `{"success":true}`

### Login:

```bash
curl -X POST http://localhost:1880/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}'
```

**Response:** `{"token":"dGVzdHVzZXI6MTcwMzE4..."}`

The token is a simple base64-encoded string (not JWT). Store it in the frontend and send it in subsequent requests:

```bash
curl http://localhost:1880/api/devices \
  -H "Authorization: Bearer dGVzdHVzZXI6MTcwMzE4..."
```

---

## Database Schema

### users table
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,  -- Plain text (security not critical)
    created_at TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### devices table
```sql
CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deveui TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    current_state TEXT,
    target_state TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### device_data table
```sql
CREATE TABLE device_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deveui TEXT NOT NULL,
    swt_wm1 REAL,
    swt_wm2 REAL,
    light_lux REAL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (deveui) REFERENCES devices(deveui)
);
```

---

## File Locations Summary

| File | Development Path | Production Path |
|------|-----------------|----------------|
| `farming.db` | `/srv/osi/farming.db` | `/srv/osi/farming.db` |
| `flows.json` | `/usr/share/flows.json` or `~/.node-red/flows.json` | `/usr/share/flows.json` |
| React GUI build | `dist/` directory | Copy to web server |

---

## Authentication Flow

1. **User registers** → Password stored in plain text in `users.password_hash`
2. **User logs in** → Node-RED validates credentials → Returns simple token
3. **Token format**: `base64(username:timestamp)` (not validated on requests)
4. **Frontend stores token** in `localStorage`
5. **Frontend sends token** in `Authorization: Bearer <token>` header

**Note:** This is intentionally simple authentication without high security (as requested). For production, consider proper JWT tokens and password hashing.

---

## Troubleshooting

### "Database locked" error
```bash
# Check permissions
sudo chmod 666 /srv/osi/farming.db
sudo chown nodered:nodered /srv/osi/farming.db
```

### Node-RED flows not importing
1. Open Node-RED editor: `http://localhost:1880`
2. Menu → Import → Select `flows.json`
3. Click Deploy

### React GUI can't connect to Node-RED
- Check Node-RED is running on port 1880
- Check CORS is enabled in Node-RED settings
- Update `vite.config.js` proxy if Node-RED is on different host

### Login fails
```bash
# Check if user exists
sqlite3 /srv/osi/farming.db "SELECT * FROM users;"

# Check Node-RED debug tab for errors
```

---

## No Dependencies Required!

The frontend (`package.json`) has **no backend dependencies**:
- ✅ No `better-sqlite3`
- ✅ No `bcrypt`
- ✅ No `jsonwebtoken`
- ✅ No `express`

Everything is handled by Node-RED flows using native SQLite nodes.

---

## Next Steps

- Add real LoRaWAN devices via ChirpStack integration
- Connect sensor data to Node-RED flows (already in `flows.json`)
- Monitor soil moisture and control valves
- Build dashboards with historical data

Happy farming! 🌱
