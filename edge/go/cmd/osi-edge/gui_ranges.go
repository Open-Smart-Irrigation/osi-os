package main

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

type guiSpan struct{ start, end int64 }

var guiRangeInteger = regexp.MustCompile(`^[+-]?[0-9]+`)

func guiRanges(value string, size int64) ([]guiSpan, bool) {
	value = strings.TrimLeft(value, " ")
	if !strings.HasPrefix(value, "bytes=") {
		return nil, false
	}
	var ranges []guiSpan
	for _, item := range strings.Split(value[len("bytes="):], ",") {
		first, rest, _ := strings.Cut(item, "-")
		last, _, _ := strings.Cut(rest, "-")
		start, startOK := guiRangeNumber(first)
		end, endOK := guiRangeNumber(last)
		switch {
		case !startOK:
			if !endOK {
				continue
			}
			start, end = size-end, size-1
		case !endOK:
			end = size - 1
		}
		end = min(end, size-1)
		if start >= 0 && end >= start {
			ranges = append(ranges, guiSpan{start, end})
		}
	}
	if len(ranges) == 0 {
		return nil, true
	}
	slices.SortFunc(ranges, func(a, b guiSpan) int {
		switch {
		case a.start < b.start:
			return -1
		case a.start > b.start:
			return 1
		default:
			return 0
		}
	})
	combined := ranges[:1]
	for _, span := range ranges[1:] {
		last := &combined[len(combined)-1]
		if span.start <= last.end+1 {
			last.end = max(last.end, span.end)
		} else {
			combined = append(combined, span)
		}
	}
	return combined, false
}

func guiRangeNumber(value string) (int64, bool) {
	token := guiRangeInteger.FindString(strings.TrimSpace(value))
	n, err := strconv.ParseInt(token, 10, 64)
	return n, token != "" && (err == nil || n > 0)
}
