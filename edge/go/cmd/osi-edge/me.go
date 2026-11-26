package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"sync"
	"time"

	"osi-edge/internal/auth"
	"osi-edge/internal/httpbody"
	"osi-edge/internal/jsvalue"
)

func init() {
	register("GET", "/api/me", (*backend).me)
}

func (b *backend) me(w http.ResponseWriter, r *http.Request, _ params, _ httpbody.Body) {
	session, failure := auth.VerifyBearer(r.Header.Get("Authorization"), time.Now().UnixMilli(), b.authSecret)
	if failure != nil {
		if failure.Coercion {
			deviceAPICoercionFailure(w)
			return
		}
		title := "Unauthorized"
		if failure.Status == 500 {
			title = "device-api failed"
		}
		respond(w, failure.Status, jsvalue.Property("error", jsvalue.Str(title)), jsvalue.Property("message", jsvalue.Str(failure.Message)))
		return
	}
	id := session.UserID
	if id <= 0 || id > 9007199254740991 || math.Trunc(id) != id {
		message(w, 401, "Unauthorized")
		return
	}

	ctx := r.Context()
	var username string
	var uuid storedValue
	var disabled any
	err := b.db.QueryRowContext(ctx, "SELECT username, user_uuid, disabled_at FROM users WHERE id = ? AND username = ?",
		int64(id), session.Username.MustString()).Scan(&username, &uuid, &disabled)
	// api-me-fn: if (!user || user.disabled_at), JavaScript truthiness.
	if errors.Is(err, sql.ErrNoRows) || storedTruthy(disabled) {
		message(w, 403, "Forbidden")
		return
	}
	if err != nil {
		scopeError(w, err)
		return
	}
	scoped := scopedAccess()
	scope := userScope{role: jsvalue.Str("admin"), zones: jsvalue.Nil(), plots: jsvalue.Nil()}
	if scoped {
		scope, err = b.resolveScope(ctx, uuid)
		if err != nil {
			scopeError(w, err)
			return
		}
	}
	respond(w, 200,
		jsvalue.Property("username", jsvalue.Str(username)),
		jsvalue.Property("user_uuid", uuid.json()),
		jsvalue.Property("role", scope.role),
		jsvalue.Property("zone_uuids", scope.zones),
		jsvalue.Property("plot_uuids", scope.plots),
		jsvalue.Property("features", jsvalue.Obj(jsvalue.Property("scoped_access", jsvalue.Bool(scoped)))),
	)
}

// userScope is osi-scope-helper loadScope's result. role keeps its storage
// class (it is compared with ===); zones and plots are the Set contents in
// insertion order, with their JSON form for /api/me.
type userScope struct {
	role, zones, plots jsvalue.Value
	roleValue          storedValue
	zoneKeys           map[string]bool
	disabled           bool
	loadedAt           time.Time
}

type scopeCacheEntry struct {
	mu    sync.Mutex
	scope userScope
}

// resolveScope caches by user_uuid for 30 s, as the Map in osi-scope-helper
// does. A Buffer key never hits that Map (node-sqlite3 returns a new Buffer
// on every read), so a BLOB uuid always loads.
func (b *backend) resolveScope(ctx context.Context, uuid storedValue) (userScope, error) {
	if !uuid.truthy() {
		return userScope{}, errors.New("resolveScope called without user_uuid")
	}
	key, cacheable := uuid.key()
	if !cacheable {
		return b.loadScope(ctx, uuid)
	}
	value, _ := b.scopes.LoadOrStore(key, &scopeCacheEntry{})
	entry := value.(*scopeCacheEntry)
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if time.Since(entry.scope.loadedAt) < 30*time.Second {
		return entry.scope, nil
	}
	scope, err := b.loadScope(ctx, uuid)
	if err == nil {
		// An invalidated entry may still have a load running. It can only
		// update its detached value, so it cannot repopulate the cache.
		entry.scope = scope
	}
	return scope, err
}

// invalidateScope is invalidateScope(userUuid) for a cached key.
func (b *backend) invalidateScope(uuid storedValue) {
	if key, ok := uuid.key(); ok {
		b.scopes.Delete(key)
	}
}

func (b *backend) loadScope(ctx context.Context, uuid storedValue) (userScope, error) {
	if !uuid.truthy() {
		return userScope{}, errors.New("resolveScope called without user_uuid")
	}
	var id int64
	var role storedValue
	var disabled any
	if err := b.db.QueryRowContext(ctx, "SELECT id, role, disabled_at FROM users WHERE user_uuid = ?", uuid.arg()).
		Scan(&id, &role, &disabled); err != nil {
		return userScope{}, err
	}
	scope := userScope{role: role.json(), roleValue: role, zones: jsvalue.Arr(), plots: jsvalue.Arr(),
		zoneKeys: map[string]bool{}, disabled: storedTruthy(disabled)}
	if !scope.disabled {
		var err error
		scope.zones, scope.zoneKeys, err = b.scopeIDs(ctx, `
			SELECT zone_uuid FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL AND zone_uuid IS NOT NULL
			UNION ALL
			SELECT zone_uuid FROM user_zone_assignments WHERE user_uuid = ? AND deleted_at IS NULL`, id, uuid.arg())
		if err != nil {
			return userScope{}, err
		}
		scope.plots, _, err = b.scopeIDs(ctx, `
			SELECT plot_uuid FROM journal_plots WHERE owner_user_uuid = ? AND deleted_at IS NULL
			UNION ALL
			SELECT plot_uuid FROM user_plot_assignments WHERE user_uuid = ? AND deleted_at IS NULL`, uuid.arg(), uuid.arg())
		if err != nil {
			return userScope{}, err
		}
	}
	scope.loadedAt = time.Now()
	return scope, nil
}

// scopeIDs builds a Set: equal strings collapse, every Buffer is its own
// member.
func (b *backend) scopeIDs(ctx context.Context, query string, args ...any) (jsvalue.Value, map[string]bool, error) {
	rows, err := b.db.QueryContext(ctx, query, args...)
	if err != nil {
		return jsvalue.Value{}, nil, err
	}
	defer rows.Close()
	var ids []jsvalue.Value
	seen := make(map[string]bool)
	for rows.Next() {
		var id storedValue
		if err := rows.Scan(&id); err != nil {
			return jsvalue.Value{}, nil, err
		}
		key, keyed := id.key()
		if keyed && seen[key] {
			continue
		}
		if keyed {
			seen[key] = true
		}
		ids = append(ids, id.json())
	}
	return jsvalue.Arr(ids...), seen, rows.Err()
}

func nullableText(s sql.NullString) jsvalue.Value {
	if !s.Valid {
		return jsvalue.Nil()
	}
	return jsvalue.Str(s.String)
}

func scopeError(w http.ResponseWriter, err error) {
	log.Printf("resolve scope: %v", err)
	message(w, 500, "unable to resolve scope")
}
