# Backend Setup Guide - Node-RED + SQLite

This guide walks you through setting up the complete backend for the Open Smart irrigation module.

## Prerequisites

You need Node.js and npm installed (which you already have for the React app).

---

## Step 1: Install Required npm Packages

Navigate to your Node-RED directory (or wherever you want to store the database):

```bash
cd /Users/silvanimhof/IdeaProjects/osi-os/web/react-gui
```

Install the required packages:

```bash
npm install better-sqlite3 bcrypt jsonwebtoken
```

**What these do:**
- `better-sqlite3` - Fast, synchronous SQLite database
- `bcrypt` - Secure password hashing
- `jsonwebtoken` - JWT token generation/verification

---

## Step 2: Create the Database

Run the setup script to create the SQLite database with all tables:

```bash
node setup-database.js
```

This will:
- ✅ Create `farming.db` with users, devices, and device_data tables
- ✅ Create indexes for performance
- ✅ Insert sample data (1 user, 2 devices, test readings)

**Sample credentials created:**
- Username: `farmer`
- Password: `test123`

---

## Step 3: Configure Node-RED

### Option A: Using settings.js (Recommended)

1. Find your Node-RED `settings.js` file:
   ```bash
   # Usually located at:
   ~/.node-red/settings.js
   ```

2. Add the initialization to `functionGlobalContext`:

   ```javascript
   functionGlobalContext: {
       // ... existing context items ...

       // Open Smart irrigation Database & Libraries
       database: require('better-sqlite3')('/Users/silvanimhof/IdeaProjects/osi-os/web/react-gui/farming.db'),
       bcrypt: require('bcrypt'),
       jwt: require('jsonwebtoken')
   }
   ```

   **⚠️ Important:** Update the database path to match where you created `farming.db`

### Option B: Using a separate init file

1. The `node-red-init.js` file is already created in this directory

2. In your `settings.js`, add:
   ```javascript
   functionGlobalContext: {
       ...require('/Users/silvanimhof/IdeaProjects/osi-os/web/react-gui/node-red-init.js')
   }
   ```

---

## Step 4: Set JWT Secret (Important for Security!)

Set an environment variable for the JWT secret:

### macOS/Linux:
```bash
export JWT_SECRET="your-very-secure-random-string-change-this"
```

### Or add to your shell profile (~/.zshrc or ~/.bashrc):
```bash
echo 'export JWT_SECRET="your-very-secure-random-string-change-this"' >> ~/.zshrc
source ~/.zshrc
```

### Windows (PowerShell):
```powershell
$env:JWT_SECRET="your-very-secure-random-string-change-this"
```

**⚠️ Generate a secure secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Step 5: Import Node-RED Flows

1. Open Node-RED editor: `http://localhost:1880`

2. Click the menu (☰) → Import

3. Select the `node-red-flows.json` file from this directory

4. Click Import

You should now see a new tab called "Open Smart irrigation API" with all the endpoints!

---

## Step 6: Deploy & Test

1. Click **Deploy** in Node-RED (top-right red button)

2. Verify the flows are working:
   ```bash
   # Test the catalog endpoint (no auth required)
   curl http://localhost:1880/api/catalog
   ```

   Should return:
   ```json
   [
     {"id":"KIWI_SENSOR","name":"Kiwi Soil Sensor"},
     {"id":"STREGA_VALVE","name":"Strega Smart Valve"}
   ]
   ```

3. Test login with sample user:
   ```bash
   curl -X POST http://localhost:1880/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"farmer","password":"test123"}'
   ```

   Should return:
   ```json
   {"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6..."}
   ```

---

## Step 7: Start Everything

### Terminal 1 - Node-RED:
```bash
node-red
```

### Terminal 2 - React App:
```bash
cd /Users/silvanimhof/IdeaProjects/osi-os/web/react-gui
npm run dev
```

### Open Browser:
```
http://localhost:3000/gui/
```

---

## Testing the Full Flow

