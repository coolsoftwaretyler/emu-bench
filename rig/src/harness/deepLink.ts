/**
 * Deep-link parsing (SPEC.md §9): `emubench://scene/<id>?durationMs=...
 * &param=...` opens the app directly into a specific scene with
 * parameters -- launchable via `adb shell am start` / `xcrun simctl
 * openurl` / Maestro. Hand-rolled parsing (no `url` package) since the
 * format is fixed and simple, and D6 (SPEC.md §2) keeps the rig's
 * dependency list closed.
 */

export type ParsedSceneLink = {
  sceneId: string;
  params: Record<string, string>;
};

/**
 * Parses a `emubench://scene/<id>?k=v&...` URL. Returns null if the URL
 * does not match the expected scheme/path shape.
 */
export function parseSceneLink(url: string): ParsedSceneLink | null {
  const match = url.match(/^emubench:\/\/scene\/([^/?#]+)(?:\?([^#]*))?/);
  if (!match) return null;

  const sceneId = decodeURIComponent(match[1]);
  const query = match[2] ?? '';
  const params: Record<string, string> = {};

  if (query.length > 0) {
    for (const pair of query.split('&')) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    }
  }

  return { sceneId, params };
}
