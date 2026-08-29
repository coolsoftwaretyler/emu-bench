#!/usr/bin/env bash
#
# netshape.sh — degrade the Mac's network at the OS layer for bad-network testing.
#
# Uses pfctl + dnctl (dummynet) — the same engine behind Network Link Conditioner —
# so it reproduces real latency + packet loss across ALL traffic, including the native
# SDK traffic (analytics, push, auth, feature flags) that the JS layer never sees.
#
# Scoped to the egress interface only, so the iOS simulator's loopback link to Metro
# (lo0) is left untouched and dev fast-refresh stays responsive. Traffic to this Mac's
# own LAN address routes over lo0 too, so a packager URL like 192.168.1.5:8081 is
# also spared.
#
# Only traffic that transits THIS Mac is affected — simulators, emulators, and host
# apps. A physical phone on its own wifi or cellular link sees nothing.
#
#   ./netshape.sh on very-bad              # apply a profile
#   ./netshape.sh run 3g -- npm test       # apply, run a command, always restore
#   ./netshape.sh off                      # restore normal networking
#   ./netshape.sh status                   # show current state
#   ./netshape.sh check                    # is it ours? no root needed
#   ./netshape.sh profiles                 # print the profile table
#   ./netshape.sh measure baseline         # log a TCP connect time
#
# Profiles: see profiles.conf beside this script, or run `profiles`. Use `custom`
# with BW/DELAY/PLR env vars for anything the table does not list.
#
# WARNING (local/manual use): while active this degrades ALL matched traffic on the
# egress interface -- your browser, Slack, calls, git, downloads -- until `off` runs.
# The `offline` profile makes them fail outright, including any AI agent that invoked
# this script. A deadman timer runs by default; a reboot also clears the rules.
#
# --- Getting root ------------------------------------------------------------
#
# `on`, `off`, and `status` need root. From a terminal, sudo prompts you once and
# keys its ticket to that terminal, so plain invocation works:
#
#   ./netshape.sh on very-bad
#
# A caller with no terminal -- an AI agent, a CI shell -- cannot answer a sudo
# prompt at all, so it goes through the wrapper beside this script, which elevates
# once and runs this whole script as root:
#
#   ./with-sudo.sh --prompt "..." --env PROTO,AUTO_OFF_SECONDS -- ./netshape.sh on 3g
#
# Either way this script authenticates ONCE. It reads SUDO_UID to find the real
# user, so its state directory and token still belong to you and not to root.
#
# Do not send `run` through the wrapper. That command executes your command in this
# process, which would make it run as root.
#
# --- Environment -------------------------------------------------------------
#
# IFACE=en0
#   Egress interface. Auto-detected from the default route; set it when the guess is
#   wrong, e.g. a dock on en8, or a VPN holding the default route on a utun.
#
# PROTO=tcp+udp | tcp
#   Which protocols to shape. Defaults to tcp+udp, because TCP alone leaves HTTP/3
#   (QUIC, over UDP) and DNS at full speed -- an API on HTTP/3 sails through
#   untouched while the banner claims shaping is active, which is the worst failure
#   a test tool can have. Use PROTO=tcp when a UDP VPN tunnel or a video call has to
#   survive the test.
#
# BW= DELAY= PLR=
#   Required for the `custom` profile, ignored otherwise. bw accepts dnctl units
#   (1Mbit/s, 780Kbit/s). delay is per-direction in whole ms and is applied to both
#   pipes, so the round trip gains ~2x. plr is a loss rate 0.0-1.0, also per
#   direction, so a request and its reply compound (0.10 each way is about 19%).
#   Example: BW=512Kbit/s DELAY=400 PLR=0.1
#
# AUTO_OFF_SECONDS=600
#   Deadman timer. The shaping lives in the kernel, not in your shell, so a closed
#   terminal or a dead script leaves your Mac slow with nothing on screen to say why.
#   A background root process removes everything after N seconds. Defaults to 600 for
#   `on` and 3600 for `run` -- `run` already cleans up on exit, interrupt, and
#   terminate, so there the timer is only a backstop for a hard kill. 0 disables it.
#
# PROFILES_FILE=/path/to/profiles.conf
#   Override the profile table. Useful in CI when the table is checked in elsewhere.
#
# MEASURE_URL=http://connectivitycheck.gstatic.com/generate_204
#   Target for `measure`. A captive-portal endpoint: tiny, unauthenticated, and
#   plain http, so time_connect reports the TCP handshake with no TLS in the way.
#
# NETSHAPE_ASSUME_YES=1
#   Skip the interactive confirmation on the `offline` profile. Required for any
#   caller with no tty, since that prompt reads from the keyboard. CI=true is
#   equivalent.
#
# NETSHAPE_STATE_DIR=/path
#   Where the pf token and the measurement log live. Defaults to /tmp/maacs-netshape-
#   <your uid>, and must be a real directory you own at mode 700. The path is fixed
#   rather than TMPDIR-relative on purpose: sudo resets TMPDIR, so a TMPDIR-based
#   default would put the root half and the user half in different directories.
#
# --- Exit codes --------------------------------------------------------------
#
# status: 0 off, 10 active, 11 partial (run `off` to reconcile)
# check:  0 not ours, 10 ours -- reads the token file only, so it needs no root
#
# Requires macOS, pfctl, dnctl, and profiles.conf. Copy the directory, not the file.
#
set -euo pipefail

