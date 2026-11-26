package jstimezone

import (
	"strings"
	"time"
)

// Host is what the process zone detection reads from the system.
type Host struct {
	TZ      *string                           // the TZ environment variable; nil when unset
	Read    func(path string) ([]byte, error) // a system file, e.g. /etc/TZ
	Resolve func(path string) (string, error) // realpath(3)
}

// HostZone is the zone V8 gives a Node process on the gateway: V8 takes local
// time from ICU's default zone, which ICU 75.1 detects once, at process start
// (TimeZone::detectHostTimeZone and putil.cpp uprv_tzname/uprv_timezone),
// over OpenWrt's musl 1.2.5 (src/time/__tz.c with OpenWrt's
// 110-read_timezone_from_fs.patch). name is what
// Intl.DateTimeFormat().resolvedOptions().timeZone reports: the canonical
// form of the host ID, also for a fixed zone, or "" (JS undefined) when Intl
// does not know the ID.
//
// The steps, in ICU's order:
//  1. TZ, when set and Olson-shaped (isValidOlsonID, which an empty TZ passes),
//     is the ID; a leading ':' and a posix/ or right/ prefix are dropped.
//  2. Else the name after /zoneinfo/ in realpath(/etc/localtime).
//  3. Else libc's tzname[0], or the Olson ID that OFFSET_ZONE_MAPPINGS gives
//     for the tzname pair, the raw offset and the 2007 solstices' DST.
//
// The ID becomes the zone when ICU knows it, unless it is three or four
// characters long and its raw offset differs from libc's; otherwise ICU builds
// a fixed zone at libc's raw offset (no DST), or Etc/Unknown for an empty ID.
// Without U_TIMEZONE (musl) libc's raw offset is computed from mktime at
// start and moves by an hour when the start instant is in DST, so a CET rule
// in /etc/TZ gives Europe/Brussels to a Node started in winter and a fixed UTC
// zone (still reported as Europe/Brussels) to one started in DST. Measured
// with /etc/TZ in the guest: intl-gateway-winter.vectors.json (January
// start) and intl-gateway.vectors.json and intl-gateway-summer.vectors.json
// (April and July starts); intl-pi5.vectors.json has the board's TZ rows,
// started in November. Not modelled: ICU's search of
// /usr/share/zoneinfo for a copy of a non-symlinked /etc/localtime (the image
// ships no zoneinfo).
func HostZone(h Host, now time.Time) (loc *time.Location, name string) {
	libc := muslZone(h)
	id, fromTZ := "", false
	if h.TZ != nil && validOlsonID(*h.TZ) {
		id, fromTZ = strings.TrimPrefix(*h.TZ, ":"), true
		id = skipZoneIDPrefix(id)
	} else if tail, ok := localtimeLinkID(h); ok {
		id, fromTZ = tail, true
	}
	timezone := libc.timezone // seconds west, as uprv_timezone returns it
	if libc.loc != nil && isDST(libc.loc, now) {
		timezone += 3600
	}
	if !fromTZ {
		id = libc.std
		daylight := 0
		switch {
		case isDST(libc.loc, time.Unix(1198332540, 0)):
			daylight = 2
		case isDST(libc.loc, time.Unix(1182478260, 0)):
			daylight = 1
		}
		for _, m := range offsetZoneMappings {
			if m.offset == timezone && m.daylight == daylight && m.std == libc.std && m.dst == libc.dst {
				id = m.olson
				break
			}
		}
	}
	if id == "" {
		return time.FixedZone("Etc/Unknown", 0), "Etc/Unknown"
	}
	raw := -timezone
	if SystemID(id) {
		zone := Location(id)
		if !(len(id) >= 3 && len(id) <= 4 && rawOffset(zone, now) != raw) {
			return zone, Canonical(id)
		}
	}
	// A fixed zone keeps the host ID, which Intl still canonicalises: "CET"
	// reports Europe/Brussels while every Date offset is libc's raw offset.
	return time.FixedZone(id, raw), Canonical(id)
}

type libcZone struct {
	std, dst string
	timezone int            // seconds west of UTC, standard time
	loc      *time.Location // nil when libc runs in UTC with no rule
}

