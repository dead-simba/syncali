import { App, Modal, Notice, Setting } from "obsidian";

import { formatErrorNotice, t } from "../../i18n";
import type {
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFilesPurgeResult,
  SynchDeletedFile,
  SynchDeletedFilesRestoreResult,
  SynchFileSizeBlockedFile,
  SynchVersionPreview,
} from "../../plugin/view-models";
import { VersionPreviewModal, renderDiffPreview } from "../../plugin/version-preview-modal";
import type {
  SynchSyncConflict,
  SynchSyncConflictChoice,
  SynchSyncConflictComparison,
} from "../../plugin/sync-conflict-controller";
import { formatDeletedFileTimestamp } from "./format";

const DELETED_FILES_PAGE_SIZE = 25;
const MAX_DELETED_FILES_RESTORE_SELECTION = 100;

export function findCoveringParent(
  folder: string,
  sortedSelected: readonly string[],
): string | null {
  for (const candidate of sortedSelected) {
    if (folder !== candidate && folder.startsWith(`${candidate}/`)) {
      return candidate;
    }
  }
  return null;
}

interface FolderSelectionModalLabels {
  header: string;
  selectHint: string;
  availableEmpty: string;
  inherited: (parent: string) => string;
}

class FolderSelectionModal extends Modal {
  private readonly selectedFolders: Set<string>;

  constructor(
    app: App,
    private readonly options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
      labels: FolderSelectionModalLabels;
    },
  ) {
    super(app);
    this.selectedFolders = new Set(options.initialSelection);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(this.options.labels.header).setHeading();
    contentEl.createEl('p', {
      text: this.options.labels.selectHint,
    });

    if (this.options.availableFolders.length === 0) {
      contentEl.createEl('p', {
        text: this.options.labels.availableEmpty,
      });
    } else {
      const sortedSelected = [...this.selectedFolders].sort(
        (left, right) => left.length - right.length,
      );
      for (const folder of this.options.availableFolders) {
        const inheritedFrom = findCoveringParent(folder, sortedSelected);
        const isInherited = inheritedFrom !== null;
        const isOn = isInherited || this.selectedFolders.has(folder);

        const setting = new Setting(contentEl).setName(folder);
        if (isInherited) {
          setting.setDesc(this.options.labels.inherited(inheritedFrom as string));
        }
        setting.addToggle((toggle) =>
          toggle
            .setValue(isOn)
            .setDisabled(isInherited)
            .onChange((value) => this.handleToggle(folder, value)),
        );
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t('cancel')).onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t('done')).setCta().onClick(() => {
          void this.options.onSubmit(
            [...this.selectedFolders].sort((a, b) => a.localeCompare(b)),
          );
          this.close();
        }),
      );
  }

  private handleToggle(folder: string, value: boolean): void {
    if (value) {
      this.selectedFolders.add(folder);
      const prefix = `${folder}/`;
      for (const candidate of [...this.selectedFolders]) {
        if (candidate !== folder && candidate.startsWith(prefix)) {
          this.selectedFolders.delete(candidate);
        }
      }
    } else {
      this.selectedFolders.delete(folder);
    }
    this.render();
  }
}

export class ExcludedFoldersModal extends FolderSelectionModal {
  constructor(
    app: App,
    options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
    },
  ) {
    super(app, {
      ...options,
      labels: {
        header: t("excluded.header"),
        selectHint: t("excluded.selectHint"),
        availableEmpty: t("excluded.availableEmpty"),
        inherited: (parent) => t("excluded.inherited", { parent }),
      },
    });
  }
}

export class IncludedHiddenFoldersModal extends FolderSelectionModal {
  constructor(
    app: App,
    options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
    },
  ) {
    super(app, {
      ...options,
      labels: {
        header: t("hiddenFolders.header"),
        selectHint: t("hiddenFolders.selectHint"),
        availableEmpty: t("hiddenFolders.availableEmpty"),
        inherited: (parent) => t("hiddenFolders.inherited", { parent }),
      },
    });
  }
}

export class DeletedFilesModal extends Modal {
  private readonly selectedEntryIds = new Set<string>();
  private deletedFiles: SynchDeletedFile[] = [];
  private nextBefore: SynchDeletedFileCursor | null = null;
  private hasMore = false;
  private loading = false;
  private previewingEntryId: string | null = null;
  private error: string | null = null;

