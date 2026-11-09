#!/usr/bin/env bash
# Source only; exports stay in the current process, not global credentials.
if [ "${PROJECT_MODE:-Existing Project}" != "New Project" ]; then
  return 0 2>/dev/null || exit 0
fi
{ set +x; } 2>/dev/null
_new_project_exports=$(node -r ts-node/register scripts/new-project-env.ts "${_new_project_validate_file:-}") || {
  unset _new_project_exports
  return 1 2>/dev/null || exit 1
}
eval "$_new_project_exports"
unset _new_project_exports