// muslZone is musl's do_tzset: TZ, or /etc/TZ when TZ is unset or empty
// (OpenWrt), or /etc/localtime; a name that is not a POSIX rule must be a
// zoneinfo file, and an unreadable one means UTC.
func muslZone(h Host) libcZone {
	var s string
	switch {
	case h.TZ != nil && *h.TZ != "":
		s = *h.TZ
	default:
		if data, err := h.Read("/etc/TZ"); err == nil {
			s = string(data)
		} else {
			s = "/etc/localtime"
		}
	}
	if s == "" {
		s = "UTC"
	}
	if !strings.HasPrefix(s, ":") {
		name, rest := muslName(s)
		if len(rest) < len(s) && (rest != "" && (rest[0] == '+' || rest[0] == '-' || rest[0] >= '0' && rest[0] <= '9') ||
			name == "UTC" || name == "GMT") {
			return muslRule(s)
		}
	}
	path := strings.TrimPrefix(s, ":")
	var data []byte
	var err error = errNoZone
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, ".") {
		data, err = h.Read(path)
	} else if !strings.Contains(path, ".") {
		for _, dir := range []string{"/usr/share/zoneinfo/", "/share/zoneinfo/", "/etc/zoneinfo/"} {
			if data, err = h.Read(dir + path); err == nil {
				break
			}
		}
	}
	if err != nil || len(data) < 44 || string(data[:4]) != "TZif" {
		return muslRule("UTC")
	}
	if data[len(data)-1] == '\n' {
		footer := string(data[:len(data)-1])
		return muslRule(footer[strings.LastIndexByte(footer, '\n')+1:])
	}
	loc, err := time.LoadLocationFromTZData("Local", data)
	if err != nil {
		return muslRule("UTC")
	}
	std, offset := time.Unix(0, 0).In(loc).Zone()
	return libcZone{std: std, dst: std, timezone: -offset, loc: loc}
}

type zoneError struct{}

func (zoneError) Error() string { return "no zoneinfo" }

var errNoZone error = zoneError{}

// muslName is musl's getname: <...> or a run of ASCII letters.
func muslName(s string) (name, rest string) {
	if strings.HasPrefix(s, "<") {
		end := strings.IndexByte(s, '>')
		if end < 0 {
			return s[1:], ""
		}
		return s[1:end], s[end+1:]
	}
	i := 0
	for i < len(s) && (s[i]|32) >= 'a' && (s[i]|32) <= 'z' {
		i++
	}
	return s[:i], s[i:]
}

// muslOffset is musl's getoff: [+-]h[:m[:s]] in seconds west.
func muslOffset(s string) (int, string) {
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	num := func() int {
		n := 0
		for s != "" && s[0] >= '0' && s[0] <= '9' {
			n = n*10 + int(s[0]-'0')
			s = s[1:]
		}
		return n
	}
	off := 3600 * num()
	if strings.HasPrefix(s, ":") {
		s = s[1:]
		off += 60 * num()
		if strings.HasPrefix(s, ":") {
			s = s[1:]
			off += num()
		}
	}
	if neg {
		off = -off
	}
	return off, s
}

func muslRule(s string) libcZone {
	std, rest := muslName(s)
	timezone, rest := muslOffset(rest)
	dst, _ := muslName(rest)
	z := libcZone{std: std, dst: dst, timezone: timezone}
	if dst == "" {
		z.dst = std
	}
	rule := strings.TrimRight(s, "\n")
	if loc, err := POSIX("Local", rule); err == nil {
		z.loc = loc
	} else {
		z.loc = time.FixedZone(std, -timezone)
	}
	return z
}

// validOlsonID is putil.cpp isValidOlsonID.
func validOlsonID(id string) bool {
	i := 0
	for i < len(id) && (id[i] < '0' || id[i] > '9') && id[i] != ',' {
		i++
	}
	for limit := i + 2; i < len(id) && id[i] >= '0' && id[i] <= '9' && i < limit; i++ {
	}
	return i == len(id) || id == "PST8PDT" || id == "MST7MDT" || id == "CST6CDT" || id == "EST5EDT"
}

func skipZoneIDPrefix(id string) string {
	if strings.HasPrefix(id, "posix/") || strings.HasPrefix(id, "right/") {
		return id[6:]
	}
	return id
}

// localtimeLinkID is ICU's CHECK_LOCALTIME_LINK step.
func localtimeLinkID(h Host) (string, bool) {
	if h.Resolve == nil {
		return "", false
	}
	real, err := h.Resolve("/etc/localtime")
	if err != nil || real == "/etc/localtime" {
		return "", false
	}
	_, tail, ok := strings.Cut(real, "/zoneinfo/")
	if !ok || tail == "posixrules" {
		return "", false
	}
	tail = skipZoneIDPrefix(tail)
	return tail, validOlsonID(tail)
}

func isDST(loc *time.Location, at time.Time) bool {
	return loc != nil && at.In(loc).IsDST()
}

// rawOffset is OlsonTimeZone::getRawOffset at now: the standard offset in
// seconds east.
func rawOffset(loc *time.Location, now time.Time) int {
	at := now
	for range 8 {
		local := at.In(loc)
		_, offset := local.Zone()
		if !local.IsDST() {
			return offset
		}
		start, _ := local.ZoneBounds()
		if start.IsZero() {
			return offset - 3600
		}
		at = start.Add(-time.Second)
	}
	_, offset := now.In(loc).Zone()
	return offset - 3600
}

// SystemID reports whether ICU's createSystemTimeZone knows the ID exactly
// (case-sensitive), as opposed to Canonical's case-insensitive Intl lookup.
func SystemID(id string) bool { return systemIDs[id] }

// The corpus adds a lower-cased copy of every name; ICU's own IDs all
// contain an upper-case letter.
var systemIDs = func() map[string]bool {
	ids := make(map[string]bool)
	for name := range nodeTimezoneNames {
		if strings.ContainsFunc(name, func(r rune) bool { return r >= 'A' && r <= 'Z' }) && Canonical(name) != "" {
			ids[name] = true
		}
	}
	return ids
}()