1. **Login** with sample user:
   - Username: `farmer`
   - Password: `test123`

2. You should see:
   - 1 Kiwi Sensor (North Field Sensor)
   - 1 Strega Valve (Main Irrigation Valve)

3. **Try the valve controls:**
   - Click OPEN/CLOSE buttons
   - Status should update immediately

4. **Register a new user:**
   - Click "No account? Register here"
   - Create a new account
   - Login with new credentials
   - You should see an empty dashboard (no devices yet)

5. **Add a device:**
   - Click "Add Device"
   - Select type: Kiwi Soil Sensor
   - Name: "Test Field"
   - DevEUI: `1234567890ABCDEF`
   - Submit

---

## Database Schema

### users table
```sql
id              INTEGER PRIMARY KEY
username        TEXT UNIQUE NOT NULL
password_hash   TEXT NOT NULL
created_at      TEXT NOT NULL
updated_at      TEXT
```

### devices table
```sql
id              INTEGER PRIMARY KEY
deveui          TEXT UNIQUE NOT NULL
name            TEXT NOT NULL
type_id         TEXT NOT NULL (KIWI_SENSOR or STREGA_VALVE)
user_id         INTEGER NOT NULL (foreign key to users)
current_state   TEXT (OPEN or CLOSED, for valves)
target_state    TEXT (OPEN or CLOSED, for valves)
created_at      TEXT NOT NULL
updated_at      TEXT NOT NULL
```

### device_data table
```sql
id              INTEGER PRIMARY KEY
deveui          TEXT NOT NULL (foreign key to devices)
swt_wm1         REAL (Soil Water Tension 1)
swt_wm2         REAL (Soil Water Tension 2)
light_lux       REAL (Light intensity)
recorded_at     TEXT NOT NULL
```

---

## Adding Real LoRaWAN Device Data

To insert real sensor data from your LoRaWAN devices, add a Node-RED flow that:

1. Receives LoRaWAN uplink message
2. Parses the payload
3. Inserts into `device_data` table:

```javascript
const db = global.get('database');
const { deveui, swt_wm1, swt_wm2, light_lux } = msg.payload;

const query = `
    INSERT INTO device_data (deveui, swt_wm1, swt_wm2, light_lux, recorded_at)
    VALUES (?, ?, ?, ?, datetime('now'))
`;

db.prepare(query).run(deveui, swt_wm1, swt_wm2, light_lux);

// Also update the device's last_seen timestamp
db.prepare('UPDATE devices SET updated_at = datetime("now") WHERE deveui = ?').run(deveui);
```

---

## Troubleshooting

### "Cannot find module 'better-sqlite3'"
```bash
npm install better-sqlite3 bcrypt jsonwebtoken
```

### "Database not found"
- Run `setup-database.js` first
- Check the DB_PATH in your settings.js matches the actual file location

### "Invalid token" errors
- Make sure JWT_SECRET environment variable is set
- Restart Node-RED after setting the environment variable

### Devices not showing up
- Check that you're logged in with the correct user
- Devices are user-specific (user_id foreign key)
- Check Node-RED debug tab for errors

### Database locked errors
- Only one connection should write at a time
- Better-sqlite3 handles this automatically
- If issues persist, check for other processes accessing the .db file

---

## Security Considerations for Production

1. **Change the JWT secret** to a strong random string
2. **Use HTTPS** in production (not http)
3. **Enable CORS properly** if frontend is on different domain
4. **Add rate limiting** to prevent brute force attacks
5. **Use environment variables** for all secrets (not hardcoded)
6. **Regular backups** of farming.db
7. **Consider PostgreSQL** for production instead of SQLite

---

## Next Steps

- ✅ Backend API running
- ✅ Database with sample data
- ✅ React frontend connected

Now you can:
1. Connect real LoRaWAN devices
2. Add more device types
3. Build data visualization/charts
4. Add alerts/notifications
5. Export data to CSV

Enjoy your Open Smart irrigation system! 🌱
