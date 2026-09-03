# expo-notifications

Expo reserves no deep-link key. The app selects the contents of its `data` object. Read the app before you build the payload.

## What the app receives

The app reads the same location for each payload shape:

```js
Notifications.addNotificationResponseReceivedListener(response => {
  const data = response.notification.request.content.data
})
```

Find this listener, or find a `useLastNotificationResponse` call. Then read the keys that the listener takes from `data`. An Expo Router project often uses a `url` key and sends the value to `Linking`. This pattern is a convention, and not a rule. Use the key that the project reads.

## Payload

```json
{
  "aps": { "alert": { "title": "<TITLE>", "body": "<ALERT TEXT>" }, "sound": "default", "badge": 1 },
  "body": { "<APP KEY>": "<APP VALUE>" }
}
```

| Field             | Required | Value                                           |
| ----------------- | -------- | ----------------------------------------------- |
| `aps.alert.title` | No       | The bold line of the banner                     |
| `aps.alert.body`  | Yes      | The text of the banner                          |
| `body`            | Yes      | The object that the app reads as `content.data` |

The `body` key contains the data. The Expo push service puts the `data` field of a message into this key when the service sends the message to APNs. expo-notifications then unwraps `body` and gives its contents to the app as `content.data`. A payload with `"body": {"url": "..."}` therefore reaches the app as `content.data.url`.

## The body key is necessary

Write the data in `body`. Do not write the data at the top level, beside `aps`.

expo-notifications reads the `body` key only. A top-level key reaches the app in the raw notification. expo-notifications does not copy that key into `content.data`, and the listener then receives an empty object.

The notification still arrives, and the banner still appears. This mistake therefore looks like a broken route.

A test on iOS 26 confirms both results. The payload above gives `content.data` of `{"url": "..."}`. The same key at the top level gives `content.data` of `{}`.

## Expo Go

A legacy Expo Go client, on SDK 52 or earlier, also needs `experienceId` and `scopeKey`. Set both fields to `@username/slug`. A development build and a production build need neither field. Add these two fields only when the target is Expo Go.

## Simulator support

A push notification operates on an iOS simulator with Xcode 14 or later, on macOS 13 or later, and with iOS 16 or later. An earlier simulator receives no push notification, and no payload changes that limit.
