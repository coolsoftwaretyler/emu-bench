---
name: ir-simulator-push-testing
description: Send a simulated push notification that contains a deep link to a booted iOS simulator with xcrun simctl, so you can test the app's notification handler and its router together. Use it when the user asks to test a push notification, to test a deep link that arrives in a notification, to find where a notification goes, or to test routing from a killed app. Use it also when the user names a destination screen in plain words and wants a notification that opens it. Do not use it for an Android emulator or a physical device, because simctl reaches neither.
metadata:
  version: 1
---

# Simulator push testing

Send a push notification to a booted iOS simulator with [scripts/sim-push.sh](./scripts/sim-push.sh). The script runs every simulator command. This skill selects the simulator, the URL, and the payload shape that the app reads.

The user taps the notification. This skill does not tap the notification, and it does not wait for a tap.

## Why to send a push and not to use simctl openurl

`simctl openurl` sends a URL directly to the app. The command tests the router only.

A push tests four more parts:

- The notification handler in the app.
- The push SDK that claims the message.
- The route that the SDK reads from the payload.
- The cold-start path, when the app is killed.

These parts contain the defects that a router test cannot find.

Use `openurl` as a diagnostic command. Do not use it as the test. The [When the app does not open the screen](#when-the-app-does-not-open-the-screen) section gives its one use.

## Preflight

1. Make sure that `xcrun` is present. Without the Xcode command line tools, no command in this skill runs.
2. Make sure that `scripts/sim-push.sh` is executable.
3. Run `sim-push.sh devices` and read the booted simulators.

If a check fails, stop and report the cause.

## Select the simulator

Do not use the first booted simulator. A developer runs one simulator for each worktree. If you send the push to the wrong simulator, no banner appears on the screen that the user reads. The user then sees the symptom of a broken deep link. A wrong guess therefore costs more than a question.

Use these steps in order. Stop at the first step that gives an answer.

1. If the environment sets `UDID`, use that simulator. Ask no question.
2. If one simulator is booted, use that simulator.
3. If more than one simulator is booted, keep the simulators that have the target bundle installed. If one simulator remains, use that simulator and state the reason.
4. If more than one simulator remains, compare each simulator name with the current branch name and the worktree directory name. If one name matches, propose that simulator. Get the user's confirmation before you send the push.
5. If no name matches, ask the user. List each simulator with its name, its runtime, whether the app is installed, and the time when the app last wrote its data container.

`sim-push.sh devices <bundle>` reports each of these facts.

Use the time only to sort the list in the question. Do not use the time to select a simulator. The simulator with the most recent build is not always the simulator on the screen.

## Find the target

The user names a destination in plain words, such as "the accept-invite screen". Three facts make a push from that name.

| Fact | Source |
| --- | --- |
| Bundle id | The Expo config, or `PRODUCT_BUNDLE_IDENTIFIER` in the pbxproj, or the app that the booted simulator has installed |
| URL scheme | The `scheme` field in the Expo config, or `CFBundleURLTypes` in `Info.plist` |
| Route path | The Expo Router file tree, or the React Navigation `linking` config |

[references/link-discovery.md](./references/link-discovery.md) gives the method for each source. Read that file when the user does not supply a URL.

Ask the user in two conditions. Do not guess.

- The app builds the `linking` config at run time. You cannot read such a config from the source. Ask for the URL.
- The route needs a parameter, such as an invite token. You cannot invent a valid parameter. An invented value opens the screen, and the screen then fails to load its data. The user sees the symptom of a routing defect. First read the project profile in `references/extensions/`. If the profile gives no link, ask the user.

## Select the payload shape

The payload contains the deep link. Each push SDK reads the link from a different key. If the SDK does not know the key, iOS shows a banner and the app opens no screen.

Read the project's dependencies. Then read the one file that matches.

#### [references/airship.md](./references/airship.md)

- Description: Airship. Airship reserves a deep-link key, so the payload is known before you read the app.
- Selects on: `@ua/react-native-airship`, `urbanairship-react-native`, `Airship`

#### [references/firebase.md](./references/firebase.md)

- Description: Firebase Cloud Messaging. Firebase reserves no deep-link key. The app supplies the key.
- Selects on: `@react-native-firebase/messaging`, `FirebaseMessaging`

#### [references/expo.md](./references/expo.md)

- Description: expo-notifications, for a build that uses the Expo push service.
- Selects on: `expo-notifications`

#### [references/apns.md](./references/apns.md)

- Description: Bare APNs, for an app with no push SDK. Also the baseline test that shows that delivery operates.
- Selects on: No push SDK, or a custom backend

If no registered file describes the project's payload, read the project's own file in [references/extensions/](./references/extensions). The project's README gives the steps that add such a file to this registry.

If the project contains two push SDKs, ask which SDK sends the notification under test. An app can contain an SDK that the backend no longer uses.

## Build the payload and send it

Copy the template from the selected file. Write the deep link and the alert text into the template. Do not change the other keys.

Set the alert text from the destination name, the sound to `default`, and the badge to 1. Do not ask about these three fields. The test measures the route, not the text of the banner. If the user supplies the text, use the user's text.

Ask only for a field that the selected file marks as required and that no source supplies. If a required field is absent, the app opens no screen and reports no error. This skill exists to prevent that result.

Send the payload on stdin:

```
printf '%s' "$PAYLOAD" | <skill>/scripts/sim-push.sh send <udid> <bundle> -
```

To terminate the app first, use `cold` in place of `send`. A cold start is a separate code path. The app reads the destination from the launch options, and not from a listener in a running process. Routing fails most often on this path. Use `cold` when the user asks about a killed app. Offer `cold` after a `send` test passes.

Report the simulator, the URL, and the payload. The user cannot check a payload that the user did not read.

## Give the tap to the user

After the script sends the push, end the turn. Tell the user to tap the banner, and name the screen to expect.

Do not read the result in a loop, and do not wait for the tap. A loop holds the session, and the user cannot use the chat while the user works in the simulator.

The user asks for the result in the next turn. When the user asks, make a screenshot and read the screen. A screenshot costs the user nothing. A loop costs the user the session.

## When no banner appears

The script reports `Notification sent` for each accepted payload. This message states that simctl delivered the payload. It does not state that iOS showed a banner. Read the simulator screen before you report a result.

The usual cause is the notification permission. iOS shows no banner until the user permits notifications for the app. A new install has no such permission, and a fresh simulator therefore shows nothing.

You cannot grant this permission from outside the app. The iOS simulator has no privacy service for notifications, so `simctl privacy` does not reach it. No other tool reaches it either. The app must make its own permission request.

Tell the user to open the app. Then tell the user to accept the request. If the app makes no such request, report that condition and stop.

When the permission is present and no banner appears, send the baseline payload in [references/apns.md](./references/apns.md). That payload separates a delivery failure from a payload failure.

## When the app does not open the screen

This section covers a banner that appears. If no banner appears, read the previous section first.

A banner that opens no screen has four causes. This order separates the causes in the fewest steps.

1. **The wrong simulator.** Compare the UDID with the simulator window that the user reads. Check this cause first. From the wrong screen, every other cause looks the same.
2. **The wrong payload key.** The banner shows that delivery operates. Only the SDK's own key opens the screen. Read the provider file again, and compare the key with the app's handler.
3. **A broken route.** Run `sim-push.sh open <udid> <url>`. This is the one use for `openurl`. If the app opens the screen, the URL is correct and the defect is in the notification handler. If the app opens no screen, the URL is wrong, and the payload was never the cause. iOS asks the user to confirm this command when the app is in the foreground, so tell the user to accept that dialog.
4. **An unregistered handler.** The app opens the screen from `openurl`, but not from a tap. Read the app's notification handler.

Report the cause that you found. If only `openurl` opened the screen, do not report that the push operates. The two commands test different code.

## Reference

| Command                             | Purpose                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `devices [bundle]`                  | List each booted simulator with the facts that selection needs |
| `send <udid> <bundle> <payload\|->` | Send the payload to a running or background app                |
| `cold <udid> <bundle> <payload\|->` | Terminate the app, then send the payload                       |
| `open <udid> <url>`                 | Open a URL with no push, for diagnosis only                    |

`UDID` replaces simulator selection. The comment block in [scripts/sim-push.sh](./scripts/sim-push.sh) documents the interface of the script.

A payload must be 4096 bytes or less. APNs sets this limit. The script measures the payload and reports a payload that is too large.
