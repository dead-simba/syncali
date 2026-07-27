import { describe, expect, it } from "vitest";

import { getDefaultApiBaseUrl, getServerDeployment } from "./config";

describe("getServerDeployment", () => {
  it("treats the build-time default API URL as official cloud", () => {
    expect(getServerDeployment(getDefaultApiBaseUrl())).toBe("official_cloud");
  });

  it("treats any other API URL as self-hosted", () => {
    expect(getServerDeployment("https://custom.synch.test")).toBe("self_hosted");
    expect(getServerDeployment(`${getDefaultApiBaseUrl()}/v1`)).toBe("self_hosted");
  });
});
