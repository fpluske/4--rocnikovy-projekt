#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Pouziti:
  ./release-update.sh <verze> <versionCode> [poznamka]

Priklad:
  ./release-update.sh 0.2.9 3 "Oprava aktualizace"
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="$1"
VERSION_CODE="$2"
RELEASE_NOTES="${3:-Orbit Agent $VERSION}"
TAG="v$VERSION"
APK_SOURCE="$SCRIPT_DIR/app/build/outputs/apk/release/app-release.apk"
APK_ASSET="$SCRIPT_DIR/app/build/outputs/apk/release/orbit-agent-$VERSION.apk"
SIGNING_ENV="$SCRIPT_DIR/.orbit-signing.env"

if [[ ! "$VERSION" =~ ^[0-9]+([.][0-9]+){1,3}$ ]]; then
  echo "Chybna verze: $VERSION" >&2
  exit 2
fi

if [[ ! "$VERSION_CODE" =~ ^[0-9]+$ ]] || [[ "$VERSION_CODE" -le 0 ]]; then
  echo "versionCode musi byt kladne cele cislo: $VERSION_CODE" >&2
  exit 2
fi

if [[ ! -f "$SIGNING_ENV" ]]; then
  echo "Chybi podpisove nastaveni: $SIGNING_ENV" >&2
  exit 1
fi

for command_name in gh java keytool; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Chybi prikaz: $command_name" >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI neni prihlasene. Spustte: gh auth login" >&2
  exit 1
fi

set -a
source "$SIGNING_ENV"
set +a

if [[ -z "${ORBIT_KEYSTORE:-}" || ! -f "$ORBIT_KEYSTORE" ]]; then
  echo "ORBIT_KEYSTORE neodkazuje na existujici keystore." >&2
  exit 1
fi

ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$ANDROID_SDK" && -f "$SCRIPT_DIR/local.properties" ]]; then
  ANDROID_SDK="$(sed -n 's/^sdk.dir=//p' "$SCRIPT_DIR/local.properties")"
fi

if [[ -z "$ANDROID_SDK" || ! -d "$ANDROID_SDK" ]]; then
  echo "Android SDK nebylo nalezeno. Nastavte ANDROID_SDK_ROOT nebo ANDROID_HOME." >&2
  exit 1
fi

APKSIGNER="$(find "$ANDROID_SDK/build-tools" -type f -name apksigner | sort -V | tail -n 1)"
AAPT="$(find "$ANDROID_SDK/build-tools" -type f -name aapt | sort -V | tail -n 1)"
if [[ -z "$APKSIGNER" ]]; then
  echo "Android build-tools neobsahuji apksigner." >&2
  exit 1
fi

JDK17="/usr/lib/jvm/java-17-temurin-jdk"
if [[ -d "$JDK17" ]]; then
  export JAVA_HOME="$JDK17"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

echo "Sestavuji Orbit Agent $VERSION (versionCode $VERSION_CODE)..."
./gradlew :app:assembleRelease \
  "-PorbitVersion=$VERSION" \
  "-PorbitVersionCode=$VERSION_CODE"

if [[ ! -f "$APK_SOURCE" ]]; then
  echo "Sestaveny APK soubor nebyl nalezen: $APK_SOURCE" >&2
  exit 1
fi

"$APKSIGNER" verify --verbose "$APK_SOURCE" >/dev/null
cp "$APK_SOURCE" "$APK_ASSET"

if [[ -n "$AAPT" ]]; then
  BADGING="$("$AAPT" dump badging "$APK_ASSET")"
  APK_PACKAGE="$(printf '%s\n' "$BADGING" | sed -n 's/^package: name='\''[^'\'']*'\'' versionCode='\''\([^'\'']*\)'\'' versionName='\''\([^'\'']*\)'\''.*/\1 \2/p' | head -n 1)"
  echo "Manifest: $APK_PACKAGE"
fi

SHA256="$(sha256sum "$APK_ASSET" | awk '{print $1}')"
echo "APK: $APK_ASSET"
echo "SHA-256: $SHA256"

if gh release view "$TAG" --repo fpluske/4--rocnikovy-projekt >/dev/null 2>&1; then
  echo "GitHub Release $TAG uz existuje." >&2
  exit 1
fi

echo "Vytvarim GitHub Release $TAG..."
gh release create "$TAG" "$APK_ASSET" \
  --repo fpluske/4--rocnikovy-projekt \
  --title "Orbit Agent $VERSION" \
  --notes "$RELEASE_NOTES"

echo "Hotovo: https://github.com/fpluske/4--rocnikovy-projekt/releases/tag/$TAG"
