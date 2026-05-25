#!/usr/bin/env bash
# Bootstrap Gradle + Android SDK on Jenkins/Linux when not pre-installed on the agent.
set -euo pipefail

GRADLE_VERSION="${GRADLE_VERSION:-8.10.2}"
ANDROID_API="${ANDROID_API:-34}"
BUILD_TOOLS="${BUILD_TOOLS:-34.0.0}"
CMDLINE_TOOLS_VERSION="${CMDLINE_TOOLS_VERSION:-11076708}"

TOOLS_DIR="${WORKSPACE}/.ci-tools"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${TOOLS_DIR}/android-sdk}}"
CI_ENV_FILE="${WORKSPACE}/.ci-env.sh"

mkdir -p "${TOOLS_DIR}"
mkdir -p "${ANDROID_SDK_ROOT}"

echo "--- Setting up Android build tools ---"
echo "  WORKSPACE:      ${WORKSPACE}"
echo "  ANDROID_SDK_ROOT: ${ANDROID_SDK_ROOT}"

# Gradle (wm-reactnative checks `gradle --version` before building)
if command -v gradle >/dev/null 2>&1; then
  GRADLE_BIN="$(command -v gradle)"
  echo "  Gradle:         ${GRADLE_BIN} (existing)"
else
  GRADLE_DIR="${TOOLS_DIR}/gradle-${GRADLE_VERSION}"
  if [ ! -x "${GRADLE_DIR}/bin/gradle" ]; then
    echo "  Installing Gradle ${GRADLE_VERSION}..."
    curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
      -o "${TOOLS_DIR}/gradle.zip"
    rm -rf "${GRADLE_DIR}"
    unzip -q "${TOOLS_DIR}/gradle.zip" -d "${TOOLS_DIR}"
    rm -f "${TOOLS_DIR}/gradle.zip"
  fi
  export PATH="${GRADLE_DIR}/bin:${PATH}"
  echo "  Gradle:         ${GRADLE_DIR}/bin/gradle"
fi

# Java
if [ -z "${JAVA_HOME:-}" ] && command -v java >/dev/null 2>&1; then
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)" 2>/dev/null || command -v java)")")"
  export JAVA_HOME
fi
echo "  JAVA_HOME:      ${JAVA_HOME:-not set}"
java -version
gradle --version

# Android SDK command-line tools
SDKMANAGER="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "${SDKMANAGER}" ]; then
  echo "  Installing Android command-line tools..."
  curl -fsSL \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
    -o "${TOOLS_DIR}/cmdline-tools.zip"
  rm -rf "${ANDROID_SDK_ROOT}/cmdline-tools"
  mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools"
  unzip -q "${TOOLS_DIR}/cmdline-tools.zip" -d "${ANDROID_SDK_ROOT}/cmdline-tools"
  mv "${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools" "${ANDROID_SDK_ROOT}/cmdline-tools/latest"
  rm -f "${TOOLS_DIR}/cmdline-tools.zip"
fi

export ANDROID_HOME="${ANDROID_SDK_ROOT}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}"
export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${PATH}"

echo "  Accepting Android SDK licenses..."
yes | sdkmanager --licenses >/dev/null || true

echo "  Installing Android SDK packages..."
sdkmanager "platform-tools" "platforms;android-${ANDROID_API}" "build-tools;${BUILD_TOOLS}"

cat > "${CI_ENV_FILE}" <<EOF
export PATH="${PATH}"
export JAVA_HOME="${JAVA_HOME:-}"
export ANDROID_HOME="${ANDROID_HOME}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}"
EOF

echo "--- Android build tools ready ---"
echo "  sdkmanager: $(command -v sdkmanager)"
echo "  adb:        $(command -v adb || echo 'not found')"
echo "  Wrote ${CI_ENV_FILE}"
