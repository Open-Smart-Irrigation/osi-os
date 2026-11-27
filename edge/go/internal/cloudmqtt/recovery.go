package cloudmqtt

import (
	"fmt"
	"log"
	"os"
	"regexp"

	"osi-edge/internal/jsvalue"
)

var accountRestartRequest = regexp.MustCompile(`^account_(link|unlink)-.+\.json$`)

func recoveryBlocked(imagePath func(string) string) (bool, error) {
	// Read in handoff order. The request precedes journal removal and the
	// identity daemon writes its sentinel before consuming the request.
	_, err := os.Stat(imagePath("/data/db/osi-account-link-config.json"))
	if err == nil {
		return true, nil
	}
	if !os.IsNotExist(err) {
		return true, fmt.Errorf("inspect cloud account recovery journal: %w", err)
	}
	requests, err := os.ReadDir(imagePath("/var/run/osi-node-red-restart-requests"))
	if err != nil && !os.IsNotExist(err) {
		return true, fmt.Errorf("read cloud account restart requests: %w", err)
	}
	for _, request := range requests {
		if accountRestartRequest.MatchString(request.Name()) {
			return true, nil
		}
	}
	sentinel, err := os.ReadFile(imagePath("/var/run/osi-identity-restart.json"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("read cloud identity restart sentinel: %w", err)
	}
	if _, err := jsvalue.Parse(sentinel); err != nil {
		log.Print("cloud MQTT: identity restart state is unreadable")
	}
	return true, nil
}
