package httpbody

import (
	"cmp"
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"osi-edge/internal/jsvalue"
)

var (
	formBrackets = strings.NewReplacer("%5b", "[", "%5B", "[", "%5d", "]", "%5D", "]")
	formChild    = regexp.MustCompile(`\[[^\[\]]*\]`)
)

// Extended body-parser uses qs twice: it combines duplicate decoded names,
// then builds and merges their bracket paths in JavaScript key order.
// ParseQuery parses a URL query string the way Express's default "extended"
// query parser (qs) does, as req.query: arrays for key[]=, objects for key[a]=.
func ParseQuery(raw string) jsvalue.Value {
	v, err := parseFormWith(raw, queryLimits)
	if err != nil {
		return jsvalue.Obj()
	}
	return v
}

// formLimits: body-parser's urlencoded(extended) refuses too many parameters
// or too deep brackets and sizes arrayLimit from the parameter count; Express's
// query parser calls qs.parse with its defaults (arrayLimit 20, depth 5,
// parameterLimit 1000), which keeps deeper brackets as one literal segment
// and silently ignores parameters past the limit.
type formLimits struct {
	strict     bool
	depth      int
	arrayLimit func(count int) int
}

var (
	bodyLimits  = formLimits{strict: true, depth: 32, arrayLimit: func(count int) int { return max(100, count) }}
	queryLimits = formLimits{strict: false, depth: 5, arrayLimit: func(int) int { return 20 }}
)

func parseForm(data string) (jsvalue.Value, error) { return parseFormWith(data, bodyLimits) }

func parseFormWith(data string, limits formLimits) (jsvalue.Value, error) {
	const parameterLimit = 1000
	depth := limits.depth
	count := strings.Count(data, "&")
	if count >= parameterLimit {
		if limits.strict {
			return jsvalue.Value{}, errors.New("too many form parameters")
		}
		parts := strings.SplitN(data, "&", parameterLimit+1)
		data = strings.Join(parts[:parameterLimit], "&")
		count = parameterLimit - 1
	}
	values := make(map[string]jsvalue.Value)
	var keys []string
	for part := range strings.SplitSeq(formBrackets.Replace(data), "&") {
		equal := strings.Index(part, "]=") + 1
		if equal == 0 {
			equal = strings.IndexByte(part, '=')
		}
		name, text := part, ""
		if equal >= 0 {
			name, text = part[:equal], part[equal+1:]
		}
		name = decodeFormPart(name)
		if name == "" {
			continue
		}
		value := jsvalue.Str(decodeFormPart(text))
		switch old := values[name]; old.Kind {
		case jsvalue.Undefined:
			keys = append(keys, name)
			values[name] = value
		case jsvalue.Array:
			old.List = append(old.List, value)
			values[name] = old
		default:
			values[name] = jsvalue.Arr(old, value)
		}
	}
	slices.SortStableFunc(keys, func(a, b string) int {
		return cmp.Compare(formIndex(a), formIndex(b))
	})

	result := jsvalue.Obj()
	for _, key := range keys {
		matches := formChild.FindAllStringIndex(key, depth+1)
		var rest string
		if len(matches) > depth {
			if limits.strict {
				return jsvalue.Value{}, errors.New("form parameter exceeds bracket depth")
			}
			// qs: the remainder after `depth` segments becomes one literal key.
			rest = key[matches[depth][0]:]
			matches = matches[:depth]
		}
		leaf := values[key]
		if rest != "" {
			leaf = jsvalue.Obj(jsvalue.Property(rest, leaf))
		}
		for i := len(matches) - 1; i >= 0; i-- {
			start, end := matches[i][0], matches[i][1]
			leaf = formBranch(key[start+1:end-1], leaf, limits.arrayLimit(count))
		}
		parent := key
		if len(matches) > 0 {
			parent = key[:matches[0][0]]
		}
		if parent == "__proto__" {
			continue
		}
		if parent != "" {
			leaf = jsvalue.Obj(jsvalue.Property(parent, leaf))
		}
		result = mergeForm(result, leaf)
	}
	return compactForm(result), nil
}