PATH="/usr/sbin:/sbin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ANCHOR="com.apple/maacs-netshape"
PIPE_IN=19001
PIPE_OUT=19002

# Resolved per command: 'on' is a human session, 'run' is bounded by a process.
AUTO_OFF_DEFAULT_ON=600
AUTO_OFF_DEFAULT_RUN=3600
AUTO_OFF_SECONDS="${AUTO_OFF_SECONDS:-}"

PROTO="${PROTO:-tcp+udp}"
PROFILES_FILE="${PROFILES_FILE:-$SCRIPT_DIR/profiles.conf}"
MEASURE_URL="${MEASURE_URL:-http://connectivitycheck.gstatic.com/generate_204}"

# The invoking user, not the effective one. Under with-sudo.sh this script runs as
# root, so `id -u` returns 0. Every piece of user-visible state -- the state dir,
# its owner, the token file -- has to key off the real user instead, or `check`
# and `off` stop finding what `on` created.
OWNER_UID="${SUDO_UID:-$(id -u)}"

# A fixed path, deliberately not TMPDIR-relative. sudo resets TMPDIR, so a root-side
# default and a user-side default resolve differently and the two halves lose each
# other: `on` writes its token somewhere `check` never looks. The ownership and mode
# checks in init_state_dir are what make a shared /tmp safe.
STATE_DIR="${NETSHAPE_STATE_DIR:-/tmp/maacs-netshape-$OWNER_UID}"
STATE_TOKEN_FILE="$STATE_DIR/pf-enable-token"
MEASURE_LOG="$STATE_DIR/measurements.log"

# Interface: auto-detect the default route, override with IFACE=en0 ./netshape.sh ...
IFACE="${IFACE:-}"

# Privileged commands run directly when this script is already root, which is how
# with-sudo.sh invokes it. The sudo fallback is for a person running this straight
# from a terminal, where sudo keys its ticket to the shared tty and prompts once.
as_root() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_root_access() {
  [[ "$EUID" -eq 0 ]] && return 0
  # A NOPASSWD sudoers rule or a warm ticket needs no terminal, so try the quiet
  # path first. A CI job usually lands here.
  sudo -n -v 2> /dev/null && return 0
  [[ -t 0 ]] || die "This command needs root, and sudo cannot ask without a terminal. Run it from a terminal, through with-sudo.sh, or with a NOPASSWD rule for pfctl and dnctl."
  sudo -v
}

die() {
  echo "Error: $*" >&2
  exit 1
}

