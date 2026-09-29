// Pre-stream failures of a chat turn. Each carries the HTTP status the #328
// routes answer with; anything that goes wrong after streaming starts is an
// `error` event instead (see src/agent/loop.ts).

export class ChatError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'ChatError'
  }
}

/** Empty or over-length message → 400, before any model call. */
export class ChatInputError extends ChatError {
  constructor(message: string) {
    super(message, 400, 'invalid_message')
  }
}

/** Missing or foreign thread / action id → 404. Never "forbidden". */
export class ChatNotFoundError extends ChatError {
  constructor() {
    super('Not found', 404, 'not_found')
  }
}

/** Another turn is already running for this user → 409. */
export class ChatTurnInFlightError extends ChatError {
  constructor() {
    super('Another chat turn is already running', 409, 'turn_in_flight')
  }
}

/** Hosted daily spend cap reached → 503. */
export class ChatUnavailableError extends ChatError {
  constructor() {
    super('Chat is temporarily unavailable', 503, 'chat_unavailable')
  }
}
