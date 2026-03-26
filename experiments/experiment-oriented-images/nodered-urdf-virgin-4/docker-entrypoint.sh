#!/bin/sh
set -eu

# ============================================================================
# Container entrypoint for Node-RED with uRDF / reasoning plugin support
# ============================================================================
# This script prepares the persistent Node-RED user directory (/data),
# installs the custom plugin into the volume-backed node_modules directory,
# ensures a stable credential encryption secret, and then delegates execution
# to the base Node-RED entrypoint.
#
# The goal is to make the container:
# - reproducible (deterministic startup behavior),
# - restart-safe (state preserved across restarts),
# - compatible with standard Node-RED expectations.
# ============================================================================

# ---------------------------------------------------------------------------
# Persistent user directory and plugin layout
# ---------------------------------------------------------------------------
# /data is the standard persistent volume used by the Node-RED Docker image.
# Anything placed here survives container restarts.
USER_DIR="/data"

PLUGIN_SRC="/opt/node-red-urdf-plugin"
PLUGIN_NAME="node-red-urdf-plugin"
DEST_DIR="$USER_DIR/node_modules/$PLUGIN_NAME"

DEFAULT_SETTINGS="/opt/nodered-default-settings.js"
SETTINGS_FILE="$USER_DIR/settings.js"

SECRET_FILE="$USER_DIR/.node-red-credential-secret"

DEFAULT_FLOWS="/opt/nodered-default-flows.json"
FLOWS_FILE="$USER_DIR/flows.json"

# ---------------------------------------------------------------------------
# Base directory preparation
# ---------------------------------------------------------------------------
# Ensure the Node-RED user module directory exists before attempting installs.
mkdir -p "$USER_DIR/node_modules"

# ---------------------------------------------------------------------------
# Credential secret initialization
# ---------------------------------------------------------------------------
# Node-RED encrypts credentials using a secret key.
#
# Priority order:
#   1. Explicitly provided NODE_RED_CREDENTIAL_SECRET environment variable
#   2. Persisted secret stored in /data/.node-red-credential-secret
#
# If neither exists, a new secret is generated once and stored in /data so
# that encrypted credentials remain readable across container restarts.
if [ -z "${NODE_RED_CREDENTIAL_SECRET:-}" ] && [ ! -f "$SECRET_FILE" ]; then
  echo "[entrypoint] Generating credential secret at $SECRET_FILE ..."
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE" || true
fi

# ---------------------------------------------------------------------------
# Node-RED settings initialization
# ---------------------------------------------------------------------------
# On a fresh volume, Node-RED has no settings.js file.
# In that case, a predefined settings template is copied into /data.
#
# This ensures that:
# - custom runtime configuration is applied automatically
# - users can later edit /data/settings.js without rebuilding the image
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "[entrypoint] Creating default settings.js in $SETTINGS_FILE ..."
  cp "$DEFAULT_SETTINGS" "$SETTINGS_FILE"
fi

# ---------------------------------------------------------------------------
# Default flows initialization
# ---------------------------------------------------------------------------
# On a fresh volume, Node-RED has no flows file.
# In that case, copy a predefined default flows file into /data.
#
# This mirrors the behavior used for settings.js:
# - defaults are provided once
# - user modifications persist across restarts
echo "[entrypoint] Creating default flows file in $FLOWS_FILE ..."
cp "$DEFAULT_FLOWS" "$FLOWS_FILE"


# ---------------------------------------------------------------------------
# Plugin installation into the persistent volume
# ---------------------------------------------------------------------------
# Node-RED only loads user-installed modules from /data/node_modules.
# Even though the plugin is built into the image, it must be copied into
# the volume-backed directory to be discovered by Node-RED at runtime.
#
# This copy is performed only once per volume lifecycle.
if [ ! -d "$DEST_DIR" ]; then
  echo "[entrypoint] Installing $PLUGIN_NAME into $DEST_DIR (from prebuilt $PLUGIN_SRC)..."
  cp -r "$PLUGIN_SRC" "$DEST_DIR"
else
  echo "[entrypoint] $PLUGIN_NAME already present in $DEST_DIR"
fi

# ---------------------------------------------------------------------------
# Delegate to the base Node-RED entrypoint
# ---------------------------------------------------------------------------
# Control is handed off to the original Node-RED Docker entrypoint,
# preserving all default startup behavior (signals, logging, arguments).
echo "[entrypoint] Starting Node-RED via base image entrypoint..."
cd /usr/src/node-red
exec ./entrypoint.sh