init_state_dir() {
  mkdir -p "$STATE_DIR"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || die "Unsafe state dir: $STATE_DIR"
  # Running as root, anything created here belongs to root. Give it back, so the
  # user can still run `check` without a password.
  if [[ "$EUID" -eq 0 && "$OWNER_UID" != "0" ]]; then
    chown -R "$OWNER_UID" "$STATE_DIR" || die "Could not reassign state dir: $STATE_DIR"
  fi
  [[ "$(stat -f '%u' "$STATE_DIR")" == "$OWNER_UID" ]] || die "State dir must be owned by uid $OWNER_UID: $STATE_DIR"
  chmod 700 "$STATE_DIR" || die "Could not secure state dir: $STATE_DIR"
}

# --- Profiles ---------------------------------------------------------------
# delay is per-direction in ms; applied to both in and out, so RTT gains ~2x.
# bw accepts dnctl units (e.g. 1Mbit/s, 780Kbit/s); plr is loss rate 0.0–1.0.
# The table lives in profiles.conf so the script and the skill read one source.
require_profiles_file() {
  [[ -r "$PROFILES_FILE" ]] \
    || die "Profile table not found: $PROFILES_FILE (copy the whole directory, not just this script)"
}

profile_names() {
  awk -F'|' '!/^#/ && NF { printf "%s%s", sep, $1; sep="|" }' "$PROFILES_FILE"
}

profile() {
  if [[ "$1" == "custom" ]]; then
    BW="${BW:?set BW}"
    DELAY="${DELAY:?set DELAY}"
    PLR="${PLR:?set PLR}"
    return 0
  fi

  require_profiles_file

  local name bw delay plr rec desc
  while IFS='|' read -r name bw delay plr rec desc; do
    if [[ -n "$name" && "$name" != \#* && "$name" == "$1" ]]; then
      BW="$bw"
      DELAY="$delay"
      PLR="$plr"
      return 0
    fi
  done < "$PROFILES_FILE"

  echo "Unknown profile: $1 (use custom, or one of: $(profile_names))" >&2
  exit 1
}

validate_profile_values() {
  [[ "$BW" =~ ^[1-9][0-9]*([KMG])?(bit/s|Byte/s)$ ]] \
    || die "Invalid BW '$BW' (example: 1Mbit/s, 780Kbit/s)"
  [[ "$DELAY" =~ ^[0-9]+$ ]] \
    || die "Invalid DELAY '$DELAY' (must be whole milliseconds)"
  [[ "$PLR" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]] \
    || die "Invalid PLR '$PLR' (must be 0.0 through 1.0)"
  [[ "$AUTO_OFF_SECONDS" =~ ^[0-9]+$ ]] \
    || die "Invalid AUTO_OFF_SECONDS '$AUTO_OFF_SECONDS' (use 0 to disable)"
  [[ "$PROTO" == "tcp" || "$PROTO" == "tcp+udp" ]] \
    || die "Invalid PROTO '$PROTO' (use tcp or tcp+udp)"
}

drops_everything() {
  [[ "$PLR" == "1" || "$PLR" == "1.0" ]]
}

banner() {
  printf '\n\033[33m🐌 NETWORK SHAPING ACTIVE\033[0m  iface=%s  profile=%s  (bw=%s delay=%sms loss=%s proto=%s)\n' \
    "$IFACE" "$1" "$BW" "$DELAY" "$PLR" "$PROTO"
  printf '   Affects %s in/out on %s via PF anchor %s.\n' "$PROTO" "$IFACE" "$ANCHOR"
  printf '   Only traffic that transits this Mac: simulators, emulators, host apps.\n'
  printf '   A physical phone on its own wifi or cellular link is NOT affected.\n'
  if drops_everything; then
    printf '   \033[31mThis profile drops ALL matched traffic. Every remote service fails.\033[0m\n'
  fi
  if [[ "$AUTO_OFF_SECONDS" -gt 0 ]]; then
    printf '   Auto-off scheduled after %ss. Run \033[1m%s off\033[0m to restore sooner.\n\n' "$AUTO_OFF_SECONDS" "$0"
  else
    printf '   Auto-off disabled. Run \033[1m%s off\033[0m to restore.\n\n' "$0"
  fi
}

require_iface() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This script only supports macOS/dnctl"
  if [[ -z "$IFACE" ]]; then
    IFACE="$(route -n get default 2> /dev/null | awk '/interface:/{print $2}' || true)"
  fi
  [[ -n "$IFACE" ]] || die "Could not detect an egress interface. Set one explicitly: IFACE=en0 $0 ..."
  [[ "$IFACE" =~ ^[A-Za-z0-9_.:-]+$ ]] || die "Unsafe interface name: $IFACE"
  [[ "$IFACE" != "lo0" ]] || die "Refusing to shape lo0; that would break simulator<->Metro loopback"
  if ! ifconfig -l | tr ' ' '\n' | grep -Fxq "$IFACE"; then
    die "Interface '$IFACE' was not found. Available: $(ifconfig -l)"
  fi
}

confirm_profile() {
  local p="$1"
  [[ "${CI:-}" == "true" || "${NETSHAPE_ASSUME_YES:-}" == "1" ]] && return
  drops_everything || return 0

  [[ -t 0 ]] || die "Refusing non-interactive all-drop profile without CI=true or NETSHAPE_ASSUME_YES=1"
  printf 'Profile "%s" drops all matched traffic on %s. Type OFFLINE to continue: ' "$p" "$IFACE" >&2
  local answer
  read -r answer
  [[ "$answer" == "OFFLINE" ]] || die "Canceled"
}

proto_clause() {
  case "$PROTO" in
    tcp) echo "proto tcp" ;;
    tcp+udp) echo "proto { tcp udp }" ;;
  esac
}

