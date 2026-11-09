#!/usr/bin/env bash
# Source dynamic project env from provision step (New Project mode).
# ponytail: guard here instead of in every caller — PROJECT_MODE=Both leaves a provisioned
# .ci-project-env.sh on disk that must not leak into the "Existing Project" pass.
if [ "${PROJECT_MODE:-Existing Project}" != "New Project" ]; then
  echo "--- PROJECT_MODE=${PROJECT_MODE:-Existing Project} — not loading .ci-project-env.sh ---"
  return 0 2>/dev/null || exit 0
fi

_project_env_file="${CI_PROJECT_ENV_FILE:-${WORKSPACE:-.}/.ci-project-env.sh}"
# Validate provenance before sourcing IDs; no fallback to an unrelated workspace.
_new_project_validate_file="$_project_env_file"
. scripts/apply-new-project-overrides.sh || {
  unset _new_project_validate_file
  unset _project_env_file
  return 1 2>/dev/null || exit 1
}
unset _new_project_validate_file
# shellcheck disable=SC1090
. "$_project_env_file"
unset _project_env_file
echo "--- Loaded context-validated dynamic project env ---"
