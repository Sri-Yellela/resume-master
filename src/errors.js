// The caller's mistake, as opposed to an outage. Its own module so that the deterministic tools can
// raise it without importing the generation kernel — whose import graph reaches the model client.
// The MCP guard (test/mcp.test.js) walks the ATS tool's imports and fails if any of them can reach
// a model; before this module existed, InvalidRequestError lived in generation/generate.js and
// would have dragged anthropicCall.js into that graph for the sake of one class.
export class InvalidRequestError extends Error {
  constructor(message) { super(message); this.name = "InvalidRequestError"; this.code = "invalid_request"; }
}
