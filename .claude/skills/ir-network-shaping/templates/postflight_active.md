# Postflight: active

Send this after the second measurement completes.

Compute `{wallclock}` from the moment `on` returned, plus the timer. Do not reuse the estimate from the brief, which you made before the password dialog opened.

## Message

---

## Shaping is active

- **{profile}** on {iface} — {bw}, {delay}ms each way, {plr} loss, {proto}.
- {result_line}
- Auto-off at {wallclock}.

Stop early with `{script_path} off`, or ask me.

---

## Fields

| Field | Condition | Text |
| --- | --- | --- |
| `{result_line}` | Connect time rose | `Verified: connect time {baseline_ms}ms to {measured_ms}ms.` |
| `{result_line}` | Connect time did not change | `**Not verified.** Connect time is {measured_ms}ms against a {baseline_ms}ms baseline, so the traffic misses the pipes. Check the default route, or a target on HTTP/3 while the protocol is tcp only.` |

A rise well above twice the delay is still a pass. A bandwidth cap queues packets, and your own traffic shares that queue, so a busy link measures high. Report "not verified" only when the connect time did not change.
