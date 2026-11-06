// The caller's mistake, as opposed to an outage. Its own module so that the deterministic tools can
// raise it without importing the generation kernel — whose import graph reaches the model client.
// The MCP guard (test/mcp.test.js) walks the ATS tool's imports and fails if any of them can reach
// a model; before this module existed, InvalidRequestError lived in generation/generate.js and
// would have dragged anthropicCall.js into that graph for the sake of one class.
export class InvalidRequestError extends Error {
  constructor(message) { super(message); this.name = "InvalidRequestError"; this.code = "invalid_request"; }
}

// 1.9.0: the base résumé is real text but no section heading in it could be read, so a tailoring would return the
// header alone (the 11-05 run: 80 of 1,466 characters, answered 200). Permanent — the same base reads the same way
// every time; the caller fixes the headings or sends the résumé as HTML.
export class ResumeUnparsedError extends Error {
  constructor(message) { super(message); this.name = "ResumeUnparsedError"; this.code = "resume_unparsed"; this.permanent = true; }
}
