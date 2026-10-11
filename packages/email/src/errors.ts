/** Any failure to send: the caller answers it and undoes what it did for the message. */
export class EmailError extends Error {}

/** The sender was created without something it needs. Named, so a missing key is never a silent no-op. */
export class EmailNotConfigured extends EmailError {
  override name = "EmailNotConfigured";
}

/** A header-like value cannot go out as written: a caller's defect, never a state of the deployment. */
export class InvalidHeader extends EmailError {
  override name = "InvalidHeader";
}

/** SendGrid refused the message (`status`), or the request never reached it (`status` null). */
export class EmailNotSent extends EmailError {
  override name = "EmailNotSent";
  readonly status: number | null;
  constructor(status: number | null) {
    super(
      status === null ? "SendGrid unreachable" : `SendGrid answered ${status}`,
    );
    this.status = status;
  }
}

/** The status a route answers a failed send with: 503 when the server has no sender, 502 when SendGrid failed. */
export function failureStatus(error: EmailError): 502 | 503 {
  return error instanceof EmailNotConfigured ? 503 : 502;
}

/**
 * A refusal that is about the sender and not the person written to: the key (401), the sender's permission
 * (403), the rate (429) or the service itself (5xx). The next recipient would get the same answer, so a run
 * that writes to many has to stop.
 */
export function isSenderRefusal(status: number | null): status is number {
  return (
    status === 401 || status === 403 || status === 429 || (status ?? 0) >= 500
  );
}
