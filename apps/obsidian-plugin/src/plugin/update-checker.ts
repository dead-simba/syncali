import { defaultHttpClient, type HttpClient } from "../http/request";
import type { SynchCommunityPluginUpdateStatus } from "./view-models";

export const SYNCH_PLUGIN_UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/hjinco/synch/main/manifest.json";

interface RemoteManifest {
  version?: unknown;
}

export class SynchPluginUpdateChecker {
  constructor(private readonly httpClient: HttpClient = defaultHttpClient) {}

  async check(currentVersion: string): Promise<SynchCommunityPluginUpdateStatus> {
    const current = parseStrictSemver(currentVersion);
    if (!current) {
      throw new Error(`Invalid current plugin version: ${currentVersion}`);
    }

    const response = await this.httpClient.request({
      url: SYNCH_PLUGIN_UPDATE_MANIFEST_URL,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub manifest request failed with status ${response.status}.`);
    }

    const manifest = response.json as RemoteManifest;
    const latestVersion =
      manifest && typeof manifest === "object" ? manifest.version : undefined;
    if (typeof latestVersion !== "string") {
      throw new Error("GitHub manifest does not contain a version.");
    }

    const latest = parseStrictSemver(latestVersion);
    if (!latest) {
      throw new Error(`Invalid GitHub manifest version: ${latestVersion}`);
    }

    return compareSemver(latest, current) > 0
      ? {
          state: "update_available",
          currentVersion,
          latestVersion,
        }
      : {
          state: "up_to_date",
          currentVersion,
          latestVersion,
        };
  }
}

export function compareStrictSemver(left: string, right: string): number {
  const parsedLeft = parseStrictSemver(left);
  const parsedRight = parseStrictSemver(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error("Expected strict x.y.z versions.");
  }

  return compareSemver(parsedLeft, parsedRight);
}

function parseStrictSemver(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
