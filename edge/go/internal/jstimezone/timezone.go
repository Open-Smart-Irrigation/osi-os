// Package jstimezone resolves timezone names with the Node 20 ICU data.
package jstimezone

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"io/fs"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

//go:embed zones_iana.vectors.json
var nodeTimezoneVectors []byte

//go:embed zones_tzdata2024b.zip
var tzdata2024b []byte

var nodeZoneArchive = func() *zip.Reader {
	archive, err := zip.NewReader(bytes.NewReader(tzdata2024b), int64(len(tzdata2024b)))
	if err != nil {
		panic(err)
	}
	return archive
}()

type nodeTimezoneCorpus struct {
	Cases [][3]string
}

// nodeTimezones maps a lower-cased name to the canonical name Intl gives it;
// nodeTimezoneNames holds the corpus names as spelled.
var nodeTimezones, nodeTimezoneNames = func() (map[string]string, map[string]bool) {
	var corpus nodeTimezoneCorpus
	if err := json.Unmarshal(nodeTimezoneVectors, &corpus); err != nil {
		panic(err)
	}
	zones := make(map[string]string)
	names := make(map[string]bool)
	for _, entry := range corpus.Cases {
		names[entry[0]] = true
		if entry[1] != "" {
			zones[strings.ToLower(entry[0])] = entry[1]
		}
	}
	return zones, names
}()

// Canonical returns the name Intl accepts, or an empty string if rejected.
func Canonical(name string) string {
	// ICU's case-insensitive comparison is ASCII for named zones.
	for i := range len(name) {
		if name[i] >= 0x80 {
			return ""
		}
	}
	return nodeTimezones[strings.ToLower(name)]
}

var zoneLocations sync.Map

// Location loads the canonical timezone. Consumers which format restored data
// use UTC when the stored name is unknown.
func Location(name string) *time.Location {
	canonical := Canonical(name)
	if canonical == "" {
		return time.UTC
	}
	if cached, ok := zoneLocations.Load(canonical); ok {
		return cached.(*time.Location)
	}
	var location *time.Location
	var err error
	if strings.HasPrefix(canonical, "SystemV/") {
		location, err = systemVLocation(canonical)
	} else {
		// Use the gateway oracle's tzdata even on newer hosts.
		var data []byte
		data, err = fs.ReadFile(nodeZoneArchive, canonical)
		if err == nil {
			location, err = time.LoadLocationFromTZData(canonical, data)
		}
	}
	if err != nil {
		return time.UTC
	}
	zoneLocations.Store(canonical, location)
	return location
}

// ICU retains the SystemV zones that are absent from the IANA distribution.
func systemVLocation(canonical string) (*time.Location, error) {
	name := strings.TrimPrefix(canonical, "SystemV/")
	end := 3
	for end < len(name) && name[end] >= '0' && name[end] <= '9' {
		end++
	}
	if end == len(name) {
		hours, _ := strconv.Atoi(name[3:end])
		return time.FixedZone(canonical, -hours*3600), nil
	}
	return POSIX(canonical, name+",M4.5.0/2,M10.5.0/2")
}

// POSIX reads a process timezone rule, such as OpenWrt's /etc/TZ.
// A TZif v2 footer lets Go interpret the same rule without libc.
func POSIX(name, rule string) (*time.Location, error) {
	data := make([]byte, 0, 112+len(rule))
	for range 2 {
		var header [44]byte
		copy(header[:], "TZif2")
		binary.BigEndian.PutUint32(header[36:], 1)
		binary.BigEndian.PutUint32(header[40:], 4)
		data = append(data, header[:]...)
		data = append(data, 0, 0, 0, 0, 0, 0, 'U', 'T', 'C', 0)
	}
	data = append(data, '\n')
	data = append(data, rule...)
	data = append(data, '\n')
	return time.LoadLocationFromTZData(name, data)
}
