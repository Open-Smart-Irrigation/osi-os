#!/bin/sh

echo "Restore SQLite database"
service chirpstack stop
# WAL journal: a stale -wal or -shm next to the restored file would be replayed
# onto it. Remove them, then restore the backup's own sidecars if it has any.
for ext in -wal -shm; do
	rm -f "/srv/chirpstack/chirpstack.sqlite$ext"
done
cp /srv/backup/chirpstack.sqlite /srv/chirpstack/chirpstack.sqlite
for ext in -wal -shm; do
	[ -e "/srv/backup/chirpstack.sqlite$ext" ] && cp "/srv/backup/chirpstack.sqlite$ext" "/srv/chirpstack/chirpstack.sqlite$ext"
done
service chirpstack start

echo "Restore Redis database"
service redis stop
cp /srv/backup/chirpstack.redis /srv/redis/dump.rdb
service redis start
