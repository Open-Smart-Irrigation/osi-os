"""Persistent in-memory SQLite for characterization on Node 20 (no node:sqlite)."""
import json
import sqlite3
import sys

connection = sqlite3.connect(':memory:')
for line in sys.stdin:
    request = json.loads(line)
    try:
        if request['kind'] == 'close':
            connection.close()
            print(json.dumps({'ok': True}), flush=True)
            break
        if request['kind'] == 'exec':
            connection.executescript(request['sql'])
            value = None
        else:
            cursor = connection.execute(request['sql'], request['params'])
            columns = [column[0] for column in cursor.description]
            # Duplicate SELECT column names follow Node's last-column-wins rule.
            value = [dict(zip(columns, row)) for row in cursor.fetchall()]
        print(json.dumps({'ok': True, 'value': value}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
