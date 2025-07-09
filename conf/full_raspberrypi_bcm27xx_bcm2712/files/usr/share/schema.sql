-- =============================================================================
--  Enable Foreign Key support in SQLite
-- =============================================================================
PRAGMA foreign_keys = ON;

-- =============================================================================
--  Table: field_info
--  Stores information about the physical fields being monitored.
-- =============================================================================
CREATE TABLE field_info (
                            id INTEGER PRIMARY KEY,
                            name TEXT NOT NULL UNIQUE,
                            location TEXT,
                            area_sqm REAL, -- Area of the field in square meters
                            crop_type TEXT,
                            soil_type TEXT,
                            planted_on TEXT -- Stored as 'YYYY-MM-DD'
);

-- =============================================================================
--  Table: sensors
--  Registry of all sensors deployed in the fields.
-- =============================================================================
CREATE TABLE sensors (
                         id INTEGER PRIMARY KEY,
                         field_id INTEGER,
                         name TEXT NOT NULL UNIQUE,
                         type TEXT NOT NULL, -- e.g., KIWI_Watermark, Clover, DHT22
                         location TEXT,
                         depth_cm INTEGER,
                         installed_on TEXT NOT NULL, -- Stored as 'YYYY-MM-DD'
                         FOREIGN KEY (field_id) REFERENCES field_info (id) ON DELETE SET NULL
);

-- =============================================================================
--  Table: sensor_data
--  Stores all time-series data coming from the sensors.
-- =============================================================================
CREATE TABLE sensor_data (
                             id INTEGER PRIMARY KEY,
                             sensor_id INTEGER NOT NULL,
                             timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
                             swt_kpa REAL, -- Soil Water Tension in kPa
                             vwc_percent REAL, -- Volumetric Water Content in %
                             temperature_c REAL, -- Temperature in Celsius
                             humidity_percent REAL, -- Relative Humidity in %
                             light_lux REAL, -- Light intensity in lux
                             battery_voltage REAL,
                             battery_percent REAL,
                             FOREIGN KEY (sensor_id) REFERENCES sensors (id) ON DELETE CASCADE
);

-- =============================================================================
--  Table: actuators
--  Registry of all actuators (valves, switches, etc.).
-- =============================================================================
CREATE TABLE actuators (
                           id INTEGER PRIMARY KEY,
                           name TEXT NOT NULL UNIQUE,
                           type TEXT NOT NULL, -- e.g., STREGA valve, Relay Switch
                           location TEXT,
                           installed_on TEXT NOT NULL -- Stored as 'YYYY-MM-DD'
);

-- =============================================================================
--  Table: actuator_log
--  Logs every action taken by an actuator.
-- =============================================================================
CREATE TABLE actuator_log (
                              id INTEGER PRIMARY KEY,
                              actuator_id INTEGER NOT NULL,
                              timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
                              action TEXT NOT NULL, -- e.g., 'OPEN', 'CLOSE', 'PULSE'
                              duration_sec INTEGER, -- Duration of the action in seconds, if applicable
                              FOREIGN KEY (actuator_id) REFERENCES actuators (id) ON DELETE CASCADE
);

-- =============================================================================
--  Table: irrigation_zones
--  Defines specific irrigation zones, which can be linked to actuators.
-- =============================================================================
CREATE TABLE irrigation_zones (
                                  id INTEGER PRIMARY KEY,
                                  actuator_id INTEGER, -- The primary valve/actuator for this zone
                                  name TEXT NOT NULL UNIQUE,
                                  description TEXT,
                                  FOREIGN KEY (actuator_id) REFERENCES actuators (id) ON DELETE SET NULL
);

-- =============================================================================
--  Table: irrigation_schedule
--  Stores the rules for when and how to irrigate a zone.
-- =============================================================================
CREATE TABLE irrigation_schedule (
                                     id INTEGER PRIMARY KEY,
                                     zone_id INTEGER NOT NULL,
                                     is_active INTEGER NOT NULL DEFAULT 1, -- Use 1 for true, 0 for false
                                     start_time TEXT NOT NULL, -- Time of day, e.g., '22:00'
                                     duration_min INTEGER NOT NULL,
                                     mode TEXT NOT NULL DEFAULT 'automatic', -- 'manual' or 'automatic'
                                     trigger_source TEXT, -- e.g., 'time', 'swt_threshold', 'vwc_threshold'
                                     trigger_swt_kpa REAL, -- Threshold for SWT sensors
                                     trigger_vwc_percent REAL, -- Threshold for VWC sensors
                                     FOREIGN KEY (zone_id) REFERENCES irrigation_zones (id) ON DELETE CASCADE
);

-- =============================================================================
--  Table: irrigation_events
--  A log of every time an irrigation cycle has run.
-- =============================================================================
CREATE TABLE irrigation_events (
                                   id INTEGER PRIMARY KEY,
                                   zone_id INTEGER NOT NULL,
                                   schedule_id INTEGER, -- Optional: link to the schedule that triggered it
                                   start_time TEXT NOT NULL,
                                   end_time TEXT NOT NULL,
                                   app_rate_mm_hr REAL, -- Application rate in mm/hour
                                   irr_volume_l REAL, -- Estimated water volume in Liters
                                   trigger_reason TEXT, -- e.g., 'Scheduled run', 'Manual activation', 'SWT below 30kPa'
                                   FOREIGN KEY (zone_id) REFERENCES irrigation_zones (id) ON DELETE CASCADE,
                                   FOREIGN KEY (schedule_id) REFERENCES irrigation_schedule (id) ON DELETE SET NULL
);

-- =============================================================================
--  Table: system_logs
--  For logging general system information, warnings, and errors.
-- =============================================================================
CREATE TABLE system_logs (
                             id INTEGER PRIMARY KEY,
                             timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
                             severity TEXT NOT NULL, -- 'INFO', 'WARNING', 'ERROR', 'CRITICAL'
                             component TEXT NOT NULL, -- e.g., 'database', 'lora_parser', 'scheduler'
                             message TEXT NOT NULL
);


-- =============================================================================
--  INDEXES FOR PERFORMANCE
--  Create indexes on all foreign key columns for faster joins and lookups.
-- =============================================================================
CREATE INDEX idx_sensor_data_sensor_id ON sensor_data (sensor_id);
CREATE INDEX idx_sensor_data_timestamp ON sensor_data (timestamp);
CREATE INDEX idx_actuator_log_actuator_id ON actuator_log (actuator_id);
CREATE INDEX idx_irrigation_zones_actuator_id ON irrigation_zones (actuator_id);
CREATE INDEX idx_irrigation_schedule_zone_id ON irrigation_schedule (zone_id);
CREATE INDEX idx_irrigation_events_zone_id ON irrigation_events (zone_id);
CREATE INDEX idx_system_logs_timestamp ON system_logs (timestamp);
CREATE INDEX idx_system_logs_severity ON system_logs (severity);