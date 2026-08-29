# Bare APNs

Use this file for an app with no push SDK, and for an app whose backend sends to APNs directly. Use this file also for the baseline test that separates a delivery failure from an SDK failure.

## Payload

```json
{
  "aps": { "alert": "<ALERT TEXT>", "sound": "default", "badge": 1 },
  "<APP KEY>": "<APP VALUE>"
}
```

| Field       | Required | Value                                 |
| ----------- | -------- | ------------------------------------- |
| `aps.alert` | Yes      | The text of the banner                |
| App keys    | Yes      | The keys that the app's handler reads |

`aps` is the only key that iOS reads. iOS sends each other top-level key to the app without a change, and the deep link goes in such a key. The app selects these key names, so read the app's handler.

The value of `aps.alert` is a string, or an object with the fields `title`, `subtitle`, and `body`. Use the object when the test needs a title.

## Where the app reads the payload

| Layer                | Handler                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Swift or Objective-C | `userNotificationCenter(_:didReceive:withCompletionHandler:)`                                 |
| React Native         | A `notification` listener on `PushNotificationIOS`, or the push library that the project uses |

The app receives the whole payload. If the app reads `userInfo["url"]`, the payload needs a top-level `url` key. No layer moves the key into a nested object.

## The baseline test

When a push through an SDK shows no banner, send a payload that contains `aps` only:

```json
{ "aps": { "alert": "delivery check", "sound": "default" } }
```

If a banner appears, the simulator, the bundle id, and the installed app are each correct. The cause is then in the SDK keys of the payload. If no banner appears, the cause is below the SDK. Read these four causes: the wrong simulator, the wrong bundle id, an app that is not installed, or notifications that the user denied for the app.

This test measures delivery only. The test shows nothing about the route.
