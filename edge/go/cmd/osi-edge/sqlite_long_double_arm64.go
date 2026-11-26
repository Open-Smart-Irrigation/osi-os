package main

// sqliteLongDoubleBits is the significand precision of the C long double that
// the gateway's SQLite uses in sqlite3AtoF: IEEE binary128 on aarch64 Linux.
const sqliteLongDoubleBits = 113
