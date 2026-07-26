import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks, setLanguage } from "obsidian";

import { formatErrorNotice, getSynchLocale, t } from "./i18n";

describe("Synch i18n", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("defaults unsupported languages to English", () => {
    setLanguage("fr");

    expect(getSynchLocale()).toBe("en");
    expect(t("sync.label")).toBe("Sync");
  });

  it("uses Korean for ko language codes", () => {
    setLanguage("ko-KR");

    expect(getSynchLocale()).toBe("ko");
    expect(t("sync.label")).toBe("동기화");
  });

  it("localizes cursor mismatch errors without exposing the server message", () => {
    setLanguage("ko-KR");

    expect(
      formatErrorNotice(
        Object.assign(new Error("server cursor details"), {
          code: "cursor_ahead_of_server",
        }),
        "Auto sync failed",
      ),
    ).toBe(
      "이 기기의 동기화 기록이 원격 vault와 일치하지 않아 동기화를 중지했습니다. 다시 동기화하려면 Synch 설정에서 원격 vault의 연결을 해제한 후 다시 연결하세요.",
    );
  });

  it("keeps the existing fallback for other errors", () => {
    setLanguage("ko-KR");

    expect(formatErrorNotice(new Error("request failed"), "Auto sync failed")).toBe(
      "Auto sync failed: request failed",
    );
  });

  it("uses Japanese for ja language codes", () => {
    setLanguage("ja-JP");

    expect(getSynchLocale()).toBe("ja");
    expect(t("sync.label")).toBe("同期");
  });

  it("uses simplified Chinese for zh-CN language codes", () => {
    setLanguage("zh-CN");

    expect(getSynchLocale()).toBe("zh-cn");
    expect(t("sync.label")).toBe("同步");
  });

  it("uses traditional Chinese for zh-TW language codes", () => {
    setLanguage("zh-TW");

    expect(getSynchLocale()).toBe("zh-tw");
    expect(t("sync.label")).toBe("同步");
  });
});