  constructor(
    app: App,
    private readonly options: {
      listDeletedFiles: (
        before: SynchDeletedFileCursor | null,
        limit: number,
      ) => Promise<SynchDeletedFilesPage>;
      previewDeletedFile: (
        entryId: string,
        fallbackPath: string,
      ) => Promise<SynchVersionPreview>;
      restoreDeletedFiles: (
        files: SynchDeletedFile[],
      ) => Promise<SynchDeletedFilesRestoreResult>;
      purgeDeletedFiles: (
        files: SynchDeletedFile[],
      ) => Promise<SynchDeletedFilesPurgeResult>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    void this.loadDeletedFiles();
  }

  private async loadDeletedFiles(): Promise<void> {
    this.deletedFiles = [];
    this.nextBefore = null;
    this.hasMore = false;
    await this.loadDeletedFilesPage(null);
  }

  private async loadMoreDeletedFiles(): Promise<void> {
    if (!this.hasMore || this.loading) {
      return;
    }
    await this.loadDeletedFilesPage(this.nextBefore);
  }

  private async loadDeletedFilesPage(
    before: SynchDeletedFileCursor | null,
  ): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const page = await this.options.listDeletedFiles(
        before,
        DELETED_FILES_PAGE_SIZE,
      );
      this.deletedFiles =
        before === null ? page.files : [...this.deletedFiles, ...page.files];
      this.hasMore = page.hasMore;
      this.nextBefore = page.nextBefore;
      for (const entryId of [...this.selectedEntryIds]) {
        if (!this.deletedFiles.some((file) => file.entryId === entryId)) {
          this.selectedEntryIds.delete(entryId);
        }
      }
    } catch (error) {
      if (before === null) {
        this.deletedFiles = [];
        this.selectedEntryIds.clear();
        this.hasMore = false;
        this.nextBefore = null;
      }
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("synch-deleted-files-modal");
    const headerEl = contentEl.createEl("div", {
      cls: "synch-deleted-files-header",
    });
    const listEl = contentEl.createEl("div", {
      cls: "synch-deleted-files-list",
    });
    const footerEl = contentEl.createEl("div", {
      cls: "synch-deleted-files-footer",
    });
    new Setting(headerEl).setName(t("deleted.header")).setHeading();

    if (this.error) {
      headerEl.createEl("p", {
        cls: "synch-modal-error",
        text: this.error,
      });
    } else {
      const hintRowEl = headerEl.createEl("div", {
        cls: "synch-deleted-files-hint-row",
      });
      hintRowEl.createEl("p", {
        cls: "synch-modal-hint",
        text: t("deleted.hint"),
      });
      if (this.deletedFiles.length > 0) {
        const allLoadedSelected = this.deletedFiles.every((file) =>
          this.selectedEntryIds.has(file.entryId),
        );
        const selectAll = new Setting(hintRowEl).setName("Select all");
        selectAll.settingEl.addClass("synch-deleted-files-select-all");
        selectAll.addToggle((toggle) => {
          toggle
            .setValue(allLoadedSelected)
            .setDisabled(this.loading)
            .onChange((value) => {
              for (const file of this.deletedFiles) {
                if (value) {
                  if (this.selectedEntryIds.has(file.entryId)) {
                    continue;
                  }
                  if (
                    this.selectedEntryIds.size >= MAX_DELETED_FILES_RESTORE_SELECTION
                  ) {
                    this.showRestoreSelectionLimitNotice();
                    break;
                  }
                  this.selectedEntryIds.add(file.entryId);
                } else {
                  this.selectedEntryIds.delete(file.entryId);
                }
              }
              this.render();
            });
        });
      }
    }

    if (this.loading) {
      listEl.createEl("p", {
        cls: "synch-modal-empty",
        text: t("deleted.loading"),
      });
    } else if (!this.error && this.deletedFiles.length === 0) {
      listEl.createEl("p", {
        cls: "synch-modal-empty",
        text: t("deleted.empty"),
      });
    } else {
      for (const file of this.deletedFiles) {
        const previewing = this.previewingEntryId === file.entryId;
        const setting = new Setting(listEl)
          .setName(file.path)
          .setDesc(
            t("deleted.deletedAt", {
              deletedAt: formatDeletedFileTimestamp(file.deletedAt),
            }),
          );
        setting.addButton((button) => {
          button
            .setButtonText(previewing ? t("preview.loading") : t("preview"))
            .setDisabled(this.loading || previewing)
            .onClick(() => {
              void this.previewDeletedFile(file);
            });
        });
        setting.addToggle((toggle) => {
          const selected = this.selectedEntryIds.has(file.entryId);
          toggle
            .setValue(selected)
            .setDisabled(
              this.loading ||
                (!selected &&
                  this.selectedEntryIds.size >=
                    MAX_DELETED_FILES_RESTORE_SELECTION),
            )
            .onChange((value) => {
              if (value) {
                if (
                  this.selectedEntryIds.size >= MAX_DELETED_FILES_RESTORE_SELECTION
                ) {
                  this.showRestoreSelectionLimitNotice();
                  this.render();
                  return;
                }
                this.selectedEntryIds.add(file.entryId);
              } else {
                this.selectedEntryIds.delete(file.entryId);
              }
              this.render();
            });
        });
      }
      if (this.hasMore) {
        const loadMore = new Setting(listEl);
        loadMore.settingEl.addClass("synch-deleted-files-load-more");
        loadMore.addButton((button) =>
          button
            .setButtonText(t("loadMore"))
            .setDisabled(this.loading)
            .onClick(() => {
              void this.loadMoreDeletedFiles();
            }),
        );
      }
    }

    const selectedCount = this.selectedEntryIds.size;
    const actions = new Setting(footerEl).addButton((button) =>
      button.setButtonText(t("refresh")).setDisabled(this.loading).onClick(() => {
        void this.loadDeletedFiles();
      }),
    );
    actions.settingEl.addClass("synch-deleted-files-actions");
    actions
      .addButton((button) =>
        button
          .setButtonText(
            selectedCount > 0
              ? t("deleted.restoreSelectedCount", { count: selectedCount })
              : t("deleted.restoreSelected"),
          )
          .setCta()
          .setDisabled(this.loading || selectedCount === 0)
          .onClick(() => {
            void this.restoreSelected();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(
            selectedCount > 0
              ? t("deleted.purgeSelectedCount", { count: selectedCount })
              : t("deleted.purgeSelected"),
          )
          .setWarning()
          .setDisabled(this.loading || selectedCount === 0)
          .onClick(() => {
            void this.purgeSelected();
          }),
      )
      .addButton((button) =>
        button.setButtonText(t("close")).onClick(() => {
          this.close();
        }),
      );
  }

  private async restoreSelected(): Promise<void> {
    const selectedFiles = this.deletedFiles.filter((file) =>
      this.selectedEntryIds.has(file.entryId),
    );
    if (selectedFiles.length === 0) {
      return;
    }

    this.loading = true;
    this.render();

    let result: SynchDeletedFilesRestoreResult;
    try {
      result = await this.options.restoreDeletedFiles(selectedFiles);
    } catch (error) {
      new Notice(
        t("deleted.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.loadDeletedFiles();
      return;
    }

    const failedEntryIds = new Set(
      result.failures.map((failure) => failure.entryId),
    );
    for (const file of selectedFiles) {
      if (!failedEntryIds.has(file.entryId)) {
        this.selectedEntryIds.delete(file.entryId);
      }
    }

    const failed = result.failures.length;
    const restored = result.restored;
    const parts = [t("deleted.restoredCount", { count: restored })];
    if (failed > 0) {
      parts.push(t("deleted.failedCount", { count: failed }));
    }
    new Notice(t("deleted.finished", { summary: parts.join(", ") }));
    await this.loadDeletedFiles();
  }

  private async purgeSelected(): Promise<void> {
    const selectedFiles = this.deletedFiles.filter((file) =>
      this.selectedEntryIds.has(file.entryId),
    );
    if (selectedFiles.length === 0) {
      return;
    }

    if (!confirm(t("deleted.purgeConfirm", { count: selectedFiles.length }))) {
      return;
    }

    this.loading = true;
    this.render();

    let result: SynchDeletedFilesPurgeResult;
    try {
      result = await this.options.purgeDeletedFiles(selectedFiles);
    } catch (error) {
      new Notice(
        t("deleted.purgeFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.loadDeletedFiles();
      return;
    }

    const failedEntryIds = new Set(
      result.failures.map((failure) => failure.entryId),
    );
    for (const file of selectedFiles) {
      if (!failedEntryIds.has(file.entryId)) {
        this.selectedEntryIds.delete(file.entryId);
      }
    }

    const failed = result.failures.length;
    const purged = result.purged;
    const parts = [t("deleted.purgedCount", { count: purged })];
    if (failed > 0) {
      parts.push(t("deleted.failedCount", { count: failed }));
    }
    new Notice(t("deleted.purgeFinished", { summary: parts.join(", ") }));
    await this.loadDeletedFiles();
  }

  private showRestoreSelectionLimitNotice(): void {
    new Notice(
      t("deleted.restoreLimit", { count: MAX_DELETED_FILES_RESTORE_SELECTION }),
    );
  }

  private async previewDeletedFile(file: SynchDeletedFile): Promise<void> {
    if (this.previewingEntryId !== null) {
      return;
    }

    this.previewingEntryId = file.entryId;
    this.render();

    try {
      const preview = await this.options.previewDeletedFile(file.entryId, file.path);
      new VersionPreviewModal(this.app, preview).open();
    } catch (error) {
      new Notice(
        t("deleted.previewFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.previewingEntryId = null;
      this.render();
    }
  }
}

/**
 * Files Syncali has set aside.
 *
 * Until now this was a tooltip on a small icon beside the sync status, which
 * is unreachable on a phone and easy to miss on a desktop - so a file could
 * stop syncing and simply never be noticed. A set-aside file is the one
 * failure a user cannot infer from anything else, so it gets a list, a reason
 * per file, and a way out that is not "rename it and hope".
 */
export class FilesNotSyncingModal extends Modal {
  constructor(
    app: App,
    private readonly deps: {
      listFiles: () => Promise<SynchFileSizeBlockedFile[]>;
      retry: () => Promise<void>;
    },
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("notSyncing.header")).setHeading();
    contentEl.createEl("p", {
      text: t("notSyncing.desc"),
      cls: "synch-modal-hint",
    });

    const list = contentEl.createDiv();
    const files = await this.deps.listFiles();

    if (files.length === 0) {
      list.createEl("p", { text: t("notSyncing.none") });
      return;
    }

    for (const file of files) {
      const row = new Setting(list).setName(file.path);
      row.setDesc(describeNotSyncingReason(file));
    }

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(t("notSyncing.retry"))
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText(t("notSyncing.retrying"));
          try {
            await this.deps.retry();
            new Notice(t("notSyncing.retried"));
            this.close();
          } catch (error) {
            new Notice(formatErrorNotice(error, "error.autoSync"));
            button.setDisabled(false).setButtonText(t("notSyncing.retry"));
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function describeNotSyncingReason(file: SynchFileSizeBlockedFile): string {
  if (file.op === "delete") {
    return file.reason === "stale_unresolved"
      ? t("notSyncing.reasonDeleteStaleUnresolved")
      : t("notSyncing.reasonDeletePrepareFailed");
  }
  switch (file.reason) {
    case "prepare_failed":
      return t("notSyncing.reasonPrepareFailed");
    case "stale_unresolved":
      return t("notSyncing.reasonStaleUnresolved");
    default:
      return t("notSyncing.reasonTooLarge");
  }
}

/**
 * A short history of the errors Syncali has reported.
 *
 * A notice lasts a few seconds. On a phone there is no console behind it and
 * no log file to open, so an error seen on the bus is gone before it can be
 * read - which is how the same fault ends up being diagnosed from memory,
 * three times. Copy exists so the text can leave the phone intact.
 */
export class RecentProblemsModal extends Modal {
  constructor(
    app: App,
    private readonly deps: {
      listProblems: () => readonly { at: number; message: string }[];
      asText: () => string;
      clear: () => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("problems.header")).setHeading();
    contentEl.createEl("p", { text: t("problems.desc"), cls: "synch-modal-hint" });

    const problems = this.deps.listProblems();
    if (problems.length === 0) {
      contentEl.createEl("p", { text: t("problems.none") });
      return;
    }

    const list = contentEl.createDiv();
    for (const problem of problems) {
      new Setting(list)
        .setName(formatProblemTime(problem.at))
        .setDesc(problem.message);
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("problems.copy"))
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(this.deps.asText());
            new Notice(t("problems.copied"));
          }),
      )
      .addButton((button) =>
        button.setButtonText(t("problems.clear")).onClick(async () => {
          await this.deps.clear();
          new Notice(t("problems.cleared"));
          this.render();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Local time, to the minute - enough to match an error against what you were doing. */
function formatProblemTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Settle a conflict without going to the file explorer.
 *
 * Both versions are kept when sync cannot decide between them, which is the
 * right call - but it leaves the user with two files, one of them oddly named,
 * and no way to see what actually differs. Almost nobody does that hunt, so
 * the copies accumulate and the real edit sits in whichever file was not
 * opened. Showing the difference and offering the two obvious answers is the
 * whole job.
 */
export class SyncConflictsModal extends Modal {
  constructor(
    app: App,
    private readonly deps: {
      listConflicts: () => SynchSyncConflict[];
      compare: (conflict: SynchSyncConflict) => Promise<SynchSyncConflictComparison | null>;
      resolve: (
        conflict: SynchSyncConflict,
        choice: SynchSyncConflictChoice,
      ) => Promise<void>;
      openBoth: (conflict: SynchSyncConflict) => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderList();
  }

  private renderList(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("conflicts.header")).setHeading();
    contentEl.createEl("p", { text: t("conflicts.desc"), cls: "synch-modal-hint" });

    const conflicts = this.deps.listConflicts();
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: t("conflicts.none") });
      return;
    }

    for (const conflict of conflicts) {
      const row = new Setting(contentEl)
        .setName(conflict.originalPath)
        .setDesc(t("conflicts.detected", { when: formatWhen(conflict.detectedAt) }));

      row.addButton((button) =>
        button
          .setButtonText(t("conflicts.compare"))
          .setCta()
          .onClick(() => {
            this.renderComparison(conflict);
          }),
      );
      row.addButton((button) =>
        button.setButtonText(t("conflicts.openBoth")).onClick(async () => {
          await this.deps.openBoth(conflict);
          this.close();
        }),
      );
    }
  }

  private renderComparison(conflict: SynchSyncConflict): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(conflict.originalPath).setHeading();

    new Setting(contentEl)
      .setName(t("conflicts.inVault"))
      .setDesc(
        t("conflicts.fileMeta", {
          when: formatWhen(conflict.originalModifiedAt),
          size: formatSize(conflict.originalSizeBytes),
        }),
      );
    new Setting(contentEl)
      .setName(t("conflicts.theCopy"))
      .setDesc(
        t("conflicts.fileMeta", {
          when: formatWhen(conflict.conflictModifiedAt),
          size: formatSize(conflict.conflictSizeBytes),
        }),
      );

    const diffHost = contentEl.createDiv();
    void this.renderDifference(diffHost, conflict);

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("conflicts.keepOriginal"))
          .setCta()
          .onClick(async () => {
            await this.settle(conflict, "original");
          }),
      )
      .addButton((button) =>
        button.setButtonText(t("conflicts.keepCopy")).onClick(async () => {
          await this.settle(conflict, "conflict");
        }),
      )
      .addButton((button) =>
        button.setButtonText(t("conflicts.openBoth")).onClick(async () => {
          await this.deps.openBoth(conflict);
          this.close();
        }),
      );
  }

  private async renderDifference(
    host: HTMLElement,
    conflict: SynchSyncConflict,
  ): Promise<void> {
    if (conflict.originalModifiedAt === 0) {
      host.createEl("p", {
        text: t("conflicts.originalMissing"),
        cls: "synch-modal-hint",
      });
      return;
    }

    const comparison = await this.deps.compare(conflict);
    if (!comparison) {
      host.createEl("p", {
        text: t("conflicts.notComparable"),
        cls: "synch-modal-hint",
      });
      return;
    }

    if (comparison.originalText === comparison.conflictText) {
      host.createEl("p", { text: t("conflicts.identical"), cls: "synch-modal-hint" });
      return;
    }

    renderDiffPreview(host, comparison.originalText, comparison.conflictText);
  }

  private async settle(
    conflict: SynchSyncConflict,
    choice: SynchSyncConflictChoice,
  ): Promise<void> {
    try {
      await this.deps.resolve(conflict, choice);
      new Notice(
        choice === "original"
          ? t("conflicts.resolvedKeptOriginal", { path: conflict.originalPath })
          : t("conflicts.resolvedKeptCopy", { path: conflict.originalPath }),
      );
      this.renderList();
    } catch (error) {
      new Notice(formatErrorNotice(error, "error.autoSync"));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatWhen(at: number): string {
  if (!at) {
    return "-";
  }

  const when = new Date(at);
  const sameDay = new Date().toDateString() === when.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? `today at ${time}`
    : `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