func formIndex(s string) uint32 {
	const noIndex = ^uint32(0)
	if len(s) == 0 || (len(s) > 1 && s[0] == '0') || s[0] < '0' || s[0] > '9' {
		return noIndex
	}
	index, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		return noIndex
	}
	return uint32(index)
}

func decodeFormPart(s string) string {
	value, err := url.QueryUnescape(s)
	if err != nil || !utf8.ValidString(value) {
		return strings.ReplaceAll(s, "+", " ")
	}
	return value
}

func formBranch(key string, leaf jsvalue.Value, arrayLimit int) jsvalue.Value {
	switch {
	case key == "":
		if leaf.Kind == jsvalue.Array {
			return leaf
		}
		return jsvalue.Arr(leaf)
	case key == "__proto__":
		return jsvalue.Obj()
	}
	if i := formIndex(key); i <= uint32(arrayLimit) {
		items := make([]jsvalue.Value, i+1)
		items[i] = leaf
		return jsvalue.Arr(items...)
	}
	return jsvalue.Obj(jsvalue.Property(key, leaf))
}

func mergeForm(target, source jsvalue.Value) jsvalue.Value {
	if !source.Truthy() {
		return target
	}
	if !formContainer(source) {
		switch target.Kind {
		case jsvalue.Array:
			target.List = append(target.List, source)
		case jsvalue.Object:
			if key := source.MustString(); key != "__proto__" {
				target.Set(jsvalue.Property(key, jsvalue.Bool(true)))
			}
		default:
			return jsvalue.Arr(target, source)
		}
		return target
	}
	if !formContainer(target) {
		list := []jsvalue.Value{target}
		if source.Kind == jsvalue.Array {
			return jsvalue.Arr(append(list, source.List...)...)
		}
		return jsvalue.Arr(append(list, source)...)
	}
	if target.Kind == jsvalue.Array && source.Kind == jsvalue.Array {
		return mergeFormArrays(target, source)
	}
	target = formObject(target)
	for _, field := range formObject(source).Fields {
		i := slices.IndexFunc(target.Fields, func(current jsvalue.Field) bool {
			return slices.Equal(current.Key, field.Key)
		})
		if i < 0 {
			target.Fields = append(target.Fields, field)
		} else {
			target.Fields[i].Value = mergeForm(target.Fields[i].Value, field.Value)
		}
	}
	return target
}

func formContainer(v jsvalue.Value) bool {
	return v.Kind == jsvalue.Object || v.Kind == jsvalue.Array
}

func mergeFormArrays(target, source jsvalue.Value) jsvalue.Value {
	for i, item := range source.List {
		if item.Kind == jsvalue.Undefined {
			continue
		}
		if i >= len(target.List) {
			target.List = append(target.List, make([]jsvalue.Value, i+1-len(target.List))...)
		}
		current := target.List[i]
		switch {
		case current.Kind == jsvalue.Undefined:
			target.List[i] = item
		case formContainer(current) && formContainer(item):
			target.List[i] = mergeForm(current, item)
		default:
			target.List = append(target.List, item)
		}
	}
	return target
}

func formObject(value jsvalue.Value) jsvalue.Value {
	if value.Kind == jsvalue.Object {
		return value
	}
	object := jsvalue.Obj()
	for i, item := range value.List {
		if item.Kind != jsvalue.Undefined {
			object.Fields = append(object.Fields, jsvalue.Property(strconv.Itoa(i), item))
		}
	}
	return object
}

func compactForm(value jsvalue.Value) jsvalue.Value {
	for i := range value.Fields {
		value.Fields[i].Value = compactForm(value.Fields[i].Value)
	}
	items := value.List[:0]
	for _, item := range value.List {
		if item.Kind != jsvalue.Undefined {
			items = append(items, compactForm(item))
		}
	}
	value.List = items
	return value
}
