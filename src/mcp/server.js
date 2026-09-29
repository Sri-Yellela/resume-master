// E1 — the MCP server. ONE server, in this service, not a second one: the same deterministic tools
// the HTTP API exposes (src/tools/deterministic.js), in a different envelope.
//
// ⛔ THE TOOL TABLE IS NOT WRITTEN HERE. It is read from the GENERATED contract
// (contract/resume-master-api.v1.json, `x-mcp.tools`), which scripts/generateContract.mjs produces
// from the HTTP contract's own schemas — the tool's inputSchema IS its endpoint's request schema.
// A stale contract fails `npm test`, and test/mcp.test.js fails if what this serves differs from it.
// All this file adds is the dispatch from a tool name to the one implementation.
//
// ⛔ STATELESS. A fresh Server and transport per HTTP request, `sessionIdGenerator: undefined`, JSON
// responses (no SSE stream to hold open). No session, nothing retained between requests. GET and
// DELETE — which exist in the transport only to hold an SSE stream and to end a session — answer 405.
//
// ⛔ NO CONTENT IS LOGGED. One metering line per tool call (client, route, counts — all zero here,
// because nothing here calls a model) and, on an internal failure, an error's code and name. The
// transport's own error messages are never logged: they can quote the request.
//
// ⛔ AUTH IS NOT HERE. The /mcp routes sit behind the same requireClient middleware as /v1, mounted
// BEFORE the body parser (src/http/app.js), so an unauthenticated or unconfigured request is refused
// before its body is read — identically to the HTTP API.
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { scoreAts, formatResume, atsOutcome, ATS_OUTCOME } from "../tools/deterministic.js";
import { InvalidRequestError } from "../errors.js";

export const CONTRACT_FILE = new URL("../../contract/resume-master-api.v1.json", import.meta.url);

export const MCP_INSTRUCTIONS = [
  "Resume Master's deterministic résumé tools. Stateless: nothing you send is stored or logged, and no tool here " +
  "calls a model — every result is reproducible from its input.",
  "score_ats_fit may DECLINE (outcome \"not_enough_signal\", score null). That is a refusal to guess, not a low " +
  "score: report it as \"could not be scored\" with the reasons, never as a poor fit.",
  "format_resume_print_html returns print-ready HTML, not a PDF, and does not check or change what a résumé claims.",
  "Résumé generation is not offered here.",
].join(" ");

/** The generated tool table. Throws if the contract carries none — a server with no tools is a defect, not a state. */
export function loadMcpContract(file = CONTRACT_FILE) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const tools = doc["x-mcp"]?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("contract/ has no x-mcp tools — run `npm run contract`");
  }
  return { contractVersion: doc.info.version, tools };
}

/** What tools/list serves: the contract's entry minus its `x-` bookkeeping keys, otherwise verbatim. */
export const servedTool = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("x-")));

const PDF_NOTE = "This is print-ready HTML, not a PDF — there is no server-side PDF. Open it in a browser and print to PDF.";

// name -> (arguments) => { structuredContent, lead }. `lead` is the first line of the text content,
// which is what many clients show the model; for a declined score it is the refusal's meaning.
const IMPLEMENTATIONS = {
  score_ats_fit(args) {
    const result = atsOutcome(scoreAts(args).report);
    const lead = result.outcome === ATS_OUTCOME.SCORED
      ? `Scored ${result.score}/100 against this posting. ${result.meaning}`
      : `${result.meaning} Reasons: ${(result.report.decline_reasons || []).join(" ") || "(none given)"}`;
    return { structuredContent: result, lead };
  },
  format_resume_print_html(args) {
    const { html } = formatResume(args);
    return { structuredContent: { html, contentType: "text/html", howToGetPdf: PDF_NOTE }, lead: PDF_NOTE };
  },
};

function refusal(error, message, retryable, meaning) {
  return { isError: true, content: [{ type: "text", text: `${meaning}\n${JSON.stringify({ error, message, retryable })}` }] };
}

/**
 * @returns { post, errors, methodNotAllowed } express handlers for /mcp. The contract is read ONCE,
 *          here, at app construction — a missing or empty tool table refuses to boot.
 */
export function mcpHandlers({ metering, log, version = {}, contractFile = CONTRACT_FILE } = {}) {
  const { tools } = loadMcpContract(contractFile);
  const served = tools.map(servedTool);
  const names = tools.map(t => t.name);
  const unimplemented = names.filter(n => !IMPLEMENTATIONS[n]);
  const undeclared = Object.keys(IMPLEMENTATIONS).filter(n => !names.includes(n));
  if (unimplemented.length || undeclared.length) {
    throw new Error(`MCP tool table and implementations disagree — in the contract only: [${unimplemented}], ` +
      `implemented only: [${undeclared}]. Declare tools in src/contract/endpoints.js MCP_TOOLS and regenerate.`);
  }

  function buildServer(clientId) {
    const server = new Server({ name: "resume-master", version: String(version.version ?? "0.0.0") },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
    server.onerror = (e) => log({ error: "mcp_protocol_error", name: e?.name ?? "Error" });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: served }));

    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const impl = Object.hasOwn(IMPLEMENTATIONS, params.name) ? IMPLEMENTATIONS[params.name] : null;
      if (!impl) throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${String(params.name).slice(0, 64)}`);
      const route = `mcp.${params.name}`;
      // The limit hook, before any work — MCP is the first caller that can loop. Limits are OFF.
      if (!metering.allow(clientId, route)) {
        metering.record(clientId, route, [], { via: "mcp", result: "limit_exceeded" });
        return refusal("limit_exceeded", "this client's limit is reached", true,
          "Refused: this client's usage limit is reached. It says nothing about the résumé; retry later.");
      }
      try {
        const { structuredContent, lead } = impl(params.arguments ?? {});
        metering.record(clientId, route, [], { via: "mcp", result: "ok" });
        return { content: [{ type: "text", text: `${lead}\n${JSON.stringify(structuredContent)}` }], structuredContent };
      } catch (e) {
        if (e instanceof InvalidRequestError) {
          metering.record(clientId, route, [], { via: "mcp", result: "invalid_request" });
          return refusal("invalid_request", e.message, false,
            "Refused: the input was malformed. This is not a result and says nothing about the résumé.");
        }
        metering.record(clientId, route, [], { via: "mcp", result: "internal_error" });
        log({ error: e?.code || e?.name || "error", route });
        return refusal("internal_error", "internal error", false, "Failed: an internal error. No result was produced.");
      }
    });
    return server;
  }

  return {
    async post(req, res, next) {
      const server = buildServer(req.client.id);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transport.onerror = (e) => log({ error: "mcp_transport_error", name: e?.name ?? "Error" });
      res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) { next(e); }
    },

    // Route-level: express.json's refusals, answered in JSON-RPC like everything else past auth.
    // eslint-disable-next-line no-unused-vars
    errors(err, _req, res, next) {
      if (err.type === "entity.parse.failed") return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } });
      if (err.type === "entity.too.large") return res.status(413).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Payload too large" } });
      next(err);
    },

    methodNotAllowed(_req, res) {
      res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", id: null, error: { code: -32000,
        message: "Method not allowed: this MCP server is stateless — POST only; there is no SSE stream to open and no session to end." } });
    },
  };
}
