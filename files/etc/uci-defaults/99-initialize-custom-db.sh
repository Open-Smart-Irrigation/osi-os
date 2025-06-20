#!/bin/sh

# Path to the pre-placed empty database
CUSTOM_DB_SOURCE="/usr/share/sensor_data.db"

# Destination for the active database
CUSTOM_DB_DEST="/srv/sensor_data.db"

# SQL schema file
SCHEMA_FILE="/usr/share/schema.sql"

# Check if the database already exists
if [ ! -f "$CUSTOM_DB_DEST" ]; then
    echo "Initializing custom sensor database..."
    # Copy the empty database file
    cp "$CUSTOM_DB_SOURCE" "$CUSTOM_DB_DEST"

    # Initialize the database with the schema
    sqlite3 "$CUSTOM_DB_DEST" < "$SCHEMA_FILE"

    echo "Custom sensor database initialized."
else
    echo "Custom sensor database already exists."
fi

exit 0