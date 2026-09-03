# Airship

Airship reserves a key for the deep link, so the payload is known before you read the app. Airship is the one registered provider that needs no key from the app.

## Payload

```json
{
  "aps": { "alert": "<ALERT TEXT>", "sound": "default", "badge": 1 },
  "_": "<SEND ID>",
  "^d": "<DEEP LINK>",
  "com.urbanairship.actions": { "^d": "<DEEP LINK>" }
}
```

| Field                         | Required | Value                     |
| ----------------------------- | -------- | ------------------------- |
| `aps.alert`                   | Yes      | The text of the banner    |
| `_`                           | Yes      | A new UUID from `uuidgen` |
| `^d`                          | Yes      | The deep link URL         |
| `com.urbanairship.actions.^d` | Yes      | The same URL              |

## The function of each key

`_` is the send identifier of Airship. The SDK reads this key to find that the message is its own. If `_` is absent, iOS shows a banner, but the Airship SDK does not claim the message. The SDK then runs no deep-link action. A banner that opens no screen is the symptom of an absent `_`.

`^d` is the deep-link action of Airship. The SDK reads the URL and sends the URL to the app's deep-link handler with an origin of push.

The `com.urbanairship.actions` object contains the same action, in the location that a later SDK reads. Send both keys. The two keys add a small number of bytes, and the payload then operates with each SDK version.

Make a new `_` for each push. The SDK can read a repeated send identifier as a duplicate of a message that the SDK already processed.

## Check the destination

Airship sends the URL to the app's deep-link handler. Airship does not send the URL to the system URL opener. If the app registers no such handler, the app receives the action and does nothing.

Read the Airship setup in the app. Search for a `setDeepLinkListener` call, or for a `DeepLink` event listener. If the app registers neither, the payload is correct and the app has no handler. Report that condition. Do not change the payload.
