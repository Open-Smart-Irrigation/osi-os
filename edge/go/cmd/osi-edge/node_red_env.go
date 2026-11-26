package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"

	"osi-edge/internal/jsvalue"
)

// Node-RED's settings.js fills every still-missing or empty variable from
// /srv/node-red/.chirpstack.env before the flows start, except the gateway
// identity keys. Variables node-red.init does not export (the STREGA Gen2,
// LoRain and UC512 profile ids, CHIRPSTACK_API_URL, CHIRPSTACK_API_KEY)
// reach Node-RED only this way, so osi-edge reads the same file at start.
var nodeRedEnvProtected = map[string]bool{
	"DEVICE_EUI":                  true,
	"DEVICE_EUI_SOURCE":           true,
	"DEVICE_EUI_CONFIDENCE":       true,
	"DEVICE_EUI_LAST_VERIFIED_AT": true,
	"LINK_GATEWAY_DEVICE_EUI":     true,
}

func loadNodeRedEnvFile(path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		// settings.js does not catch a read failure: Node-RED does not start.
		return fmt.Errorf("read %s: %w", path, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := jsvalue.Trim(strings.TrimSuffix(line, "\r"))
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		equals := strings.IndexByte(trimmed, '=')
		if equals <= 0 {
			continue
		}
		key := jsvalue.Trim(trimmed[:equals])
		value := jsvalue.Trim(trimmed[equals+1:])
		// value.replace(/^['"]|['"]$/g, '')
		if value != "" && (value[0] == '\'' || value[0] == '"') {
			value = value[1:]
		}
		if value != "" && (value[len(value)-1] == '\'' || value[len(value)-1] == '"') {
			value = value[:len(value)-1]
		}
		if key == "" || nodeRedEnvProtected[key] || os.Getenv(key) != "" {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			log.Printf("[settings] %s: %v", key, err)
		}
	}
	return nil
}
