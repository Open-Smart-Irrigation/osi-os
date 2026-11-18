#!/bin/sh

echo "SQLite database"
service chirpstack stop
cp /srv/chirpstack/chirpstack.sqlite /srv/backup/chirpstack.sqlite
# WAL journal: ChirpStack does not close its connections on stop, so a -wal
# file (and -shm) usually remains and holds committed data. Copy the sidecars
# with the database, and drop stale ones left by an earlier backup.
for ext in -wal -shm; do
	rm -f "/srv/backup/chirpstack.sqlite$ext"
	[ -e "/srv/chirpstack/chirpstack.sqlite$ext" ] && cp "/srv/chirpstack/chirpstack.sqlite$ext" "/srv/backup/chirpstack.sqlite$ext"
done
service chirpstack start

echo "Backup Redis database"
service redis stop
cp /srv/redis/dump.rdb /srv/backup/chirpstack.redis
service redis start
