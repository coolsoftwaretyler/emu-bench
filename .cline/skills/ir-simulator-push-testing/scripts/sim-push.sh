#!/usr/bin/env bash
#
# sim-push.sh — send a simulated push notification to a booted iOS simulator.
#
# This script runs `xcrun simctl push`, which sends a JSON payload to an installed app
# in the same form that APNs uses. The payload contains a deep link. When the user taps
# the banner, the app runs its notification handler, the push SDK claims the message,
# and the router opens a screen. `simctl openurl` tests none of these three parts.
#
#   ./sim-push.sh devices [bundle]                 # booted simulators, with the facts to select one
#   ./sim-push.sh send <udid> <bundle> <file|->    # send to a running or background app
#   ./sim-push.sh cold <udid> <bundle> <file|->    # terminate the app first, then send
#   ./sim-push.sh open <udid> <url>                # open a URL with no push, for diagnosis
#
# Read the payload from a file, or write `-` to read the payload from stdin:
#
#   printf '%s' "$PAYLOAD" | ./sim-push.sh send "$UDID" com.example.app -
#
# The push SDK of the app controls the shape of the payload. This script does not.
# Airship reads its deep link from `^d`. Firebase reserves no such key, and the app
# selects one. This script sends the payload that you give it, and changes nothing.
#
# --- Select a simulator ------------------------------------------------------
#
# `devices` reports each booted simulator, and selects none of them. A developer runs
# one simulator for each worktree. If you send the push to the wrong simulator, no
# banner appears on the screen that the developer reads, and the developer sees the
# symptom of a broken deep link. Give the UDID, or set UDID in the environment.
#
# Give a bundle id to `devices` to also report which simulators have the app installed,
# and when each simulator last wrote its data container. Use the time to sort a question
# for the developer. Do not use the time to select a simulator, because the simulator
# with the most recent build is not always the simulator on the screen.
#
# --- Environment -------------------------------------------------------------
#
# UDID=<udid>
#   Read when a command takes a udid and receives `-` in its place. A caller can set the
#   target one time for a session.
#
# --- Notes -------------------------------------------------------------------
#
# `simctl push` operates on a simulator only. A physical device needs a real push
# through the API of the provider, sent to the token of that device.
#
# APNs limits a payload to 4096 bytes. This script measures the payload before it
# sends the payload, because simctl reports this failure less clearly than it reports
# an invalid payload.
set -euo pipefail

readonly MAX_PAYLOAD_BYTES=4096

die() {
  echo "Error: $*" >&2
  exit 1
}

# Clean up the temp payload on exit. A script-level EXIT trap, not a per-function
# RETURN trap: in bash 3.2 — the macOS default — a RETURN trap set inside a function
# is not function-local, so it leaks and re-fires when the caller returns, tripping
# `set -u` on the now-out-of-scope local. One EXIT trap on a global avoids that.
TMPFILE=""
trap '[[ -n "${TMPFILE:-}" ]] && rm -f "$TMPFILE"' EXIT

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'
  exit "${1:-0}"
}

require_xcrun() {
  command -v xcrun > /dev/null || die "xcrun not found. Install the Xcode command line tools."
}

# Resolve a udid argument, falling back to $UDID when the caller passes `-`.
resolve_udid() {
  local arg="${1:-}"
  if [[ -z "$arg" || "$arg" == "-" ]]; then
    [[ -n "${UDID:-}" ]] || die "No udid given and UDID is not set. Run: $0 devices"
    echo "$UDID"
  else
    echo "$arg"
  fi
}

app_installed() {
  xcrun simctl get_app_container "$1" "$2" app > /dev/null 2>&1
}

# Epoch mtime of the app's data container, or empty when the app is not installed.
container_mtime() {
  local path
  path="$(xcrun simctl get_app_container "$1" "$2" data 2> /dev/null)" || return 0
  [[ -n "$path" ]] || return 0
  stat -f %m "$path" 2> /dev/null || true
}

