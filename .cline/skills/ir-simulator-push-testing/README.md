# ir-simulator-push-testing

This skill sends a push notification that contains a deep link to a booted iOS simulator. It is for a developer who must know that a notification opens the correct screen.

You name a screen in plain words. The skill finds the app's bundle id, makes the URL that opens that screen, builds the payload that your push service reads, and sends the payload. You tap the notification.

## When to use it

Use this skill to test:

- Which screen a notification opens when the app is in the foreground or in the background.
- Which screen a notification opens when the app is killed, because that is a separate code path.
- A deep link that arrives in a notification, and not in a browser.
- A notification payload after you change the app's handler or its routes.

Do not use this skill for an Android emulator or for a physical device. The skill uses `xcrun simctl`, which reaches neither. A physical device needs a real push from your provider, sent to the token of that device.

## How to use it

Boot a simulator, install the app, and ask your agent:

> Send me a push notification that deep links to the accept-invite screen.

The skill asks a question when it cannot find one of these facts:

- **The simulator.** If more than one simulator is booted, the skill compares the installed app and your branch name with each simulator. If the result is not certain, the skill asks. A push to the wrong simulator shows no banner on the screen that you read.
- **The URL.** If your app builds its `linking` config at run time, the skill cannot read the config from the source. The skill asks, and does not guess.
- **The test data.** A link with a token or a record id needs a real value. The skill cannot invent one.

The skill does not tap the notification, and it does not wait for you to tap it. The skill reports what it sent, and then ends its turn, so the session stays yours. Ask the skill to read the screen after you tap.

### Run the script yourself

The script operates without an agent:

```
./scripts/sim-push.sh devices com.example.app
printf '%s' "$PAYLOAD" | ./scripts/sim-push.sh send <udid> com.example.app -
./scripts/sim-push.sh cold <udid> com.example.app payload.json
./scripts/sim-push.sh open <udid> exampleapp://home
```

To read the full interface, run the script with no arguments.

### Add your project's details

This skill is extendable. Your project can carry a file that holds the facts that the skill cannot read from your source.

Add such a file in three conditions. Add it when your app uses a push service that the skill does not register. Add it when your app builds its routes at run time. Add it when your test links need tokens.

1. Copy [references/extensions/template.md](./references/extensions/template.md) to a new name in the same directory.
2. Write your project's payload shape, links, and test data in the copy.
3. Add an entry for the copy to the payload registry in [SKILL.md](./SKILL.md).

## What it produces

A notification on your simulator, and a report of the simulator, the URL, and the payload. The skill writes nothing to your project.

When the notification opens no screen, the skill separates four causes: the wrong simulator, the wrong payload key, a broken route, or an unregistered handler. The skill reports the cause that it found.

If no banner appears, the app usually has no notification permission. A new install has none. You cannot grant this permission from outside the app, because the iOS simulator has no privacy setting for notifications.

To correct this condition, open the app. Accept the permission request. Then send the notification again.

## Notes

The skill registers four push services: Airship, Firebase Cloud Messaging, expo-notifications, and bare APNs. Each service has one file in [references/](./references).

Airship is the only one of the four that reserves a key for the deep link. Firebase and Expo let the app select its own key names, so the skill reads your notification handler to find them.

A push is not the same test as `simctl openurl`. The URL alone tests your router. The push also tests the notification handler, the SDK that claims the message, and the cold-start path. The skill uses `openurl` only to separate a broken route from a broken handler.
