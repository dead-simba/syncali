import { setIcon, type Plugin } from "obsidian";

import { t } from "../i18n";
import { isStorageWarningStatus } from "../utils/storage-warning";
import {
  getStatusBarStateClass,
  openSynchSettings,
  type SynchStatusBarState,
} from "./status-bar";

const MOBILE_STATUS_INDICATOR_STATE_CLASSES = [
  "synch-status-attention-needed",
  "synch-status-update-required",
  "synch-status-storage-warning",
  "synch-status-syncing",
  "synch-status-up-to-date",
];

/**
 * How long the tick stays up after a sync finishes.
 *
 * On desktop the status bar is always visible, so it can sit on a checkmark
 * indefinitely. A phone has no such place, and a permanent badge over the note
 * you are writing is worse than no badge at all - so it confirms, briefly, and
 * gets out of the way.
 */
const UP_TO_DATE_VISIBLE_MS = 2_000;

export class SynchMobileStatusIndicator {
  private indicator: HTMLElement | null = null;
  private icon: HTMLElement | null = null;
  private upToDateTimer: ReturnType<typeof setTimeout> | null = null;
  private wasSyncing = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly state: SynchStatusBarState,
    private readonly rootEl: HTMLElement | null = null,
  ) {}

  initialize(): void {
    const rootEl = this.rootEl ?? document.body;
    this.indicator = rootEl.createEl("button", {
      cls: "synch-mobile-status-indicator",
    });
    this.indicator.setAttribute("type", "button");
    this.indicator.setAttribute("role", "button");
    this.indicator.setAttribute("aria-label", t("status.openSettings"));
    this.icon = this.indicator.createEl("span", {
      cls: "synch-mobile-status-indicator-icon",
    });
    this.icon.setAttribute("aria-hidden", "true");
    this.plugin.registerDomEvent(this.indicator, "click", () => {
      openSynchSettings(this.plugin);
    });
    this.plugin.register(() => {
      this.indicator?.remove();
      this.indicator = null;
      this.icon = null;
    });
    this.refresh();
  }

  private showUpToDateBriefly(): void {
    if (this.upToDateTimer) {
      clearTimeout(this.upToDateTimer);
    }
    this.upToDateTimer = setTimeout(() => {
      this.upToDateTimer = null;
      this.refresh();
    }, UP_TO_DATE_VISIBLE_MS);
  }

  refresh(): void {
    if (!this.indicator) {
      return;
    }

    const state = this.state.getSyncState();
    const hasStorageWarning = isStorageWarningStatus(this.state.getStorageStatus());
    const isSyncing = state === "syncing" || state === "reconnecting";
    const needsAttention =
      hasStorageWarning || state === "attention_needed" || state === "update_required";

    // Confirm completion only when there was something to complete. Showing a
    // tick on every idle refresh would train the user to ignore it.
    const justFinished = this.wasSyncing && state === "up_to_date";
    this.wasSyncing = isSyncing;
    if (justFinished) {
      this.showUpToDateBriefly();
    }

    const shouldShow = needsAttention || isSyncing || this.upToDateTimer !== null;

    for (const className of MOBILE_STATUS_INDICATOR_STATE_CLASSES) {
      this.indicator.removeClass(className);
    }
    this.indicator.addClass("synch-mobile-status-indicator");
    this.indicator.toggleClass("synch-mobile-status-indicator-hidden", !shouldShow);
    this.indicator.toggleClass("synch-status-storage-warning", hasStorageWarning);
    if (!hasStorageWarning && (state === "attention_needed" || state === "update_required")) {
      this.indicator.addClass(getStatusBarStateClass(state));
    } else if (!needsAttention && isSyncing) {
      this.indicator.addClass("synch-status-syncing");
    } else if (!needsAttention && this.upToDateTimer !== null) {
      this.indicator.addClass("synch-status-up-to-date");
    }

    if (this.icon) {
      setIcon(
        this.icon,
        hasStorageWarning
          ? "triangle-alert"
          : state === "attention_needed" || state === "update_required"
            ? "triangle-alert"
            : isSyncing
              ? "loader-circle"
              : "check",
      );
    }
    this.indicator.setAttribute(
      "aria-label",
      hasStorageWarning
        ? t("status.storageAlmostFull")
        : state === "update_required"
          ? t("status.pluginUpdateRequired")
          : state === "attention_needed"
            ? t("status.attention")
            : isSyncing
              ? t("sync.state.syncing")
              : t("sync.state.up_to_date"),
    );
    this.indicator.setAttribute("data-synch-sync-state", state);
    this.indicator.setAttribute("data-synch-sync-percent", String(this.state.getSyncPercent()));
    this.indicator.setAttribute(
      "data-synch-storage-warning",
      hasStorageWarning ? "true" : "false",
    );
    if (this.icon) {
      setIcon(this.icon, "triangle-alert");
    }
  }
}
