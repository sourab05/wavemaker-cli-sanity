#!/usr/bin/env bash
# Existing Project only: non-empty EXISTING_* build params override the Jenkins credentials.
# Empty params change nothing. Sourced (not executed) so the exports reach the caller.
if [ "${PROJECT_MODE:-Existing Project}" != "Existing Project" ]; then
  return 0 2>/dev/null || exit 0
fi

{ set +x; } 2>/dev/null # keep the password out of the shell trace
set_all() { # value, then every variable it overrides
  local value="$1"; shift
  [ -z "$value" ] && return 0
  local name; for name in "$@"; do export "$name=$value"; done
}

set_all "${EXISTING_USERNAME:-}" WM_USERNAME WMO_USER SECURITY_USERNAME
set_all "${EXISTING_PASSWORD:-}" WM_PASSWORD WMO_PASS SECURITY_PASSWORD
set_all "${EXISTING_STUDIO_URL:-}" STUDIO_URL STUDIO_BASE_URL SECURITY_STUDIO_URL
set_all "${EXISTING_PROJECT_ID:-}" WM_PROJECT_ID PROJECT_ID SECURITY_PROJECT_ID
set_all "${EXISTING_STUDIO_PROJECT_ID:-}" STUDIO_PROJECT_ID SECURITY_STUDIO_PROJECT_ID
echo "--- Existing Project: build-parameter overrides applied where provided ---"
