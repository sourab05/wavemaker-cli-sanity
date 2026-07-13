#!/usr/bin/env bash
# Source dynamic project env from provision step (New Project mode).
set -a
if [ -f "${CI_PROJECT_ENV_FILE:-${WORKSPACE:-.}/.ci-project-env.sh}" ]; then
  # shellcheck disable=SC1090
  . "${CI_PROJECT_ENV_FILE:-${WORKSPACE:-.}/.ci-project-env.sh}"
  echo "--- Loaded dynamic project env from .ci-project-env.sh ---"
elif [ -f ".ci-project-env.sh" ]; then
  # shellcheck disable=SC1091
  . ".ci-project-env.sh"
  echo "--- Loaded dynamic project env from .ci-project-env.sh ---"
fi
set +a
