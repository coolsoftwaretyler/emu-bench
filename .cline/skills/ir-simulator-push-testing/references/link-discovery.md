# Link discovery

Make a URL that the app accepts from a destination that the user names in plain words. Find also the bundle id that receives the push.

## Contents

- The bundle id
- Build variants
- The URL scheme
- Routes in Expo Router
- Routes in React Navigation
- When the app builds the config at run time
- Check a URL that you inferred

## The bundle id

Read these sources in order. Stop at the first source that gives an answer.

| Source        | Location                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| Expo config   | `ios.bundleIdentifier` in `app.json`, `app.config.js`, or `app.config.ts`  |
| Xcode project | `PRODUCT_BUNDLE_IDENTIFIER` in `ios/*.xcodeproj/project.pbxproj`           |
| The simulator | `sim-push.sh devices` reports the installed app after you have a candidate |

A bare React Native project holds the bundle id in the pbxproj only. A prebuilt Expo project holds the bundle id in both locations. Use the value from the Expo config, because a prebuild writes the pbxproj from that config.

## Build variants

Most projects contain more than one bundle id: a development build, a staging build, and the release build. If you push to the wrong bundle id, the notification goes to an app that the user did not open.

- An Expo `app.config.ts` usually reads an environment variable such as `APP_VARIANT`. Read the whole function, and not the exported default.
- An Xcode project holds one `PRODUCT_BUNDLE_IDENTIFIER` for each build configuration. Read each one.
- A suffix such as `.dev` or `.staging` on the release id is the common pattern.

If the project contains more than one bundle id, and the user names none of them, ask the user. `sim-push.sh devices <bundle>` also limits the answer. Run the command for each candidate, and read which app is installed.

## The URL scheme

| Source        | Location                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| Expo config   | The `scheme` field in the Expo config, as a string or as an array of strings |
| Xcode project | `CFBundleURLTypes[].CFBundleURLSchemes` in `ios/*/Info.plist`                |

A scheme URL has the form `<scheme>://<path>` or `<scheme>:///<path>`. If the config lists more than one scheme, each scheme operates. Use the first scheme.

Write three slashes. Three slashes give the correct path in each app. Two slashes give the correct path only in some apps.

The number of slashes controls the host name. A URL parser reads the text between the second slash and the third slash as the host, and it reads the rest as the path. Two slashes therefore put the first path segment in the host. Three slashes leave the host empty.

What the app does with that host decides whether the two forms agree:

| App                              | `myapp://invite/abc` | `myapp:///invite/abc` |
| -------------------------------- | -------------------- | --------------------- |
| Expo Router                      | `invite/abc`         | `invite/abc`          |
| An app that reads the path alone | `abc`                | `invite/abc`          |

Expo Router adds the host to the path, so both forms agree. `Linking.parse` and `new URL` return the host and the path separately, so an app that reads the path alone loses the first segment.

Do not report a two-slash URL in an Expo Router app as a defect. The two forms are equal there.

If the app opens the wrong screen, and the URL uses two slashes, send the same URL with three slashes. If the app then opens the correct screen, the app reads the path alone.

A universal link uses `https://` and a domain from the app's associated domains. The Expo config declares these domains in `ios.associatedDomains`. The entitlements file declares them in a bare project. A universal link also needs the `apple-app-site-association` file of the domain, and the simulator must reach that file. A scheme URL is therefore the reliable choice for a simulator test. Use a universal link only when the user asks to test the universal link itself.

## Routes in Expo Router

Expo Router makes the routes from the file tree in `app/`. Read the tree. There is no config file to find.

| File                     | Path                  |
| ------------------------ | --------------------- |
| `app/index.tsx`          | `/`                   |
| `app/settings.tsx`       | `/settings`           |
| `app/post/[id].tsx`      | `/post/<id>`          |
| `app/post/[...rest].tsx` | `/post/<any>/<depth>` |
| `app/(tabs)/feed.tsx`    | `/feed`               |
| `app/_layout.tsx`        | Not a route           |

A directory name in parentheses is a group. A group sets the layout, and the group name does not appear in the URL. This rule is the most common cause of a wrong URL. The path of `app/(auth)/invite.tsx` is `/invite`, and not `/auth/invite`.

A file with the name `+not-found.tsx` receives each path that no route matches. If the app opens that screen, the URL is wrong. This behavior is a useful signal during a test.

## Routes in React Navigation

React Navigation reads a `linking` object from `NavigationContainer`. Search the source for `linking` or for `prefixes`.

```js
const linking = {
  prefixes: ['myapp://'],
  config: {
    screens: {
      Home: 'home',
      Post: 'post/:id',
      Settings: { path: 'settings' },
    },
  },
}
```

- `prefixes` holds the schemes. These schemes must agree with the `Info.plist`. If the two disagree, `Info.plist` controls what iOS sends to the app, and `prefixes` controls what the app accepts. A URL must satisfy both files.
- Each entry in `screens` maps one screen name to one path. The value is a string, or an object with a `path` key.
- A nested object in `screens` makes a nested path. A screen in a navigator within another navigator joins each path segment in order.
- A screen that `screens` does not list has no URL. Report this condition. Do not invent a URL.

## When the app builds the config at run time

Stop and ask the user for the URL when you find one of these conditions:

- A function builds `config`, or the code spreads `config` from a variable that a module builds.
- The app supplies its own `getStateFromPath` or `getPathFromState`.
- The app supplies its own `getInitialURL` or `subscribe`.

The last condition is important for this skill. Some apps read the notification payload and call the navigator directly, and such an app makes no URL. Read the notification handler. If the handler calls `navigate` with a screen name, the payload must contain that screen name. The deep-link key of the provider file is then the wrong field to complete.

## Check a URL that you inferred

If you read the URL from a config, and the user did not supply it, check the URL before you build the payload:

```
sim-push.sh open <udid> <url>
```

If the app opens the screen, the URL is correct, and a later failure is in the notification path. If the app opens no screen, correct the URL first. This command costs one step, and it removes the URL from the list of causes.

Do not use this command in place of the push. The command shows that the router operates. The command shows nothing about the notification handler.
