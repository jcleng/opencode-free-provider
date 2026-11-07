#!/bin/bash
OLD=$(ps aux | grep "[s]erver.js" | awk '{print $2}')
[ -n "$OLD" ] && kill $OLD && sleep 2
setsid nohup node server.js >> server.log 2>&1 < /dev/null &
sleep 5
echo "=== running ==="
ps aux | grep "[s]erver.js" | head -2
echo "=== last log lines ==="
tail -4 server.log
