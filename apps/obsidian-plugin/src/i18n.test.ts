import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks, setLanguage } from "obsidian";

import { ApiRequestError } from "./http/request";
import { formatErrorNotice, getSynchLocale, t } from "./i18n";
import { renameVaultPath, VaultWriteError, writeVaultBytes } from "./sync/vault/vault-writer";

describe("Syncali i18n", () => {
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
      "이 기기의 동기화 기록이 원격 vault와 일치하지 않아 동기화를 중지했습니다. 다시 동기화하려면 Syncali 설정에서 원격 vault의 연결을 해제한 후 다시 연결하세요.",
    );
  });

  it("localizes the context for other errors", () => {
    setLanguage("ko-KR");

    expect(formatErrorNotice(new Error("request failed"), "error.autoSync")).toBe(
      "자동 동기화 실패: request failed",
    );
  });

  it("localizes notification messages with dynamic values", () => {
    setLanguage("ko-KR");

    expect(t("auth.openingBrowser", { code: "ABCD-EFGH" })).toBe(
      "기기 로그인을 위해 브라우저를 여는 중...\n코드: ABCD-EFGH",
    );
    expect(t("sync.conflictLocalSaved", { path: "메모/충돌.md" })).toBe(
      '동기화 충돌이 감지되었습니다. 로컬 변경 사항을 "메모/충돌.md"에 저장했습니다.',
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

describe("Syncali error notices", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("never renders a bare context when the error carries no message", () => {
    // Android WebView exceptions and server frames missing `message` both reach
    // here as `new Error(undefined)`, which used to render "Automatic sync
    // failed:" with nothing after the colon.
    expect(formatErrorNotice(new Error(undefined), "error.autoSync")).toBe(
      "Automatic sync failed",
    );
  });

  it("falls back to the error code when the message is empty", () => {
    const error = Object.assign(new Error(""), { code: "blob_not_staged" });

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      "Automatic sync failed: blob_not_staged",
    );
  });

  it("appends the code when it adds information the message lacks", () => {
    const error = Object.assign(new Error("upload rejected"), {
      code: "quota_exceeded",
    });

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      "Automatic sync failed: upload rejected (quota_exceeded)",
    );
  });

  it("does not repeat a code already present in the message", () => {
    const error = Object.assign(new Error("quota_exceeded while pushing"), {
      code: "quota_exceeded",
    });

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      "Automatic sync failed: quota_exceeded while pushing",
    );
  });

  it("does not surface useless [object Object] text", () => {
    expect(formatErrorNotice({ nope: true }, "error.autoSync")).toBe(
      "Automatic sync failed",
    );
  });
});

describe("Syncali named error notices", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  function androidWriter() {
    const refuse = async () => {
      throw new Error("FILE_NOTCREATED");
    };
    return {
      exists: async () => true,
      mkdir: refuse,
      writeText: refuse,
      writeBinary: refuse,
      rename: refuse,
    };
  }

  async function caught(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("expected the operation to fail");
  }

  it("names the file, the character and the fix when Android refuses a name", async () => {
    // What the phone showed instead: 'Automatic sync failed: write failed for
    // "...": FILE_NOTCREATED' - the example docs/copy-style.md calls a bug.
    const error = await caught(() =>
      writeVaultBytes(androidWriter(), "Notes/Why Planning is Important?.md", new Uint8Array()),
    );

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      'Could not create "Notes/Why Planning is Important?.md" on this device. Android does not allow ? in file or folder names. Rename it on your computer and sync will continue.',
    );
  });

  it("names every refused character, and the folder when the folder is the problem", async () => {
    const writer = { ...androidWriter(), exists: async () => false };
    const error = await caught(() =>
      writeVaultBytes(writer, "Q&A: what? /note.md", new Uint8Array()),
    );

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      'Could not create "Q&A: what? " on this device. Android does not allow : or ? in file or folder names. Rename it on your computer and sync will continue.',
    );
  });

  it("names the destination of a rename, not the arrow between the two names", async () => {
    const error = await caught(() =>
      renameVaultPath(androidWriter(), "Notes/plain.md", "Notes/Why?.md"),
    );

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      'Could not create "Notes/Why?.md" on this device. Android does not allow ? in file or folder names. Rename it on your computer and sync will continue.',
    );
  });

  it("does not blame the name when nothing in it is refused", async () => {
    // A full disk or a permission problem gives the same code on Android.
    const error = await caught(() =>
      writeVaultBytes(androidWriter(), "Notes/plain.md", new Uint8Array()),
    );

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      'Automatic sync failed: write failed for "Notes/plain.md": FILE_NOTCREATED',
    );
  });

  it("does not say 'could not create' about a delete", () => {
    const error = new VaultWriteError("delete", "Notes/Why?.md", new Error("FILE_NOTCREATED"));

    expect(formatErrorNotice(error, "error.autoSync")).toBe(
      'Automatic sync failed: delete failed for "Notes/Why?.md": FILE_NOTCREATED',
    );
  });

  it("still names the file when the write error arrives wrapped", async () => {
    const inner = await caught(() =>
      writeVaultBytes(androidWriter(), "Notes/Why?.md", new Uint8Array()),
    );
    const wrapped = Object.assign(new Error("pull failed"), { cause: inner });

    expect(formatErrorNotice(wrapped, "error.autoSync")).toContain(
      'Could not create "Notes/Why?.md" on this device.',
    );
  });

  it("names an overloaded server during automatic sync, and promises the retry that is coming", () => {
    // Reached the user as "Automatic sync failed: error code: 1102 (http_503)".
    expect(
      formatErrorNotice(new ApiRequestError(503, "http_503", "error code: 1102"), "error.autoSync"),
    ).toBe(
      "Your Syncali server could not handle a sync request (error code: 1102 (http_503)). Nothing was lost, and Syncali will try again on its own. If this keeps happening, check that your server is running.",
    );
  });

  it("does not promise a retry for something the user started", () => {
    expect(
      formatErrorNotice(
        new ApiRequestError(503, "http_503", "error code: 1102"),
        "error.vaultCreation",
      ),
    ).toBe("Vault creation failed: error code: 1102 (http_503)");
  });
});
