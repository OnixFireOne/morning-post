/**
 * Thrown by capture.ts/telegram.ts specifically when retries were attempted
 * and exhausted — as opposed to a failure that gave up immediately (e.g. a
 * non-retryable 4xx from Telegram). index.ts reads `.retries` to put "число
 * исчерпанных ретраев" in the admin alert; other failures just omit that line.
 */
export class RetryExhaustedError extends Error {
	readonly retries: number;

	constructor(message: string, retries: number, options?: ErrorOptions) {
		super(message, options);
		this.name = "RetryExhaustedError";
		this.retries = retries;
	}
}
