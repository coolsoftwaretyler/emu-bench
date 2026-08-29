# Firebase Cloud Messaging

Firebase reserves no deep-link key. The app selects the contents of its data object, and the app selects how to read that object. You must therefore read the app before you build a payload.

Do not copy the field names in this file. The names below are placeholders.

## Read the app first

Find the handler. Then read the fields that the handler takes from `data`.

| Function                      | Condition                                                |
| ----------------------------- | -------------------------------------------------------- |
| `getInitialNotification`      | The user opened the app from a quit state                |
| `onNotificationOpenedApp`     | The app was in the background                            |
| `onMessage`                   | The app is in the foreground                             |
| `setBackgroundMessageHandler` | A data message arrives, and the app is in the background |

The React Native Firebase documentation shows a function that the app author writes. The function makes a URL from `data`:

```js
function buildDeepLinkFromNotificationData(data) {
  const navigationId = data?.navigationId
  if (navigationId === 'settings') return 'myapp://settings'
  if (typeof data?.postId === 'string') return `myapp://post/${data.postId}`
  return null
}
```

This function reads the keys `navigationId` and `postId`. Another app reads different keys. Read the project's own function, and use the keys that the function reads.

Read also what this function does with an unknown value. The function returns null, and the app then opens its default screen. A payload with the wrong key names therefore gives a banner, an app launch, and no navigation. These symptoms are the same as the symptoms of a broken route.

Some apps make no URL. Such an app reads a screen name from `data` and calls `navigate` with that name. The payload must then contain the screen name.

## Payload

```json
{
  "aps": { "alert": "<ALERT TEXT>", "sound": "default", "badge": 1 },
  "gcm.message_id": "<MESSAGE ID>",
  "<APP KEY>": "<APP VALUE>"
}
```

| Field            | Required | Value                                 |
| ---------------- | -------- | ------------------------------------- |
| `aps.alert`      | Yes      | The text of the banner                |
| `gcm.message_id` | Yes      | A new UUID from `uuidgen`             |
| App keys         | Yes      | The keys that the app's handler reads |

FCM sends a data message to iOS through APNs. The data keys are at the top level of the payload, beside `aps`. The Firebase SDK collects these keys into the `data` object that the handler receives. `gcm.message_id` makes the SDK process the message as its own.

## Each data value is a string

FCM makes a string from each data value. The React Native Firebase documentation therefore parses each value:

```js
const owner = JSON.parse(remoteMessage.data.owner)
```

Write each value in the payload as a string for the same reason. If you write a nested JSON object, the handler receives a shape that the production service never sends. The app's `JSON.parse` call then fails on a test that production passes, or passes on a test that production fails.

Write this:

```json
"postId": "42"
```

Do not write this:

```json
"postId": 42
```

## When the banner opens no screen

Check these three conditions in order:

1. The key names are the same as the names that the handler reads. Compare the names exactly, and compare the letter case.
2. Each value is a string.
3. `gcm.message_id` is present.

If each condition is true, and the app still opens no screen, the defect is in the app's handler and not in the payload. Report that result.
