/**
 * Typed pipeline errors.
 *
 * The distinction that matters everywhere in this pipeline is *retryable* vs
 * *not*. A 429 or a 503 means "ask again in a moment"; a 404, a bad API key or
 * malformed JSON means "asking again will produce the same thing". Callers
 * branch on `.retryable` rather than sniffing status codes themselves.
 */

export class PipelineError extends Error {
  constructor(message, { cause, retryable = false, meta = {} } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.retryable = retryable;
    this.meta = meta;
  }
}

/** Network or HTTP failure. Retryable on 408/429/5xx and on transport errors. */
export class HttpError extends PipelineError {
  constructor(message, { status, url, body, cause } = {}) {
    const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
    super(message, { cause, retryable, meta: { status, url, body } });
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** The response arrived but did not look like what the parser expected. */
export class ParseError extends PipelineError {
  constructor(message, { source, sample, cause } = {}) {
    super(message, { cause, retryable: false, meta: { source, sample } });
    this.source = source;
  }
}

/** A required credential is absent, so the source is simply unavailable. */
export class MissingCredentialError extends PipelineError {
  constructor(names, humanReason) {
    const list = [].concat(names).join(' or ');
    super(`No credential set: ${list}`, { retryable: false, meta: { names: [].concat(names) } });
    this.names = [].concat(names);
    this.humanReason = humanReason || `needs ${list}`;
  }
}

/** The model replied, but not with JSON matching the requested shape. */
export class LlmSchemaError extends PipelineError {
  constructor(message, { provider, model, raw, cause } = {}) {
    super(message, { cause, retryable: false, meta: { provider, model, raw } });
  }
}

/**
 * There is no reachable free source for this series, and no amount of retrying
 * or key-adding will change that today. `humanReason` is written for the tile,
 * not for a log: it is shown to whoever is looking at the dashboard.
 */
export class SourceUnavailableError extends PipelineError {
  constructor(humanReason, { detail, cause } = {}) {
    super(detail || humanReason, { cause, retryable: false, meta: { humanReason } });
    this.humanReason = humanReason;
  }
}
