# Node-RED Backend Setup for Open Smart Irrigation

This directory contains the backend dependencies and setup scripts for Node-RED. These are **separate from the React GUI** to keep concerns separated.

## Why This Directory Exists

The React GUI (frontend) and Node-RED (backend) have different dependencies:
- **React GUI**: axios, react, tailwind, etc. (no Node.js backend packages)
- **Node-RED**: better-sqlite3, bcrypt, jsonwebtoken (backend only)

This separation makes the project cleaner and easier to deploy.

## Quick Setup

### 1. Install Node-RED Dependencies

```bash
cd nodered-backend
npm install
```

This installs:
- `better-sqlite3` - SQLite database driver
- `bcrypt` - Password hashing
- `jsonwebtoken` - JWT authentication

### 2. Create Database

```bash
npm run setup
```

This creates `farming.db` in the parent directory with:
- User table
- Devices table
- Sample data (user: farmer/test123)

### 3. Configure Node-RED

Edit `~/.node-red/settings.js` and add to `functionGlobalContext`:

```javascript
functionGlobalContext: {
    // ... other settings ...
    ...require('/absolute/path/to/react-gui/nodered-backend/init.cjs')
}
```

**Replace `/absolute/path/to/react-gui/` with your actual path!**

### 4. Import Flows

1. Start Node-RED: `node-red`
2. Open http://localhost:1880
3. Menu → Import
4. Select `../node-red-flows.json`
5. Click **Deploy**

### 5. Start React GUI

```bash
cd ..
npm run dev
```

Access at http://localhost:3000/gui/

Login: `farmer` / `test123`

## Files in This Directory

- **`package.json`** - Node-RED backend dependencies
- **`init.cjs`** - Initializes database connection for Node-RED
- **`setup-database.cjs`** - Creates the database with sample data
- **`README.md`** - This file

## Database Location

The database file `farming.db` is created in the **parent directory** (`web/react-gui/`) so it's included in Jenkins builds and can be distributed with the GUI.

## Troubleshooting

### "Cannot find module 'better-sqlite3'"

Make sure you ran `npm install` in the `nodered-backend` directory, NOT in the parent directory.

### "Database connection failed"

Make sure the database exists:
```bash
cd nodered-backend
npm run setup
```

### Node-RED can't find the init script

Use an absolute path in settings.js, not a relative path.

## Production Notes

- Change the JWT_SECRET environment variable (default: 'your-secret-key-change-this')
- Use a stronger password than 'test123'
- The database is included in the osi-gui.zip artifact from Jenkins
