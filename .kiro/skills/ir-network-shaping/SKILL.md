---
name: ir-network-shaping
description: Degrade this Mac's network with pfctl and dnctl, so you can test an app on a bad network. Use it when the user asks to throttle the network, to add latency or packet loss, or to test offline behavior. Use it also to reproduce a bad-network bug on an iOS simulator or an Android emulator. Do not use it for a physical phone, because its traffic does not transit this Mac.
metadata:
  version: 2
---

# Network shaping

Apply and remove OS-level network shaping through [scripts/netshape.sh](./scripts/netshape.sh). The script owns every privileged action. This skill decides whether the work is meaningful, collects the user's choices, warns the user, and then confirms the result.

## How the shaping works

The script loads two dummynet rules into a private PF anchor, and it applies them to the default-route interface. The rules match traffic in both directions and send it through two shaped pipes.

Three facts control every decision in this skill:

- **Nothing is scoped to an app.** An iOS simulator uses the host network stack, so its packets are identical to a browser's packets. Every matched packet on the interface is shaped.
- **Loopback is excluded.** The script refuses `lo0`, and traffic to this Mac's own LAN address also routes through `lo0`. A Metro connection therefore stays at full speed.
- **The agent's own traffic is shaped too.** A severe profile makes this chat slow. A profile that drops all traffic stops the chat completely.

## Preflight checks

Run these four checks before you ask the user anything. None of them needs a password.

1. Confirm the platform is macOS, and confirm that `pfctl` and `dnctl` are present.
2. Confirm that `scripts/netshape.sh` and `scripts/with-sudo.sh` are executable.
3. Run `route -n get default` and read the interface. If no interface is found, stop and tell the user to set `IFACE`. If the interface is `lo0`, stop.
4. Run `netshape.sh check`. Exit code 10 means shaping is already active. Report the existing state and ask the user before you change it.

If the interface from check 3 is a `utun` device, a VPN holds the default route. Record that fact, because it changes the protocol question below.

Stop and report the cause if a check fails. Do not continue with a partial environment.

## User choices

Ask three questions. Give each option a short explanation. Keep every list in the order written here, and never move an option to the top because it is recommended.

Mark a recommended option for the profile and the protocol only. Both have a technically better answer. Duration does not, so recommend nothing there.

### Profile

Run `netshape.sh profiles` and build the list from that output. Keep the file's order, which runs from mildest to most severe. The table marks one row as recommended. Include `custom` as an option, and collect `BW`, `DELAY`, and `PLR` when the user selects it.

### Protocols

| Option                  | Explanation                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `tcp+udp` (recommended) | Shapes HTTP/3 and DNS as well, so no traffic escapes the test. |
| `tcp`                   | Leaves HTTP/3, DNS, and UDP VPN tunnels at full speed.         |

If a VPN holds the default route, say so in the question. Shaping UDP degrades the tunnel.

### Duration

Offer 5, 15, and 30 minutes, in that order, and let the user type an answer instead. Recommend none of them. How long someone needs is their decision, not one you can infer.

| Answer         | `AUTO_OFF_SECONDS`          |
| -------------- | --------------------------- |
| 5 minutes      | 300                         |
| 15 minutes     | 900                         |
| 30 minutes     | 1800                        |
| Anything typed | Convert it to whole seconds |

A user may type `1 minute`, `90 seconds`, or `2h`. Convert the value yourself. `AUTO_OFF_SECONDS` takes any non-negative integer, so no preset limits what you can pass. Never pass 0, because that disables the timer and removes the last recovery layer.

Explain that the timer is a backstop. The user can stop the shaping earlier, and the timer guarantees that the state clears without any further action.

The timer starts when `on` finishes, and `on` runs after the password dialog closes. The user therefore gets the whole window, however long they take at the dialog. Do not warn them that a slow answer shortens it.

One consequence: any wall-clock time you put in the brief is an estimate, because you compute it before the dialog opens. Compute the real expiry after `on` returns, and report that one in the postflight.

## The brief

Read [templates/preflight_brief.md](./templates/preflight_brief.md) and fill every field. Send the brief and wait for the user's approval.

Send the brief before you run the script. Under a profile that drops all traffic, the brief is the last message that reaches the user, because the agent loses its own connection.

Before you send the brief, run `netshape.sh measure baseline` to get the baseline connect time. Put that value in the brief.

Do not shorten the brief, and do not write your own. The template exists so the recovery command is never omitted.

## Start the shaping

You have no terminal, so sudo cannot prompt you. Use `with-sudo.sh`, which elevates once and runs the whole script as root. Give an absolute path for both files.

