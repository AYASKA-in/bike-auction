# ADR 003: HTTP for commands, WebSocket for events

Commands (bids, admin actions) use HTTPS so they get status codes, idempotency keys, CSRF origin checks and
request tracing. The WebSocket is a server→client feed (versioned protocol, `seq` on every event, snapshot on
connect). Client messages other than heartbeats are counted and the socket is closed on abuse. Origin is checked
on upgrade because browsers do not apply CORS to WebSockets.
