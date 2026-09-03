# ir-network-shaping

This skill degrades your Mac's network so that you can test an app on a bad network. It is for a developer who must see how an app behaves with high latency, packet loss, low bandwidth, or no connection at all.

The skill drives `scripts/netshape.sh`, which uses `pfctl` and `dnctl`. Those are the same tools behind Network Link Conditioner, so the shaping happens in the kernel. Native SDK traffic is degraded together with JavaScript traffic.

## When to use it

Use this skill when you want to test an app under a poor network on an iOS simulator or an Android emulator. Both use your Mac's network stack, so their traffic is shaped.

Do not use it for a physical phone. A phone uses its own wifi or cellular link, so nothing that this skill does reaches the app.

## How to use it

Ask your agent to start the shaping:

> Throttle my network to a very bad connection so I can test the checkout screen.

The agent asks you three questions: which profile, which protocols, and for how long. It then sends a brief that states what will break and how to recover. Approve the brief, and a password dialog opens. Cancel that dialog to abort.

Ask the agent to stop the shaping when you finish. You can also stop it yourself, and a timer stops it for you.

## What it produces

The skill applies the shaping, confirms that real traffic is affected, and reports the measured result. It gives you a recovery command that works in your own terminal with no agent and no network.

## Important

While the shaping is active, **your whole Mac is affected**. Your browser, Slack, video calls, `git`, and package installs all degrade. The `offline` profile makes them fail.

The `offline` profile also stops the chat, because the agent cannot reach its own API. Use the recovery command from your terminal, or wait for the timer.

## Profiles

`scripts/profiles.conf` holds the profiles. Add a row to add one. The script and the skill both read that file.

| Profile    | Bandwidth  | Delay      | Loss       |
| ---------- | ---------- | ---------- | ---------- |
| `good`     | 100Mbit/s  | 5ms        | none       |
| `3g`       | 780Kbit/s  | 100ms      | none       |
| `very-bad` | 1000Kbit/s | 500ms      | 10%        |
| `offline`  | 1Mbit/s    | none       | 100%       |
| `custom`   | your value | your value | your value |

Each value applies per direction. A 500ms delay gives a round trip near one second.

## Notes

The script runs without the skill. A CI job or a manual test can call it directly:

```
./scripts/netshape.sh run very-bad -- npm test
```

Run `./scripts/netshape.sh help` for every command, and read the comment block at the top of the file for every environment variable.

Three methods stop the shaping, and each one depends on less than the previous one:

1. Ask the agent. This needs a working network.
2. Run `./scripts/netshape.sh off` in your terminal. This needs a terminal.
3. Wait for the timer. This needs nothing.