pf_rules() {
  local p
  p="$(proto_clause)"
  cat << EOF
dummynet in  quick on $IFACE $p from any to any pipe $PIPE_IN
dummynet out quick on $IFACE $p from any to any pipe $PIPE_OUT
EOF
}

check_pf_rules() {
  pf_rules | as_root pfctl -n -a "$ANCHOR" -f - > /dev/null
}

load_pf_rules() {
  pf_rules | as_root pfctl -a "$ANCHOR" -f - > /dev/null
}

anchor_dummynet_rules() {
  as_root pfctl -a "$ANCHOR" -s dummynet 2> /dev/null | awk 'tolower($0) != "no dummynet"' || true
}

owned_pipe_state() {
  as_root dnctl pipe show "$PIPE_IN" "$PIPE_OUT" 2> /dev/null || true
}

flush_pf_anchor() {
  as_root pfctl -a "$ANCHOR" -F all > /dev/null 2>&1 || true
}

delete_owned_pipes() {
  as_root dnctl -q pipe delete "$PIPE_IN" "$PIPE_OUT" > /dev/null 2>&1 || true
}

release_pf_token() {
  [[ -f "$STATE_TOKEN_FILE" ]] || return 0

  local token
  token="$(< "$STATE_TOKEN_FILE")"
  if [[ "$token" =~ ^[0-9]+$ ]]; then
    as_root pfctl -X "$token" > /dev/null 2>&1 || true
  fi
  rm -f "$STATE_TOKEN_FILE"
}

cleanup_owned_state() {
  init_state_dir
  flush_pf_anchor
  delete_owned_pipes
  release_pf_token
}

verify_inactive() {
  local rules pipes
  rules="$(anchor_dummynet_rules)"
  pipes="$(owned_pipe_state)"

  if [[ -n "$rules" || -n "$pipes" ]]; then
    echo "Error: shaping cleanup is incomplete." >&2
    echo "--- remaining anchor dummynet rules ---" >&2
    if [[ -n "$rules" ]]; then
      echo "$rules" >&2
    else
      echo "(none)" >&2
    fi
    echo "--- remaining owned dummynet pipes ---" >&2
    if [[ -n "$pipes" ]]; then
      echo "$pipes" >&2
    else
      echo "(none)" >&2
    fi
    return 1
  fi
}