```
NETSHAPE_ASSUME_YES=1 PROTO=<proto> AUTO_OFF_SECONDS=<seconds> \
<skill>/scripts/with-sudo.sh \
  --prompt "netshape: applying <profile> on <iface>. This degrades all <proto> traffic on this Mac." \
  --env PROTO,AUTO_OFF_SECONDS,NETSHAPE_ASSUME_YES,NETSHAPE_STATE_DIR \
  -- <skill>/scripts/netshape.sh on <profile>
```

Three parts are required:

- `--prompt` is the text of the password dialog. Name the profile and the interface. That dialog is the user's last chance to cancel, so it must describe what is about to happen.
- `--env` forwards the variables. sudo strips the environment, so a variable that is not named here does not reach the script.
- `NETSHAPE_ASSUME_YES=1` skips a keyboard prompt that you can never answer.

Send this command exactly once. Running the script directly, without the wrapper, produces about seven password dialogs, because each subshell inside it authenticates separately.

Use the `on` command. Do not use the `run` command. `run` holds one process for the length of a test suite, which exceeds the tool timeout, and its output belongs in the user's terminal. The script also refuses `run` through the wrapper, because the user's command would execute as root. If the user wants a suite under shaping, give them the `run` command to paste instead.

`off` and `status` need the same wrapper. `check`, `profiles`, and `measure` need no root, so call them directly.

## Verify and report

When the profile drops all traffic, skip verification. No measurement is possible, and no report can reach the user. Stop after the invocation.

For every other profile:

1. Run `netshape.sh measure shaped`.
2. Compare the two measurements. The connect time should increase by at least twice the configured delay, because the delay applies per direction.
3. Report the result from [templates/postflight_active.md](./templates/postflight_active.md), with the expiry time recomputed from when `on` returned.

Treat twice the delay as a floor, not a target. A bandwidth cap queues packets, and your own traffic shares that queue, so a busy link can measure far above the prediction. A 3g run that predicts 200ms can measure 800ms and still be correct. Only an unchanged connect time means the traffic missed the pipes.

Do not call `status` here. `on` already verified the kernel state, and it would have failed loudly. `status` also needs root, so it costs the user a second password dialog for information you already have. Reserve `status` for a partial state you must diagnose.

A whole session should cost two dialogs: one for `on`, one for `off`.

If the state is active but the measurement did not change, the traffic is not passing through the pipes. Report that plainly. Do not claim that the shaping works.

Expect slow responses under a severe profile. The agent's own requests are shaped.

## Stop the shaping

When the user asks to stop the shaping, run `netshape.sh check` first.

- Exit code 0 means no state remains. Change nothing. Tell the user that the timer or an earlier stop already cleared it.
- Exit code 10 means state remains. Run `netshape.sh off`, then run `netshape.sh status` to confirm.

The check needs no password, so it costs the user nothing. Always run it first. A stop request may arrive after the timer already fired.

Report the result from [templates/postflight_cleared.md](./templates/postflight_cleared.md).

## Cautions

- A manually enabled Network Link Conditioner uses its own pipes. Its effect compounds with this shaping, and the measurement is the only signal. Mention this if a measurement is much slower than the profile predicts.
- Conductor runs agents in parallel, and the anchor, the pipes, and the state directory are shared per user. A second workspace that starts shaping replaces the first. Check state before you start, and tell the user when you find an existing session.
- A reboot clears all shaping, because the rules and the pipes are not persistent.

## Reference

| Command                  | Purpose                                               | Call it through     |
| ------------------------ | ----------------------------------------------------- | ------------------- |
| `on <profile>`           | Apply a profile and start the timer                   | `with-sudo.sh`      |
| `off`                    | Remove the rules, the pipes, and the token            | `with-sudo.sh`      |
| `status`                 | Full kernel state; exits 0 off, 10 active, 11 partial | `with-sudo.sh`      |
| `check`                  | Ownership test through the token file; exits 0 or 10  | Directly            |
| `profiles`               | Print the profile table                               | Directly            |
| `measure [label]`        | Log a TCP connect time                                | Directly            |
| `run <profile> -- <cmd>` | For the user and for CI, never for this skill         | Give it to the user |

Profiles live in [scripts/profiles.conf](./scripts/profiles.conf). Add a row to add a profile. The script and this skill both read that file, so the two never disagree.

[scripts/with-sudo.sh](./scripts/with-sudo.sh) is skill-agnostic. Its comment block documents the interface and the contract, so another MAACS skill that needs root can copy it.

The comment block at the top of [scripts/netshape.sh](./scripts/netshape.sh) documents every environment variable.
