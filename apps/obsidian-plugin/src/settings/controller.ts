import type { AuthReadiness } from "../auth/manager";
import type { DeviceReportsSnapshot } from "../sync/health/device-reporter";
import type {
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFilesPurgeResult,
  SynchDeletedFile,
  SynchDeletedFilesRestoreResult,
  SynchFileSizeBlockedFile,
  SynchFileRules,
  SynchVaultConfigSyncRules,
  SynchCommunityPluginUpdateStatus,
  SynchServerCompatibilityStatus,
  SynchStorageStatus,
  SynchSubscriptionStatus,
  SynchSyncProgress,
  SynchSyncState,
  SynchVersionPreview,
} from "../plugin/view-models";
import type {
  SynchSyncConflict,
  SynchSyncConflictChoice,
  SynchSyncConflictComparison,
} from "../plugin/sync-conflict-controller";

export interface SynchSettingsController {
  getCommunityPluginUpdateStatus(): SynchCommunityPluginUpdateStatus;
  ensureCommunityPluginUpdateCheck(): Promise<void>;
  retryCommunityPluginUpdateCheck(): Promise<void>;
  getServerCompatibilityStatus(): SynchServerCompatibilityStatus;
  getSubscriptionStatus(): SynchSubscriptionStatus;
  ensureSubscriptionStatusCheck(): Promise<void>;
  retrySubscriptionStatusCheck(): Promise<void>;
  openBillingManagementPage(): void;
  openPricingPage(): void;
  getAuthReadiness(): AuthReadiness;
  getAuthStatusLabel(): string;
  getSyncState(): SynchSyncState;
  getSyncStatusLabel(): string;
  getSyncPercent(): number;
  getSyncProgress(): SynchSyncProgress;
  /** Version of the plugin actually running, for the settings heading. */
  getPluginVersion(): string;
  listFileSizeBlockedFiles(): Promise<SynchFileSizeBlockedFile[]>;
  listDeviceReports(): Promise<DeviceReportsSnapshot | null>;
  retryFilesNotSyncing(): Promise<void>;
  listRecentProblems(): readonly { at: number; message: string; firstAt?: number; count?: number }[];
  recentProblemsAsText(): string;
  clearRecentProblems(): Promise<void>;
  listSyncConflicts(): SynchSyncConflict[];
  compareSyncConflict(
    conflict: SynchSyncConflict,
  ): Promise<SynchSyncConflictComparison | null>;
  resolveSyncConflict(
    conflict: SynchSyncConflict,
    choice: SynchSyncConflictChoice,
  ): Promise<void>;
  openSyncConflictPair(conflict: SynchSyncConflict): Promise<void>;
  isSyncEnabled(): boolean;
  setSyncEnabled(enabled: boolean): Promise<void>;
  getStorageStatus(): SynchStorageStatus | null;
  watchStorageStatus(): void;
  unwatchStorageStatus(): void;
  getRemoteVaultStatusLabel(): string;
  getRemoteVaultSyncFormatVersion(): number | null;
  getApiBaseUrl(): string;
  hasAuthenticatedSession(): boolean;
  isDeviceLoginInProgress(): boolean;
  hasConnectedRemoteVault(): boolean;
  beginDeviceLogin(): Promise<void>;
  signOutDevice(): Promise<void>;
  createRemoteVaultFromPrompt(): Promise<void>;
  connectRemoteVaultFromPrompt(): Promise<void>;
  openRemoteVaultManagementPage(): void;
  disconnectRemoteVault(): Promise<void>;
  updateApiBaseUrl(value: string): Promise<void>;
  getSyncFileRules(): SynchFileRules;
  getVaultConfigSyncRules(): SynchVaultConfigSyncRules;
  updateSyncFileRule<K extends keyof SynchFileRules>(
    key: K,
    value: SynchFileRules[K],
  ): Promise<void>;
  updateExcludedFolders(paths: string[]): Promise<void>;
  listSelectableExcludedFolderPaths(): string[];
  updateIncludedHiddenFolders(paths: string[]): Promise<void>;
  listSelectableIncludedHiddenFolderPaths(): Promise<string[]>;
  updateVaultConfigSyncRule<K extends keyof SynchVaultConfigSyncRules>(
    key: K,
    value: SynchVaultConfigSyncRules[K],
  ): Promise<void>;
  listDeletedFiles(
    before: SynchDeletedFileCursor | null,
    limit: number,
  ): Promise<SynchDeletedFilesPage>;
  previewDeletedFile(entryId: string, fallbackPath: string): Promise<SynchVersionPreview>;
  restoreDeletedFiles(files: SynchDeletedFile[]): Promise<SynchDeletedFilesRestoreResult>;
  purgeDeletedFiles(files: SynchDeletedFile[]): Promise<SynchDeletedFilesPurgeResult>;
}