# Booted simulators, one per line: "<udid>\t<name>\t<runtime>".
#
# `simctl list devices booted` prints only booted devices, under a runtime header for
# each. Parsed as text rather than JSON so the script needs no jq and no python.
booted_devices() {
  local line runtime="" udid name
  while IFS= read -r line; do
    case "$line" in
      --*--)
        runtime="${line#-- }"
        runtime="${runtime% --}"
        continue
        ;;
    esac
    udid="$(printf '%s\n' "$line" | sed -n 's/.*(\([0-9A-Fa-f]\{8\}-[0-9A-Fa-f-]\{27\}\)).*/\1/p')"
    [[ -n "$udid" ]] || continue
    name="$(printf '%s\n' "$line" | sed -n 's/^ *\(.*\) ([0-9A-Fa-f]\{8\}-[0-9A-Fa-f-]\{27\}).*/\1/p')"
    printf '%s\t%s\t%s\n' "$udid" "$name" "$runtime"
  done < <(xcrun simctl list devices booted 2> /dev/null)
}

cmd_devices() {
  local bundle="${1:-}" devices udid name runtime app when mtime

  devices="$(booted_devices)"
  if [[ -z "$devices" ]]; then
    echo "No booted simulator found. Boot one, then run this again." >&2
    exit 1
  fi

  printf '%-38s %-22s %-10s %-11s %s\n' UDID NAME RUNTIME APP "LAST WRITTEN"
  while IFS=$'\t' read -r udid name runtime; do
    app="-"
    when="-"
    if [[ -n "$bundle" ]]; then
      if app_installed "$udid" "$bundle"; then
        app="installed"
        mtime="$(container_mtime "$udid" "$bundle")"
        [[ -n "$mtime" ]] && when="$(date -r "$mtime" '+%Y-%m-%d %H:%M')"
      else
        app="absent"
      fi
    fi
    printf '%-38s %-22s %-10s %-11s %s\n' "$udid" "$name" "$runtime" "$app" "$when"
  done << EOF
$devices
EOF
}

# Read the payload from a file or stdin into $TMPFILE, then check it.
stage_payload() {
  local source="$1" bytes
  TMPFILE="$(mktemp /tmp/sim-push-XXXXXX.apns)"

  if [[ "$source" == "-" ]]; then
    cat > "$TMPFILE"
  else
    [[ -f "$source" ]] || die "Payload file not found: $source"
    cat "$source" > "$TMPFILE"
  fi

  bytes="$(wc -c < "$TMPFILE" | tr -d ' ')"
  [[ "$bytes" -gt 0 ]] || die "The payload is empty."
  [[ "$bytes" -le "$MAX_PAYLOAD_BYTES" ]] \
    || die "The payload is $bytes bytes. APNs allows $MAX_PAYLOAD_BYTES bytes."
  grep -q '"aps"' "$TMPFILE" \
    || die "The payload has no \"aps\" key. simctl needs this key, and iOS shows no banner without it."
}

push() {
  local udid="$1" bundle="$2"
  app_installed "$udid" "$bundle" \
    || die "$bundle is not installed on $udid. Build the app to this simulator first."
  echo "-> sending to $bundle on $udid"
  xcrun simctl push "$udid" "$bundle" "$TMPFILE"
  echo "-> tap the notification on the simulator to open the deep link"
}

main() {
  local cmd="${1:-}" udid bundle

  case "$cmd" in
    "" | -h | --help | help) usage 0 ;;
  esac

  require_xcrun

  case "$cmd" in
    devices)
      cmd_devices "${2:-}"
      ;;
    send)
      udid="$(resolve_udid "${2:-}")"
      bundle="${3:-}"
      [[ -n "$bundle" ]] || die "Usage: $0 send <udid> <bundle> <file|->"
      stage_payload "${4:-}"
      push "$udid" "$bundle"
      ;;
    cold)
      udid="$(resolve_udid "${2:-}")"
      bundle="${3:-}"
      [[ -n "$bundle" ]] || die "Usage: $0 cold <udid> <bundle> <file|->"
      stage_payload "${4:-}"
      echo "-> terminating $bundle for a cold start"
      xcrun simctl terminate "$udid" "$bundle" > /dev/null 2>&1 || true
      sleep 1
      push "$udid" "$bundle"
      echo "-> the app starts from a killed state, so this test uses the cold-start path"
      ;;
    open)
      udid="$(resolve_udid "${2:-}")"
      [[ -n "${3:-}" ]] || die "Usage: $0 open <udid> <url>"
      echo "-> opening $3 on $udid. This test sends no push, and it tests the router only."
      xcrun simctl openurl "$udid" "$3"
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage 1
      ;;
  esac
}

main "$@"