type offsetZoneMapping struct {
	offset, daylight int
	std, dst, olson  string
}

// OFFSET_ZONE_MAPPINGS of ICU 75.1 putil.cpp (offset in seconds west;
// daylight 0 none, 1 June, 2 December).
var offsetZoneMappings = []offsetZoneMapping{
	{-45900, 2, "CHAST", "CHADT", "Pacific/Chatham"},
	{-43200, 1, "PETT", "PETST", "Asia/Kamchatka"},
	{-43200, 2, "NZST", "NZDT", "Pacific/Auckland"},
	{-43200, 1, "ANAT", "ANAST", "Asia/Anadyr"},
	{-39600, 1, "MAGT", "MAGST", "Asia/Magadan"},
	{-37800, 2, "LHST", "LHST", "Australia/Lord_Howe"},
	{-36000, 2, "EST", "EST", "Australia/Sydney"},
	{-36000, 1, "SAKT", "SAKST", "Asia/Sakhalin"},
	{-36000, 1, "VLAT", "VLAST", "Asia/Vladivostok"},
	{-34200, 2, "CST", "CST", "Australia/South"},
	{-32400, 1, "YAKT", "YAKST", "Asia/Yakutsk"},
	{-32400, 1, "CHOT", "CHOST", "Asia/Choibalsan"},
	{-31500, 2, "CWST", "CWST", "Australia/Eucla"},
	{-28800, 1, "IRKT", "IRKST", "Asia/Irkutsk"},
	{-28800, 1, "ULAT", "ULAST", "Asia/Ulaanbaatar"},
	{-28800, 2, "WST", "WST", "Australia/West"},
	{-25200, 1, "HOVT", "HOVST", "Asia/Hovd"},
	{-25200, 1, "KRAT", "KRAST", "Asia/Krasnoyarsk"},
	{-21600, 1, "NOVT", "NOVST", "Asia/Novosibirsk"},
	{-21600, 1, "OMST", "OMSST", "Asia/Omsk"},
	{-18000, 1, "YEKT", "YEKST", "Asia/Yekaterinburg"},
	{-14400, 1, "SAMT", "SAMST", "Europe/Samara"},
	{-14400, 1, "AMT", "AMST", "Asia/Yerevan"},
	{-14400, 1, "AZT", "AZST", "Asia/Baku"},
	{-10800, 1, "AST", "ADT", "Asia/Baghdad"},
	{-10800, 1, "MSK", "MSD", "Europe/Moscow"},
	{-10800, 1, "VOLT", "VOLST", "Europe/Volgograd"},
	{-7200, 0, "EET", "CEST", "Africa/Tripoli"},
	{-7200, 1, "EET", "EEST", "Europe/Athens"},
	{-7200, 1, "IST", "IDT", "Asia/Jerusalem"},
	{-3600, 0, "CET", "WEST", "Africa/Algiers"},
	{-3600, 2, "WAT", "WAST", "Africa/Windhoek"},
	{0, 1, "GMT", "IST", "Europe/Dublin"},
	{0, 1, "GMT", "BST", "Europe/London"},
	{0, 0, "WET", "WEST", "Africa/Casablanca"},
	{0, 0, "WET", "WET", "Africa/El_Aaiun"},
	{3600, 1, "AZOT", "AZOST", "Atlantic/Azores"},
	{3600, 1, "EGT", "EGST", "America/Scoresbysund"},
	{10800, 1, "PMST", "PMDT", "America/Miquelon"},
	{10800, 2, "UYT", "UYST", "America/Montevideo"},
	{10800, 1, "WGT", "WGST", "America/Godthab"},
	{10800, 2, "BRT", "BRST", "Brazil/East"},
	{12600, 1, "NST", "NDT", "America/St_Johns"},
	{14400, 1, "AST", "ADT", "Canada/Atlantic"},
	{14400, 2, "AMT", "AMST", "America/Cuiaba"},
	{14400, 2, "CLT", "CLST", "Chile/Continental"},
	{14400, 2, "FKT", "FKST", "Atlantic/Stanley"},
	{14400, 2, "PYT", "PYST", "America/Asuncion"},
	{18000, 1, "CST", "CDT", "America/Havana"},
	{18000, 1, "EST", "EDT", "US/Eastern"},
	{21600, 2, "EAST", "EASST", "Chile/EasterIsland"},
	{21600, 0, "CST", "MDT", "Canada/Saskatchewan"},
	{21600, 0, "CST", "CDT", "America/Guatemala"},
	{21600, 1, "CST", "CDT", "US/Central"},
	{25200, 1, "MST", "MDT", "US/Mountain"},
	{28800, 0, "PST", "PST", "Pacific/Pitcairn"},
	{28800, 1, "PST", "PDT", "US/Pacific"},
	{32400, 1, "AKST", "AKDT", "US/Alaska"},
	{36000, 1, "HAST", "HADT", "US/Aleutian"},
}
