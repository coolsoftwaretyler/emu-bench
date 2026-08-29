# Postflight: stopped

Send the message that matches what you found. Use one only.

## After `off` cleared the state

---

## Shaping is off

Normal connectivity is restored. `status` reports OFF.{measured}

---

## When `check` exits 0

Change nothing in this case.

---

## Already off

The auto-off timer or an earlier stop cleared it. I changed nothing.

Run `{script_path} status` for the full kernel state. That needs your password.

---

## When `status` exits 11

---

## Cleanup is incomplete

`status` reports PARTIAL. {partial_detail}

Run `{script_path} off` to reconcile.

---

## Fields

| Field | Condition | Text |
| --- | --- | --- |
| `{measured}` | A measurement exists | ` Connect time is back to {measured_ms}ms.` |
| `{measured}` | The profile dropped all traffic | Empty. No measurement ran. |
| `{partial_detail}` | Always | Name which half remains, from the `status` output. Report the rules and the pipes separately. Do not state a cause that the output does not show. |
