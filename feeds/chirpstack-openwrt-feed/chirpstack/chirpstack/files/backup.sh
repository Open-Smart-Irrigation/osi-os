#!/bin/sh

echo "SQLite database"
service chirpstack stop
cp /srv/chirpstack/chirpstack.sqlite /srv/backup/chirpstack.sqlite
# WAL journal: a clean stop checkpoints and removes the -wal file, but keep any
# sidecar that survived an unclean stop with the copy, and no stale one from an
# earlier backup.
for ext in -wal -shm; do
	rm -f "/srv/backup/chirpstack.sqlite$ext"
	[ -e "/srv/chirpstack/chirpstack.sqlite$ext" ] && cp "/srv/chirpstack/chirpstack.sqlite$ext" "/srv/backup/chirpstack.sqlite$ext"
done
service chirpstack start

echo "Backup Redis database"
service redis stop
cp /srv/redis/dump.rdb /srv/backup/chirpstack.redis
service redis start
