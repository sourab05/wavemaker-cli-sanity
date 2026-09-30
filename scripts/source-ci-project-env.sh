#!/usr/bin/env bash
# Source dynamic project env from provision step (New Project mode).
# ponytail: guard here instead of in every caller — PROJECT_MODE=Both leaves a provisioned
# .ci-project-env.sh on disk that must not leak into the "Existing Project" pass.
if [ "${PROJECT_MODE:-Existing Project}" != "New Project" ]; then
  echo "--- PROJECT_MODE=${PROJECT_MODE:-Existing Project} — not loading .ci-project-env.sh ---"
  return 0 2>/dev/null || exit 0
fi

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
