// Package jsdate implements the date parsing and rendering used by Node 20.
package jsdate

import (
	"strings"
	"sync/atomic"
	"time"
)

var processZone atomic.Pointer[time.Location]

// SetProcessZone records the zone the process runs in, resolved once at start
// as V8 does. A nil location passed to Parse means this zone.
func SetProcessZone(loc *time.Location) { processZone.Store(loc) }

// ConfiguredProcessZone returns the zone set by SetProcessZone, or nil.
func ConfiguredProcessZone() *time.Location { return processZone.Load() }

// ProcessZone returns the configured process zone, or time.Local before one
// is set (unit tests).
func ProcessZone() *time.Location {
	if loc := processZone.Load(); loc != nil {
		return loc
	}
	return time.Local
}

// Parse matches V8 11.3 Date.parse. loc supplies the process timezone for
// date-times without an explicit offset; nil means ProcessZone. ISO
// date-only forms use UTC.
func Parse(raw string, loc *time.Location) (time.Time, bool) {
	if loc == nil {
		loc = ProcessZone()
	}
	tokens := scanDate(raw)
	date, count, iso := tokens.datePrefix()
	if iso {
		next := tokens.peek()
		switch {
		case next.kind == 0:
			return dateInstant(date, [4]int{}, time.UTC, 0)
		case next.word == "t":
			tokens.take()
			return tokens.isoTime(date, loc)
		}
	}
	return tokens.legacyDate(date, count, loc)
}

type dateToken struct {
	kind   rune
	number int
	width  int
	word   string
}

type dateTokens []dateToken

func scanDate(raw string) dateTokens {
	raw, _, _ = strings.Cut(raw, "\x00")
	chars := []rune(raw)
	var tokens dateTokens
	for i := 0; i < len(chars); {
		ch := chars[i]
		start := i
		i++
		switch {
		case ch >= '0' && ch <= '9':
			number, significant := int(ch-'0'), 0
			if number != 0 {
				significant++
			}
			for i < len(chars) && chars[i] >= '0' && chars[i] <= '9' {
				if significant < 9 {
					number = 10*number + int(chars[i]-'0')
					if number != 0 {
						significant++
					}
				}
				i++
			}
			tokens = append(tokens, dateToken{kind: 'n', number: number, width: i - start})
		case ch >= 'A' && !wordSpace(ch):
			for i < len(chars) && chars[i] >= 'A' && !wordSpace(chars[i]) {
				i++
			}
			// Only month names match by prefix. Lowercase ASCII only.
			word := chars[start:min(i, start+4)]
			for j, c := range word {
				if c >= 'A' && c <= 'Z' {
					word[j] = c + 'a' - 'A'
				}
			}
			tokens = append(tokens, dateToken{kind: 'w', word: string(word)})
		case strings.ContainsRune(":+-.)", ch):
			tokens = append(tokens, dateToken{kind: ch})
		case ch == '(':
			for depth := 1; i < len(chars) && depth > 0; i++ {
				switch chars[i] {
				case '(':
					depth++
				case ')':
					depth--
				}
			}
			tokens = append(tokens, dateToken{kind: '?'})
		case dateSpace(ch):
			tokens = append(tokens, dateToken{kind: 's'})
		default:
			tokens = append(tokens, dateToken{kind: '?'})
		}
	}
	return tokens
}

func wordSpace(ch rune) bool {
	// V8 scans legacy words before line terminators. Non-ASCII line
	// terminators therefore belong to the word, unlike a normal space.
	return ch != '\u2028' && ch != '\u2029' && dateSpace(ch)
}

