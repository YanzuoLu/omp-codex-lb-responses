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
			console.error(`[mock] response.create #${responseCreates} model=${body.model} text=${JSON.stringify(userText(body)).slice(0, 60)}`);
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
	console.error(`[mock] HTTP POST /responses model=${body.model}`);
	if (mode === "error429") {
		return new Response(JSON.stringify(errorFrame()), { status: 429, headers: { "content-type": "application/json" } });
	}
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			for (const frame of okFrames(body, reply)) controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
			controller.enqueue(enc.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

console.log(`mock-codex-lb listening on http://127.0.0.1:${server.port}  (ws path: /v1/responses)  mode=${mode} reply=${JSON.stringify(reply)}`);

process.on("SIGTERM", () => server.stop(true));
process.on("SIGINT", () => server.stop(true));
