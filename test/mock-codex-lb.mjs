// A zero-dependency local stand-in for codex-lb, built on Bun.serve.
//
// Serves:
//   - WebSocket at  <base>/responses  speaking the OpenAI Responses protocol
//     (codex.rate_limits + response.* frames), the path the plugin upgrades to.
//   - HTTP  POST    <base>/responses  (SSE) as a fallback transport.
//   - HTTP  GET     <base>/models     a minimal model list.
//
// Modes: ok | error429 | closeEarly | hang. Logs each WS upgrade (with the
// session-id / authorization headers) so an e2e harness can assert the WS path
// was taken and that one socket is reused per session.
//
// Run:  bun test/mock-codex-lb.mjs <port> [mode] [reply]

const port = Number(process.argv[2] ?? 0);
const mode = process.argv[3] ?? "ok";
const reply = process.argv[4] ?? process.env.MOCK_REPLY ?? "OK";

let wsConnections = 0;
let responseCreates = 0;

function userText(body) {
	const input = body?.input;
	if (typeof input === "string") return input;
	if (!Array.isArray(input)) return "";
	for (let i = input.length - 1; i >= 0; i--) {
		const item = input[i];
		if (item?.role !== "user") continue;
		const content = item.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const part = content.find((p) => typeof p?.text === "string");
			if (part) return part.text;
		}
	}
	return "";
}

function* okFrames(body, text) {
	const rid = "resp_mock_1";
	const mid = "msg_mock_1";
	const base = { id: rid, object: "response", status: "in_progress", model: body?.model ?? "gpt-5.5", output: [] };
	yield { type: "codex.rate_limits", plan_type: "pro", rate_limits: { primary: { used_percent: 1 } } };
	yield { type: "response.created", response: { ...base } };
	yield { type: "response.in_progress", response: { ...base } };
	yield {
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 1,
		item: { id: mid, type: "message", status: "in_progress", role: "assistant", content: [] },
	};
	yield {
		type: "response.content_part.added",
		item_id: mid,
		output_index: 0,
		content_index: 0,
		sequence_number: 2,
		part: { type: "output_text", text: "", annotations: [] },
	};
	yield { type: "response.output_text.delta", item_id: mid, output_index: 0, content_index: 0, sequence_number: 3, delta: text };
	yield { type: "response.output_text.done", item_id: mid, output_index: 0, content_index: 0, sequence_number: 4, text };
	yield {
		type: "response.content_part.done",
		item_id: mid,
		output_index: 0,
		content_index: 0,
		sequence_number: 5,
		part: { type: "output_text", text, annotations: [] },
	};
	yield {
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 6,
		item: { id: mid, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
	};
	yield {
		type: "response.completed",
		sequence_number: 7,
		response: {
			...base,
			status: "completed",
			output: [{ id: mid, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
			usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
		},
	};
}

// Main turn that asks the agent to call the web_search tool (function call).
function* webSearchCallFrames(body, query) {
	const rid = "resp_ws_1";
	const fid = "fc_ws_1";
	const cid = "call_ws_1";
	const args = JSON.stringify({ query });
	yield { type: "response.created", response: { id: rid, object: "response", status: "in_progress", model: body?.model ?? "gpt-5.5", output: [] } };
	yield { type: "response.output_item.added", output_index: 0, sequence_number: 1, item: { id: fid, type: "function_call", status: "in_progress", call_id: cid, name: "web_search", arguments: "" } };
	yield { type: "response.function_call_arguments.delta", item_id: fid, output_index: 0, sequence_number: 2, delta: args };
	yield { type: "response.function_call_arguments.done", item_id: fid, output_index: 0, sequence_number: 3, arguments: args };
	yield { type: "response.output_item.done", output_index: 0, sequence_number: 4, item: { id: fid, type: "function_call", status: "completed", call_id: cid, name: "web_search", arguments: args } };
	yield { type: "response.completed", sequence_number: 5, response: { id: rid, object: "response", status: "completed", model: body?.model ?? "gpt-5.5", output: [{ id: fid, type: "function_call", status: "completed", call_id: cid, name: "web_search", arguments: args }], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } };
}

// HTTP /responses web-search reply: answer text + url_citation sources.
function* searchResultFrames(body) {
	const rid = "resp_search_1";
	const mid = "msg_search_1";
	const answer = "Cats purr to communicate contentment and to self-soothe.";
	const base = { id: rid, object: "response", status: "in_progress", model: body?.model ?? "gpt-5.5", output: [] };
	yield { type: "response.created", response: { ...base } };
	yield { type: "response.output_text.delta", item_id: mid, output_index: 0, content_index: 0, delta: answer };
	yield {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			id: mid,
			type: "message",
			status: "completed",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: answer,
					annotations: [
						{ type: "url_citation", url: "https://example.org/cats-purr", title: "Why Cats Purr" },
						{ type: "url_citation", url: "https://example.org/feline-behavior", title: "Feline Behavior" },
					],
				},
			],
		},
	};
	yield { type: "response.completed", response: { ...base, status: "completed", model: body?.model ?? "gpt-5.5", usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80, input_tokens_details: { cached_tokens: 0 } } } };
}