configure_pipes() {
  delete_owned_pipes
  if [[ "$DELAY" -eq 0 ]]; then
    as_root dnctl pipe "$PIPE_IN" config bw "$BW" plr "$PLR"
    as_root dnctl pipe "$PIPE_OUT" config bw "$BW" plr "$PLR"
  else
    as_root dnctl pipe "$PIPE_IN" config bw "$BW" delay "$DELAY" plr "$PLR"
    as_root dnctl pipe "$PIPE_OUT" config bw "$BW" delay "$DELAY" plr "$PLR"
  fi
}

enable_pf_with_token() {
  local output token
  if ! output="$(as_root pfctl -E 2>&1)"; then
    echo "$output" >&2
    return 1
  fi

  token="$(printf '%s\n' "$output" | sed -n 's/.*Token[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  if [[ -z "$token" ]]; then
    echo "Error: could not read pfctl -E token from output: $output" >&2
    return 1
  fi
  printf '%s\n' "$token" > "$STATE_TOKEN_FILE"
  # Written after init_state_dir ran its chown, so hand this one back explicitly.
  if [[ "$EUID" -eq 0 && "$OWNER_UID" != "0" ]]; then
    chown "$OWNER_UID" "$STATE_TOKEN_FILE"
  fi
}

verify_active() {
  local rules pipes
  rules="$(anchor_dummynet_rules)"
  pipes="$(owned_pipe_state)"

  if [[ -z "$rules" || -z "$pipes" ]]; then
    echo "Error: shaping did not verify after activation." >&2
    echo "--- expected dummynet rules ---" >&2
    pf_rules >&2
    echo "--- observed anchor dummynet rules ---" >&2
    if [[ -n "$rules" ]]; then
      echo "$rules" >&2
    else
      echo "(none)" >&2
    fi
    echo "--- observed owned dummynet pipes ---" >&2
    if [[ -n "$pipes" ]]; then
      echo "$pipes" >&2
    else
      echo "(none)" >&2
    fi
    return 1
  fi
}

schedule_auto_off() {
  [[ "$AUTO_OFF_SECONDS" -gt 0 ]] || return 0
  [[ -f "$STATE_TOKEN_FILE" ]] || return 0

  local token
  token="$(< "$STATE_TOKEN_FILE")"
  [[ "$token" =~ ^[0-9]+$ ]] || return 0

  # The token check makes a stale timer harmless: an explicit `off` removes the
  # file, and a later `on` writes a new token, so this exits without acting.
  local deadman='
      sleep "$1"
      [ -f "$6" ] || exit 0
      [ "$(cat "$6" 2>/dev/null)" = "$5" ] || exit 0
      /sbin/pfctl -a "$2" -F all >/dev/null 2>&1 || true
      /usr/sbin/dnctl -q pipe delete "$3" "$4" >/dev/null 2>&1 || true
      /sbin/pfctl -X "$5" >/dev/null 2>&1 || true
      rm -f "$6"
  '

  # One branch, because as_root already resolved privilege. The forked process
  # inherits root and keeps it for its whole life, including through the sleep,
  # so nothing that happens to the parent's sudo ticket can disarm it.
  as_root /bin/sh -c "$deadman" sh \
    "$AUTO_OFF_SECONDS" "$ANCHOR" "$PIPE_IN" "$PIPE_OUT" "$token" "$STATE_TOKEN_FILE" &
  local watchdog_pid=$!

  # Give the fork a moment to reach root before the caller's ticket goes away.
  local i=0
  while [[ "$i" -lt 20 ]]; do
    [[ "$(ps -o user= -p "$watchdog_pid" 2> /dev/null | tr -d '[:space:]')" == "root" ]] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  echo "Warning: could not confirm the auto-off process reached root." >&2
}

