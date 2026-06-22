/**
 * The outcome taxonomy is split along the EXACTLY-ONCE axis (#509 re-red-team).
 * A reminder SMS is real money/dispatch, so the consumer (`classifyNonDelivery`
 * → OutboundGovernor) MUST be able to tell a DEFINITE non-send from an AMBIGUOUS
 * transport failure that MAY have already dispatched:
 *
 *   - `sent` / `queued` — the gateway accepted the message (delivered side).
 *   - `rejected`        — a STRUCTURAL decline: the gateway received the HTTP
 *                         call and explicitly refused the message (parsed
 *                         StatusId != 1 on an HTTP 2xx, or an HTTP 4xx client
 *                         error — bad creds/payload/number). The SMS provably
 *                         did NOT go out → DEFINITE → re-claimable (safe retry).
 *   - `failed`          — a TRANSPORT-AMBIGUOUS failure: the socket dropped /
 *                         timed out / the gateway returned 5xx / the body was
 *                         unparseable on a 2xx. The gateway MAY have already
 *                         dispatched before the error surfaced → AMBIGUOUS →
 *                         NEVER auto-resent (parked for human disambiguation).
 *
 * Providers MUST NOT flatten transport failures into `rejected`. Reserve
 * `rejected` for the structural-decline case ONLY. When in doubt → `failed`
 * (the SAFE side — exactly-once is sacred).
 */
export interface SMSDeliveryResult {
  id: string;
  status: 'sent' | 'queued' | 'rejected' | 'failed';
  error?: string;
}

export interface ISMSProvider {
  send(to: string, body: string): Promise<SMSDeliveryResult>;
  healthCheck(): Promise<void>;
}
