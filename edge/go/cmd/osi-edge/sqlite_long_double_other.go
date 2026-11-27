//go:build !arm64

package main

// sqliteLongDoubleBits is the significand precision of the C long double that
// the x86 oracle's SQLite uses in sqlite3AtoF: the 64-bit x87 extended format.
// Only arm64 builds ship; this keeps amd64 replays exact against the oracle.
const sqliteLongDoubleBits = 64
