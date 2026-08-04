export type BlobBody = NonNullable<Request["body"]>;

/**
 * A blob's bytes plus its known length.
 *
 * The length is not optional: a streamed response sent without a
 * `content-length` goes out chunked, and a client that loses the connection
 * partway through cannot distinguish a truncated body from a complete one - it
 * just reads EOF. Android's OkHttp reports exactly that as
 * `IOException: unexpected end of stream`. Carrying the size lets the route
 * declare it so truncation is detectable.
 */
export interface BlobDownload {
	body: ReadableStream;
	size: number;
}

/**
 * Full blob object storage surface: `BlobObjectRepository` (in
 * `../coordinator/ports.ts`) only covers what the coordinator itself needs
 * (exists/delete/deleteByPrefix) — this adds the upload/download path used by
 * `sync/blob/routes.ts`, shared by every backend (R2, local disk, S3).
 */
export interface BlobStorage {
	upload(key: string, body: BlobBody): Promise<{ size: number }>;
	download(key: string): Promise<BlobDownload | null>;
	delete(key: string): Promise<void>;
	deleteByPrefix(prefix: string): Promise<void>;
	exists(key: string): Promise<boolean>;
}
