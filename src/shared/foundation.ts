/** The public M05a probe contract; no platform bindings cross this boundary. */
export interface FoundationResult {
	readonly runtime: 'workerd';
	readonly message: string;
}

export const foundationPath = '/api/foundation';