cmd_on() {
  local p="${1:-}"
  [[ -z "$p" ]] && {
    echo "Usage: $0 on <profile>" >&2
    exit 1
  }
  AUTO_OFF_SECONDS="${AUTO_OFF_SECONDS:-$AUTO_OFF_DEFAULT_ON}"
  profile "$p"
  validate_profile_values
  require_iface
  confirm_profile "$p"
  require_root_access
  init_state_dir

  local success=0
  local current_step="starting"
  rollback() {
    local rc=$?
    echo "Error: failed while $current_step (exit $rc); cleaning up this script's partial shaping state." >&2
    if [[ "$success" -ne 1 ]]; then
      cleanup_owned_state
    fi
    exit "$rc"
  }
  trap rollback ERR INT TERM

  current_step="checking PF dummynet rule syntax"
  check_pf_rules
  current_step="clearing stale state owned by this script"
  cleanup_owned_state
  current_step="configuring dummynet pipes"
  configure_pipes
  current_step="loading PF dummynet anchor"
  load_pf_rules
  current_step="enabling PF with a releasable token"
  enable_pf_with_token
  current_step="verifying activation"
  verify_active
  current_step="scheduling auto-off"
  schedule_auto_off

  success=1
  trap - ERR INT TERM

  banner "$p"
}

cmd_off() {
  require_root_access
  cleanup_owned_state
  verify_inactive
  echo "✅ Network shaping cleared — normal connectivity restored."
}

cmd_status() {
  init_state_dir
  require_iface
  require_root_access
  echo "Interface: ${IFACE:-<none detected>}"
  echo "PF anchor: $ANCHOR"
  echo "Pipes: $PIPE_IN(in), $PIPE_OUT(out)"
  echo "Protocols: $PROTO"
  echo "--- pf ---"
  as_root pfctl -s info 2> /dev/null | head -n 1 || true
  echo "--- anchor dummynet rules ---"
  local rules
  rules="$(anchor_dummynet_rules)"
  if [[ -n "$rules" ]]; then
    echo "$rules"
  else
    echo "(none)"
  fi
  echo "--- owned dummynet pipes ---"
  local pipes
  pipes="$(owned_pipe_state)"
  if [[ -n "$pipes" ]]; then
    echo "$pipes"
  else
    echo "(none)"
  fi
  echo "--- status ---"
  if [[ -n "$rules" && -n "$pipes" ]]; then
    echo "🐌 shaping is ACTIVE"
    exit 10
  elif [[ -n "$rules" || -n "$pipes" ]]; then
    echo "⚠️  shaping state is PARTIAL; run $0 off"
    exit 11
  else
    echo "✅ shaping is OFF"
    exit 0
  fi
}

# Cheap ownership test. The token file is userland state, written by `on` and
# removed by both `off` and the auto-off timer, so this answers "did cleanup
# already happen" without sudo and without a password prompt.
cmd_check() {
  if [[ -f "$STATE_TOKEN_FILE" ]]; then
    echo "🐌 this script owns shaping state (token file present)"
    echo "Run '$0 off' to restore, or '$0 status' for detail."
    exit 10
  fi
  echo "✅ no shaping state owned by this script"
  exit 0
}

cmd_profiles() {
  require_profiles_file
  printf '%-10s %-12s %8s %6s %4s  %s\n' NAME BANDWIDTH DELAY LOSS REC DESCRIPTION
  awk -F'|' '!/^#/ && NF {
    printf "%-10s %-12s %6sms %6s %4s  %s\n", $1, $2, $3, $4, ($5 == "*" ? "*" : ""), $6
  }' "$PROFILES_FILE"
  printf '%-10s %-12s %8s %6s %4s  %s\n' custom 'BW=' 'DELAY=' 'PLR=' '' 'Values from environment variables'
}

# TCP connect time against a captive-portal endpoint. Run it once before shaping
# and once after: the delta should be about twice the configured delay, because
# the delay applies per direction. Under an all-drop profile it times out, and
# that timeout is the expected result.
cmd_measure() {
  init_state_dir
  local label="${1:-unlabeled}" reading
  reading="$(curl -s -o /dev/null -w '%{time_connect} %{http_code}' \
    --max-time 15 "$MEASURE_URL" 2> /dev/null || echo 'timeout -')"
  printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$label" "$reading" \
    | tee -a "$MEASURE_LOG"
}

