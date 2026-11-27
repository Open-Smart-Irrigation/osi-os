package main

import (
	"encoding/json"
	"errors"
	"os"
)

const cloudBrokerNodeID = "ec43625ea99685a6"

type cloudCredentials struct {
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
}

type cloudConnect struct {
	ClientID string `json:"clientid"`
	cloudCredentials
}

func resolveCloudConnect(eui, password string) (cloudConnect, error) {
	file := imagePath("/data/db/osi-edge-cloud-connect.json")
	nodeRed, err := readNodeRedCloudConnect()
	if err != nil {
		return cloudConnect{}, err
	}
	state := cloudConnectState{cloudConnect: nodeRed}
	data, err := os.ReadFile(file)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return cloudConnect{}, err
	default:
		state = cloudConnectState{}
		if json.Unmarshal(data, &state) != nil || state.ClientID == "" {
			return cloudConnect{}, errors.New("invalid edge cloud CONNECT state")
		}
	}

	previous := state.cloudConnect
	if len(data) != 0 {
		baseline := state.NodeRed
		// Older Go stores have no snapshot. Bootstrap their ordering using
		// the target files' timestamps, independently for each write guard.
		if baseline == nil {
			baseline, err = legacyCloudBaseline(file, previous, nodeRed)
			if err != nil {
				return cloudConnect{}, err
			}
		}
		// A change in either Node-RED value supersedes only that part of
		// the Go store. Unrelated flow and credential edits have no effect.
		if nodeRed.ClientID != baseline.ClientID {
			previous.ClientID = nodeRed.ClientID
		}
		if nodeRed.cloudCredentials != baseline.cloudCredentials {
			previous.cloudCredentials = nodeRed.cloudCredentials
		}
	}

	next := previous
	if eui != "" {
		next.ClientID = "device_" + eui
	}
	if eui != "" && password != "" {
		next.cloudCredentials = cloudCredentials{User: eui, Password: password}
	}
	if state.NodeRed == nil || *state.NodeRed != nodeRed || next != state.cloudConnect {
		data, err := json.Marshal(cloudConnectState{cloudConnect: next, NodeRed: &nodeRed})
		if err != nil {
			return cloudConnect{}, err
		}
		if err := writePrivateFile(file, data); err != nil {
			return cloudConnect{}, err
		}
	}
	return next, nil
}

type cloudConnectState struct {
	cloudConnect
	NodeRed *cloudConnect `json:"nodeRed"`
}

func legacyCloudBaseline(file string, previous, nodeRed cloudConnect) (*cloudConnect, error) {
	store, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	baseline := nodeRed
	for _, path := range []string{"/srv/node-red/flows.json", "/srv/node-red/flows_cred.json"} {
		info, err := os.Stat(imagePath(path))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if info.ModTime().After(store.ModTime()) {
			if path == "/srv/node-red/flows.json" {
				baseline.ClientID = previous.ClientID
			} else {
				baseline.cloudCredentials = previous.cloudCredentials
			}
		}
	}
	return &baseline, nil
}

func readNodeRedCloudConnect() (cloudConnect, error) {
	connect := cloudConnect{ClientID: "device_${DEVICE_EUI}"}
	var flows []struct {
		ID       string `json:"id"`
		ClientID string `json:"clientid"`
	}
	data, err := readOptionalCloudFile("/srv/node-red/flows.json")
	if err != nil {
		return cloudConnect{}, err
	}
	if json.Unmarshal(data, &flows) == nil {
		for _, node := range flows {
			if node.ID == cloudBrokerNodeID && node.ClientID != "" {
				connect.ClientID = node.ClientID
				break
			}
		}
	}
	data, err = readOptionalCloudFile("/srv/node-red/flows_cred.json")
	if err != nil {
		return cloudConnect{}, err
	}
	var credentials map[string]cloudCredentials
	if json.Unmarshal(data, &credentials) == nil {
		connect.cloudCredentials = credentials[cloudBrokerNodeID]
	}
	return connect, nil
}

func readOptionalCloudFile(path string) ([]byte, error) {
	data, err := os.ReadFile(imagePath(path))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}
