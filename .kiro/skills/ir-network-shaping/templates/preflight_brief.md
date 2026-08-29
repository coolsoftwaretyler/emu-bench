# Preflight brief

Send this before you run the script. Wait for approval.

Under a profile that drops all traffic, this is the last message the user receives. Send it complete. Keep it short, because the user skims it.

## Message

---

## Degrading your network

- **{profile}** — {bw}, {delay}ms each way (about {rtt}ms round trip), {plr} loss, {proto} on {iface}.
- Auto-off {minutes} min after you approve.

Everything on this Mac slows down: browser, Slack, calls, git, installs.{proto_note}

Stop early from your terminal:

```
{script_path} off
```

{status_line}

A password dialog opens next. Cancel it to abort. Reply to approve.

---

## Fields

| Field | Condition | Text |
| --- | --- | --- |
| `{proto_note}` | `{proto}` is `tcp+udp` | ` DNS, HTTP/3, VPN tunnels, and video calls degrade as well.` |
| `{proto_note}` | `{proto}` is `tcp` | ` HTTP/3 and DNS stay fast, so an HTTP/3 API is untouched.` |
| `{status_line}` | Loss is below 1.0 | `Baseline connect time is {baseline_ms}ms. I measure again after activation.` |
| `{status_line}` | Loss is 1.0 | `**This chat stops responding.** I cannot reach my API, so I cannot measure or report. Use the command above, or wait {minutes} min.` |

Add nothing else. The recovery command and the loss warning are the two lines that must never be absent.