cmd_run() {
  local p="${1:-}"
  [[ -n "$p" ]] || {
    echo "Usage: $0 run <profile> -- <command...>" >&2
    exit 1
  }
  shift
  [[ "${1:-}" == "--" ]] && shift
  [[ "$#" -gt 0 ]] || {
    echo "Usage: $0 run <profile> -- <command...>" >&2
    exit 1
  }

  AUTO_OFF_SECONDS="${AUTO_OFF_SECONDS:-$AUTO_OFF_DEFAULT_RUN}"

  # `run` executes the caller's command in this process. If something elevated us
  # first, that command would run as root and leave root-owned files behind in the
  # caller's project. Refuse, rather than guess at their login environment.
  if [[ "$EUID" -eq 0 && "$OWNER_UID" != "0" ]]; then
    die "Do not send 'run' through with-sudo.sh; your command would execute as root. Run it straight from a terminal."
  fi

  cmd_on "$p"

  local cleaned=0
  cleanup_once() {
    if [[ "$cleaned" -eq 0 ]]; then
      cleaned=1
      cmd_off
    fi
  }
  cleanup_and_resignal() {
    local signal="$1"
    trap - EXIT INT TERM
    cleanup_once
    kill -s "$signal" "$$"
  }
  trap cleanup_once EXIT
  trap 'cleanup_and_resignal INT' INT
  trap 'cleanup_and_resignal TERM' TERM

  set +e
  "$@"
  local rc=$?
  set -e

  trap - EXIT INT TERM
  cleanup_once
  return "$rc"
}

usage() {
  cat << EOF
netshape.sh — OS-level network shaping for bad-network testing (macOS)

Usage:
  $0 on <profile>     Apply a profile, with a deadman timer
  $0 run <profile> -- <command...>
                       Apply a profile around a command, then always clean up
  $0 off              Restore normal networking
  $0 status           Show current state (exit 0 off, 10 active, 11 partial)
  $0 check            Cheap ownership test; no root required
  $0 profiles         Print the profile table
  $0 measure [label]  Log a TCP connect time to the state dir

Profiles:
$(if [[ -r "$PROFILES_FILE" ]]; then cmd_profiles | sed 's/^/  /'; else echo "  (profiles.conf not found at $PROFILES_FILE)"; fi)

Env:
  IFACE=en0           Override the egress interface (default: auto-detected = ${IFACE:-?})
  PROTO=tcp+udp       Protocols to shape; 'tcp' leaves HTTP/3, DNS, and UDP VPNs alone
  BW=, DELAY=, PLR=   Required for the 'custom' profile (e.g. BW=2Mbit/s DELAY=300 PLR=0.05)
  AUTO_OFF_SECONDS=600
                       Deadman timer; 600 for 'on', 3600 for 'run'; set 0 to disable
  PROFILES_FILE=path  Override the profile table
  MEASURE_URL=url     Target for 'measure'
  NETSHAPE_ASSUME_YES=1
                       Allow an all-drop profile without an interactive prompt

See the comment block at the top of this file for every variable in full.

Root: 'on', 'off', and 'status' need it. From a terminal sudo prompts you once. A
caller with no terminal uses with-sudo.sh beside this script. Never send 'run'
through with-sudo.sh; your command would execute as root.

Examples:
  $0 on very-bad
  $0 run 3g -- npm test
  IFACE=en8 $0 on 3g
  BW=512Kbit/s DELAY=400 PLR=0.1 $0 on custom
  $0 off
EOF
}

case "${1:-}" in
  on)
    shift
    cmd_on "$@"
    ;;
  run)
    shift
    cmd_run "$@"
    ;;
  off) cmd_off ;;
  status) cmd_status ;;
  check) cmd_check ;;
  profiles) cmd_profiles ;;
  measure)
    shift
    cmd_measure "$@"
    ;;
  "" | -h | --help | help) usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    exit 1
    ;;
esac
