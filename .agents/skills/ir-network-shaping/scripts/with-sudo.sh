#!/bin/sh
#
# with-sudo.sh — let an AI agent run a command as root without seeing your password.
#
# --- Why this exists ---------------------------------------------------------
#
# An AI agent runs shell commands and reads their output. Some MAACS tasks need
# administrator rights. That creates one problem and one risk.
#
# The problem: sudo accepts a password only from a terminal. An agent has no
# terminal, so an agent can never answer a sudo prompt. The command fails.
#
# The risk: an obvious workaround is to give the password to the agent, and then
# the agent types it. Then your password is in the agent's conversation, in its
# logs, and in the record that its provider keeps. Never do this.
#
# This script removes both. It asks YOU for the password in a macOS dialog. The
# dialog belongs to your desktop, not to the agent. sudo reads your answer through
# a private channel of its own. The agent starts the command and reads its output,
# and the password never enters that output.
#
# --- How it works, in short --------------------------------------------------
#
# 1. The agent runs this script and gives it the command to run as root.
# 2. This script asks sudo to elevate.
# 3. sudo needs a password. sudo starts this same file a second time, in a second
#    mode, for the only purpose of getting one.
# 4. That second copy shows you a macOS dialog. The dialog names the task, so you
#    can see what you approve. Cancel it and nothing runs.
# 5. You type your password. The second copy gives it to sudo. sudo made the
#    channel that carries it, and that channel does not reach the agent.
# 6. sudo runs the command as root. The agent sees only what the command prints.
# 7. This script then clears the sudo ticket. Your approval covers that one
#    command, and it does not remain valid for the next few minutes.
#
# You keep control at step 4. Read the dialog. If the text does not match the task
# you expect, cancel it.
#
# --- Why the command runs as root, and not each step -------------------------
#
# This script elevates once and runs the WHOLE command as root. It does not
# elevate each privileged step inside that command.
#
# The reason is that sudo remembers your approval per terminal. With no terminal,
# sudo remembers it per process instead. A shell script starts a new process for
# every pipeline, every `$(...)`, and every background job, so each of those asks
# again. A script with a dozen privileged steps would show you a dozen dialogs.
# One elevation, one dialog, however much work the command does.
#
#   ./with-sudo.sh --prompt "Network shaping needs admin rights." -- ./netshape.sh on 3g
#
# --- Interface ---------------------------------------------------------------
#
# --prompt <text>       Required. The dialog message. Name the task and its effect.
#                       This dialog is the user's last chance to cancel.
# --env VAR[,VAR...]    Forward these variables to the target. sudo removes the
#                       environment by default (env_reset), so name every variable
#                       that the target needs.
# --keep-credential     Do not clear the sudo ticket after the target exits. Use it
#                       when a second command follows immediately.
# -- <command> [args]   The target. Required, and must come after --.
#
# Returns the target's exit code. The target inherits stdin, stdout, and stderr.
# Exits 2 for a usage error in this wrapper itself.
#
# --- Contract for the target script ------------------------------------------
#
# Your script runs as root. In exchange for one prompt, obey four rules:
#
#   1. Do not call sudo yourself. You are already root, and each call would ask
#      again, which is the problem this wrapper removes.
#   2. Use $SUDO_UID and $SUDO_USER to identify the real user. `id -u` returns 0.
#   3. Chown anything you create that the user must read later. Files you write
#      belong to root, and the user cannot read a root-owned file at mode 600.
#   4. Drop back before you run a user's command:
#        sudo -u "#$SUDO_UID" -- npm test
#      If you do not, you leave root-owned files in their project.
#
# --- One limit to know -------------------------------------------------------
#
# The agent does not see your password, but the agent does choose the command that
# runs as root. It also has write access to this file. This design keeps the secret
# away from the agent. It does not prevent the agent from changing the design. For
# a stronger boundary, give the target binaries a NOPASSWD rule in /etc/sudoers.d
# and no password exists at any point.
#
set -eu

# --- Askpass mode ------------------------------------------------------------
# This is step 3 above. sudo started this file to get a password. Show the dialog,
# print the answer, and exit. sudo reads that answer through its own channel, so
# the answer does not reach the process that started this script.
if [ -n "${MAACS_SUDO_ASKPASS:-}" ]; then
  MESSAGE="${MAACS_SUDO_PROMPT:-A MAACS skill needs administrator rights.}"
  # Escape each double quote, so the message cannot break the AppleScript literal.
  MESSAGE="$(printf '%s' "$MESSAGE" | sed 's/"/\\"/g')"

  exec /usr/bin/osascript \
    -e "display dialog \"$MESSAGE\" with title \"MAACS\" default answer \"\" with hidden answer with icon caution" \
    -e 'text returned of result'
fi

# --- Wrapper mode ------------------------------------------------------------
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

PROMPT=""
FORWARD=""
KEEP_CREDENTIAL=0

die() {
  echo "with-sudo: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prompt)
      [ "$#" -ge 2 ] || die "--prompt needs a value"
      PROMPT="$2"
      shift 2
      ;;
    --env)
      [ "$#" -ge 2 ] || die "--env needs a value"
      FORWARD="$2"
      shift 2
      ;;
    --keep-credential)
      KEEP_CREDENTIAL=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *) die "unknown option: $1 (put the command after --)" ;;
  esac
done

[ -n "$PROMPT" ] || die "--prompt is required, so the dialog says who is asking"
[ "$#" -gt 0 ] || die "no command given (usage: --prompt <text> -- <command> [args...])"

# Prepend each forwarded variable as a NAME=VALUE argument. Prepending keeps the
# quoting intact, so a value containing spaces survives. Their order is irrelevant.
if [ -n "$FORWARD" ]; then
  OLD_IFS="$IFS"
  IFS=','
  for name in $FORWARD; do
    IFS="$OLD_IFS"
    [ -n "$name" ] || continue
    eval "value=\${$name:-}"
    set -- "$name=$value" "$@"
    IFS=','
  done
  IFS="$OLD_IFS"
fi

set -- /usr/bin/env "$@"

# Already root: no elevation, no prompt, and no ticket to revoke.
if [ "$(id -u)" -eq 0 ]; then
  exec "$@"
fi

if [ -t 0 ]; then
  # With a terminal, sudo prompts there and keys its ticket to that terminal,
  # which every subshell shares. One prompt, no helper needed.
  set -- sudo "$@"
else
  [ -x "$SELF" ] || die "cannot use the askpass helper: $SELF is not executable"
  MAACS_SUDO_ASKPASS=1
  MAACS_SUDO_PROMPT="$PROMPT"
  SUDO_ASKPASS="$SELF"
  export MAACS_SUDO_ASKPASS MAACS_SUDO_PROMPT SUDO_ASKPASS
  set -- sudo -A "$@"
fi

STATUS=0
"$@" || STATUS=$?

# Drop the ticket, so one authentication does not leave passwordless root behind
# for the next few minutes.
if [ "$KEEP_CREDENTIAL" -eq 0 ]; then
  sudo -K > /dev/null 2>&1 || true
fi

exit "$STATUS"
