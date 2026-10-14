#!/usr/bin/env bash
set -e

# Daemon in userspace mode, opens a local proxy on :1055 (SOCKS5 + HTTP both)
tailscaled \
  --tun=userspace-networking \
  --socks5-server=localhost:1055 \
  --outbound-http-proxy-listen=localhost:1055 \
  --state=mem: &

# Join the tailnet (ephemeral key -> node auto-removed on exit)
tailscale up \
  --authkey="${TS_AUTHKEY}" \
  --hostname=str-dashboard \
  --accept-dns=true

# Route the app's outbound traffic through the tailnet
export ALL_PROXY=socks5://localhost:1055/
export HTTP_PROXY=http://localhost:1055/
export HTTPS_PROXY=http://localhost:1055/
export NO_PROXY=localhost,127.0.0.1

exec <your normal start command>   # e.g. node server.js
