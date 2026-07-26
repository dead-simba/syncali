import type {
	HealthSummaryScheduler,
	SocketGateway,
	SyncTokenVerifier,
} from "../ports";

export interface VaultInitializer {
	ensureVaultState(vaultId: string): Promise<void>;
}

export class CoordinatorSocketConnectionService {
	constructor(
		private readonly socketGateway: Pick<SocketGateway, "openSocket">,
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly vaultInitializer: VaultInitializer,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
	) {}

	async openSocket(request: Request, vaultId: string): Promise<Response> {
		const claims = await this.syncTokenService.requireSyncToken(request, vaultId);
		await this.vaultInitializer.ensureVaultState(claims.vaultId);
		const response = await this.socketGateway.openSocket(request, {
			userId: claims.sub,
			localVaultId: claims.localVaultId,
			vaultId: claims.vaultId,
			wantsStorageStatus: false,
		});
		await this.healthSummaryScheduler.scheduleSummaryFlush();
		return response;
	}
}
