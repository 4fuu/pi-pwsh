export interface MetadataSnapshot<T> {
	revision: number;
	metadata: T;
	path: string;
}

export interface MetadataMutationOptions<T> {
	allowCreate?: boolean;
	validate?: (value: unknown) => T;
	beforePublish?: () => void | Promise<void>;
}

export function readLatestMetadataSnapshot<T = unknown>(
	directory: string,
	validate?: (value: unknown) => T,
): Promise<MetadataSnapshot<T>>;

export function mutateMetadataSnapshots<T = unknown>(
	directory: string,
	mutate: (current: T | undefined) => T | undefined | Promise<T | undefined>,
	options?: MetadataMutationOptions<T>,
): Promise<MetadataSnapshot<T>>;

export function renameWithRetry(from: string, to: string): Promise<void>;
