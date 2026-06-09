#!/usr/bin/env bash
# Configure npm registries before any npm install.
# Usage: ./scripts/configure-npm-registry.sh [project-dir]
#   project-dir  optional — writes .npmrc into that directory (e.g. CLI clone or RN project)

set -e

PUBLIC_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
WM_REGISTRY="${WM_NPM_REGISTRY:-https://repository.wavemaker.com/repository/wavemaker-npm-repo/}"
PROJECT_DIR="${1:-}"

echo "--- Configuring npm registries ---"
echo "  public:    ${PUBLIC_REGISTRY}"
echo "  @wavemaker scopes: ${WM_REGISTRY}"

npm config set registry "${PUBLIC_REGISTRY}"
npm config set @wavemaker:registry "${WM_REGISTRY}"
npm config set @wavemaker-ai:registry "${WM_REGISTRY}"

if [ -n "${PROJECT_DIR}" ]; then
  mkdir -p "${PROJECT_DIR}"
  cat > "${PROJECT_DIR}/.npmrc" << EOF
registry=${PUBLIC_REGISTRY}
@wavemaker:registry=${WM_REGISTRY}
@wavemaker-ai:registry=${WM_REGISTRY}
EOF
  echo "--- Wrote ${PROJECT_DIR}/.npmrc ---"
fi

echo "registry=$(npm config get registry)"
echo "@wavemaker:registry=$(npm config get @wavemaker:registry)"
echo "@wavemaker-ai:registry=$(npm config get @wavemaker-ai:registry)"