function bodyHasWebSearch(body) {
	const tools = Array.isArray(body?.tools) ? body.tools : [];
	if (tools.some((t) => t && t.type === "web_search")) return true;
	return body?.tool_choice && body.tool_choice.type === "web_search";
}

function errorFrame() {
	return {
		type: "error",
		status: 429,
		error: {
			message: "No available accounts. Service is operating in degraded mode: all upstream accounts are unavailable",
			type: "rate_limit_error",
			code: "account_stream_cap",
		},
	};
}

const MODELS = {
	object: "list",
	data: [
		{ id: "gpt-5.5", object: "model", owned_by: "codex-lb" },
		{ id: "gpt-5.4", object: "model", owned_by: "codex-lb" },
	],
};

const server = Bun.serve({
	port,
	idleTimeout: 120,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/responses")) {
			// WebSocket upgrade path
			if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const ok = srv.upgrade(req, {
					data: {
						sessionId: req.headers.get("session-id") ?? "(none)",
						auth: req.headers.get("authorization") ? "yes" : "no",
						beta: req.headers.get("openai-beta") ?? "",
					},
				});
				if (ok) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			// HTTP/SSE fallback
			if (req.method === "POST") {
				return handleHttpResponses(req);
			}
		}
		if (req.method === "GET" && url.pathname.endsWith("/models")) {
			return Response.json(MODELS);
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			wsConnections++;
			console.error(`[mock] WS open #${wsConnections} session-id=${ws.data.sessionId} auth=${ws.data.auth} beta=${ws.data.beta}`);
		},
		message(ws, message) {
			let body;
			try {
				body = JSON.parse(typeof message === "string" ? message : message.toString());
			} catch {
				return;
			}
			if (body?.type !== "response.create") return;
			responseCreates++;
			ws.createCount = (ws.createCount ?? 0) + 1;
			console.error(`[mock] response.create #${responseCreates} (socket turn ${ws.createCount}) model=${body.model} text=${JSON.stringify(userText(body)).slice(0, 60)}`);
			console.error(`[mock] offered tools: ${JSON.stringify((Array.isArray(body.tools) ? body.tools : []).map((t) => (t.type === "function" ? `fn:${t.name}` : t.type)))}`);
			if (mode === "hang") return;
			if (mode === "error429") {
				ws.send(JSON.stringify(errorFrame()));
				return;
			}
			if (mode === "closeEarly") {
				ws.send(JSON.stringify({ type: "response.created", response: { id: "resp_mock_1", object: "response", status: "in_progress" } }));
				setTimeout(() => ws.close(), 20);
				return;
			}
			if (mode === "websearch") {
				// Turn 1: ask the agent to call web_search. Turn 2+: answer using the result.
				if (ws.createCount === 1) {
					console.error("[mock] -> emitting web_search tool call");
					for (const frame of webSearchCallFrames(body, userText(body) || "why do cats purr")) ws.send(JSON.stringify(frame));
				} else {
					for (const frame of okFrames(body, "Final answer: cats purr to communicate (per web search).")) ws.send(JSON.stringify(frame));
				}
				return;
			}
			for (const frame of okFrames(body, reply)) ws.send(JSON.stringify(frame));
		},
		close(_ws) {
			console.error(`[mock] WS close`);
		},
	},
});

async function handleHttpResponses(req) {
	const raw = await req.text();
	let body = {};
	try {
		body = JSON.parse(raw);
	} catch {}
	const isSearch = bodyHasWebSearch(body);
	console.error(`[mock] HTTP POST /responses model=${body.model} web_search=${isSearch}`);
	if (isSearch) {
		// Print the exact request so the harness can verify it matches native codex search.
		console.error(`[mock] SEARCH REQUEST BODY: ${JSON.stringify(body)}`);
	}
	if (mode === "error429") {
		return new Response(JSON.stringify(errorFrame()), { status: 429, headers: { "content-type": "application/json" } });
	}
	const frames = isSearch ? searchResultFrames(body) : okFrames(body, reply);
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			for (const frame of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
			controller.enqueue(enc.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

console.log(`mock-codex-lb listening on http://127.0.0.1:${server.port}  (ws path: /v1/responses)  mode=${mode} reply=${JSON.stringify(reply)}`);

process.on("SIGTERM", () => server.stop(true));
process.on("SIGINT", () => server.stop(true));