func dateSpace(ch rune) bool {
	switch ch {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return ch >= '\u2000' && ch <= '\u200a'
}

func (s dateTokens) peek() dateToken {
	if len(s) == 0 {
		return dateToken{}
	}
	return s[0]
}

func (s *dateTokens) take() dateToken {
	token := s.peek()
	if len(*s) > 0 {
		*s = (*s)[1:]
	}
	return token
}

func (s *dateTokens) eat(kind rune) bool {
	if s.peek().kind != kind {
		return false
	}
	s.take()
	return true
}

func (s *dateTokens) datePrefix() ([3]int, int, bool) {
	date := [3]int{0, 1, 1}
	first := s.peek()
	switch {
	case first.kind == 'n' && first.width == 4:
		date[0] = s.take().number
	case first.kind == '+' || first.kind == '-':
		before := *s
		s.take()
		year := s.peek()
		if year.kind != 'n' || year.width != 6 {
			*s = before
			return date, 0, false
		}
		date[0] = s.take().number
		if first.kind == '-' {
			if date[0] == 0 {
				return date, 0, false
			}
			date[0] = -date[0]
		}
	default:
		return date, 0, false
	}
	for i, limit := range [...]int{12, 31} {
		if !s.eat('-') {
			return date, i + 1, true
		}
		next := s.peek()
		if next.kind != 'n' || next.width != 2 || next.number < 1 || next.number > limit {
			return date, i + 1, false
		}
		date[i+1] = s.take().number
	}
	return date, 3, true
}

func (s *dateTokens) fixedNumber(width, limit int) int {
	token := s.take()
	if token.kind == 'n' && token.width == width && token.number <= limit {
		return token.number
	}
	return -1
}

func (s *dateTokens) isoTime(date [3]int, loc *time.Location) (time.Time, bool) {
	clock := [4]int{}
	clock[0] = s.fixedNumber(2, 24)
	if clock[0] < 0 || !s.eat(':') {
		return time.Time{}, false
	}
	clock[1] = s.fixedNumber(2, 59)
	if s.eat(':') {
		clock[2] = s.fixedNumber(2, 59)
		if s.eat('.') {
			fraction := s.take()
			if fraction.kind != 'n' || (clock[0] == 24 && fraction.number != 0) {
				return time.Time{}, false
			}
			clock[3] = fraction.milliseconds()
		}
	}
	offset := 0
	next := s.peek()
	switch {
	case next.word == "z":
		s.take()
		loc = time.UTC
	case next.kind == '+' || next.kind == '-':
		s.take()
		var hour, minute int
		if s.peek().width == 4 && s.peek().kind == 'n' {
			n := s.take().number
			hour, minute = n/100, n%100
		} else {
			hour = s.fixedNumber(2, 23)
			if !s.eat(':') {
				return time.Time{}, false
			}
			minute = s.fixedNumber(2, 59)
		}
		if hour < 0 || hour > 23 || minute < 0 || minute > 59 {
			return time.Time{}, false
		}
		offset = (hour*60 + minute) * 60
		if next.kind == '-' {
			offset = -offset
		}
		loc = time.UTC
	}
	if s.peek().kind != 0 {
		return time.Time{}, false
	}
	return dateInstant(date, clock, loc, offset)
}

func (t dateToken) milliseconds() int {
	n, width := t.number, min(t.width, 9)
	for ; width > 3; width-- {
		n /= 10
	}
	for ; width < 3; width++ {
		n *= 10
	}
	return n
}

var legacyMonths = map[string]int{
	"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
	"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

var legacyZones = map[string]int{
	"ut": 0, "utc": 0, "z": 0, "gmt": 0, "cdt": -5, "cst": -6,
	"edt": -4, "est": -5, "mdt": -6, "mst": -7, "pdt": -7, "pst": -8,
}

func (s *dateTokens) legacyDate(date [3]int, dates int, loc *time.Location) (time.Time, bool) {
	var clock [4]int
	var times, namedMonth, sign, offsetHour, offsetMinute int
	hourOffset := -1
	hasNumber := dates != 0
	for token := s.take(); token.kind != 0; token = s.take() {
		next := s.peek()
		switch token.kind {
		case 'n':
			n := token.number
			hasNumber = true
			expectsTime := (times == 1 || times == 2) && n <= 59 || times == 3 && n <= 999
			switch {
			case s.eat(':'):
				if times == len(clock) {
					return time.Time{}, false
				}
				clock[times] = n
				times++
				if s.eat(':') {
					if times != 1 {
						return time.Time{}, false
					}
					times = 2
				} else {
					s.eat('.')
				}
			case s.eat('.') && expectsTime:
				clock[times] = n
				fraction := s.take()
				if fraction.kind != 'n' {
					return time.Time{}, false
				}
				if times < 3 {
					clock[times+1] = fraction.milliseconds()
				}
				times = len(clock)
			case sign != 0 && offsetMinute < 0 && n <= 59:
				offsetMinute = n
			case expectsTime:
				clock[times] = n
				times = len(clock)
				after := s.peek()
				if after.kind != 0 && after.kind != 's' && after.kind != '+' && after.kind != '-' && after.word != "z" {
					return time.Time{}, false
				}
			default:
				if dates == len(date) {
					return time.Time{}, false
				}
				date[dates] = n
				dates++
				s.eat('-')
			}
		case 'w':
			if (token.word == "am" || token.word == "pm") && times > 0 {
				hourOffset = 0
				if token.word == "pm" {
					hourOffset = 12
				}
			} else if month := legacyMonths[token.word[:min(3, len(token.word))]]; month != 0 {
				namedMonth = month
				s.eat('-')
			} else if hour, ok := legacyZones[token.word]; ok && hasNumber {
				sign, offsetHour, offsetMinute = 1, hour, 0
				if hour < 0 {
					sign, offsetHour = -1, -hour
				}
			} else if hasNumber || next.kind == 'n' {
				return time.Time{}, false
			}
		case '+', '-':
			if times == 0 && (sign == 0 || offsetHour != 0 || offsetMinute != 0) {
				if hasNumber {
					return time.Time{}, false
				}
				continue
			}
			sign = 1
			if token.kind == '-' {
				sign = -1
			}
			hasNumber = true
			var value dateToken
			if next.kind == 'n' {
				value = s.take()
			}
			switch {
			case s.peek().kind == ':':
				offsetHour, offsetMinute = value.number, -1
			case value.width == 1 || value.width == 2:
				offsetHour, offsetMinute = value.number, 0
			case value.width == 3 || value.width == 4:
				offsetHour, offsetMinute = value.number/100, value.number%100
			default:
				return time.Time{}, false
			}
		case ')':
			if hasNumber {
				return time.Time{}, false
			}
		}
	}
	if dates == 0 {
		return time.Time{}, false
	}
	if hourOffset >= 0 {
		if clock[0] > 12 {
			return time.Time{}, false
		}
		clock[0] = clock[0]%12 + hourOffset
	}

	firstIsDay := date[0] >= 1 && date[0] <= 31
	if namedMonth != 0 {
		year, day := date[0], date[1]
		if firstIsDay {
			year, day = day, year
		}
		date = [3]int{year, namedMonth, day}
	} else if firstIsDay {
		date = [3]int{date[2], date[0], date[1]}
	}
	if date[0] >= 0 && date[0] <= 99 {
		if date[0] < 50 {
			date[0] += 2000
		} else {
			date[0] += 1900
		}
	}
	offset := 0
	if sign != 0 {
		seconds := uint32(offsetHour)*3600 + uint32(max(offsetMinute, 0))*60
		if seconds > 1<<31-1 {
			return time.Time{}, false
		}
		offset = sign * int(seconds)
		loc = time.UTC
	}
	return dateInstant(date, clock, loc, offset)
}

func dateInstant(date [3]int, clock [4]int, loc *time.Location, offset int) (time.Time, bool) {
	year, month, day := date[0], date[1], date[2]
	hour, minute, second, millisecond := clock[0], clock[1], clock[2], clock[3]
	if year < -275900 || year > 275900 || month < 1 || month > 12 || day < 1 || day > 31 ||
		hour < 0 || hour > 24 || minute < 0 || minute > 59 || second < 0 || second > 59 ||
		millisecond > 999 || (hour == 24 && minute+second+millisecond != 0) {
		return time.Time{}, false
	}
	wall := time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), time.UTC)
	at := wall.Add(-time.Duration(offset) * time.Second)
	if loc != time.UTC {
		at = LocalWall(wall, loc)
	}
	if ms := at.UnixMilli(); ms < -maxMilliseconds || ms > maxMilliseconds {
		return time.Time{}, false
	}
	return at.UTC(), true
}
