import { App, Modal, Setting } from "obsidian";

import { formatErrorNotice, t } from "../../i18n";
import type { DeviceReportsSnapshot, DeviceReportView } from "../../sync/health/device-reporter";
import { formatDate, formatDuration } from "../../sync/health/device-verdict";

const SHOWN_PROBLEMS = 5;
const SHOWN_PATHS = 10;

/**
 * How each of the user's devices is syncing, from the reports they send.
 *
 * Built for the question that took two weeks to answer once: is the phone
 * actually receiving anything? Each device says when it last finished a sync,
 * how far behind the server it is, and what went wrong, in its own words.
 */
export class DevicesModal extends Modal {
  constructor(
    app: App,
    private readonly deps: {
      listDeviceReports: () => Promise<DeviceReportsSnapshot | null>;
    },
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("devices.header")).setHeading();
    contentEl.createEl("p", { text: t("devices.modalDesc"), cls: "synch-modal-hint" });
    const body = contentEl.createDiv();
    body.createEl("p", { text: t("devices.loading") });

    let snapshot: DeviceReportsSnapshot | null;
    try {
      snapshot = await this.deps.listDeviceReports();
    } catch (error) {
      body.empty();
      body.createEl("p", { text: formatErrorNotice(error, "error.deviceReports") });
      return;
    }

    body.empty();
    if (!snapshot) {
      body.createEl("p", { text: t("devices.unavailable") });
      return;
    }
    if (snapshot.devices.length === 0) {
      body.createEl("p", { text: t("devices.none") });
      return;
    }

    const ordered = [...snapshot.devices].sort(
      (a, b) => Number(b.isThisDevice) - Number(a.isThisDevice) || b.reportedAt - a.reportedAt,
    );
    for (const device of ordered) {
      renderDevice(body, device, snapshot.fetchedAt);
    }
    for (const note of snapshot.notes) {
      body.createEl("p", { text: note, cls: "synch-modal-hint" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderDevice(container: HTMLElement, device: DeviceReportView, now: number): void {
  const name = device.isThisDevice ? t("devices.thisDevice", { label: device.label }) : device.label;
  const facts = [
    t("devices.lastReport", { ago: formatDuration(Math.max(0, now - device.reportedAt)) }),
    device.report?.pluginVersion ? `Syncali ${device.report.pluginVersion}` : null,
  ].filter((fact): fact is string => !!fact);

  new Setting(container)
    .setName(name)
    .setDesc([device.verdict?.headline ?? t("devices.unreadable"), ...facts].join(" · "))
    .setHeading();

  const reasons = device.verdict?.reasons ?? [];
  if (reasons.length > 0) {
    const list = container.createEl("ul");
    for (const reason of reasons) {
      list.createEl("li", { text: reason });
    }
  }

  if (device.detailsError) {
    container.createEl("p", {
      text: t("devices.detailsUnreadable", { reason: device.detailsError }),
      cls: "synch-modal-hint",
    });
  }

  const details = device.details;
  if (!details) {
    return;
  }

  if (details.recentProblems.length > 0) {
    container.createEl("p", { text: t("devices.recentProblems") });
    const list = container.createEl("ul");
    for (const problem of details.recentProblems.slice(0, SHOWN_PROBLEMS)) {
      const when =
        problem.count > 1
          ? t("problems.repeated", {
              count: problem.count.toLocaleString(),
              since: formatDate(problem.firstAt),
            })
          : formatDate(problem.at);
      list.createEl("li", { text: `${when}: ${problem.message}` });
    }
  }

  if (details.setAside.length > 0) {
    container.createEl("p", { text: t("notSyncing.header") });
    const list = container.createEl("ul");
    for (const file of details.setAside.slice(0, SHOWN_PATHS)) {
      list.createEl("li", { text: file.path });
    }
  }

  if (details.notYetSyncedTotal > 0) {
    container.createEl("p", {
      text: t("devices.notYetSynced", { count: details.notYetSyncedTotal.toLocaleString() }),
    });
    const list = container.createEl("ul");
    for (const file of details.notYetSynced.slice(0, SHOWN_PATHS)) {
      list.createEl("li", { text: `${file.path} (${t(`devices.state.${file.state}`)})` });
    }
  }
}
