import { describe, expect, it } from "bun:test";
import { downloadXaiVideo, pollXaiVideo, submitXaiVideo, VideoApiError } from "@oh-my-pi/pi-ai/video";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const VIDEO_BYTES = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

interface Recorded {
	url: string;
	method: string;
	authorization: string | null;
	body?: unknown;
}

function model(baseUrl: string): Model<Api> {
	return buildModel({
		id: "grok-imagine-video-1.5",
		name: "Grok Imagine Video 1.5",
		api: "xai-video",
		provider: "xai",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "video",
	} satisfies ModelSpec<Api>);
}

function upstream(routes: Record<string, () => Response>): { fetch: FetchImpl; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url,
			method,
			authorization: new Headers(init?.headers).get("authorization"),
			...(body !== undefined && { body }),
		});
		const route = routes[`${method} ${url}`];
		return route ? route() : Response.json({ error: "unexpected" }, { status: 500 });
	};
	return { fetch: fetchImpl, calls };
}

function doneJob(url: string): () => Response {
	return () =>
		Response.json({
			model: "grok-imagine-video-1.5",
			progress: 100,
			status: "done",
			usage: { cost_in_usd_ticks: 1_600_000_000 },
			video: { duration: 2, respect_moderation: true, url },
		});
}

function videoResponse(): Response {
	return new Response(VIDEO_BYTES, { headers: { "Content-Type": "video/mp4" } });
}

describe("xai-video transport", () => {
	it("encodes canonical frames, references, and provider options onto the xAI generations wire", async () => {
		const { fetch, calls } = upstream({
			"POST https://api.x.ai/v1/videos/generations": () => Response.json({ request_id: "req-1" }),
		});
		const job = await submitXaiVideo(
			model("https://api.x.ai/v1"),
			{
				prompt: "<IMAGE_1> speaks with <AUDIO_0>",
				duration: 6,
				resolution: "720p",
				aspectRatio: "9:16",
				frameImages: [
					{ type: "image_url", imageUrl: { url: "https://example.com/first.png" }, frameType: "first_frame" },
					{ type: "image_url", imageUrl: { url: "https://example.com/last.png" }, frameType: "last_frame" },
				],
				inputReferences: [{ type: "image_url", imageUrl: { url: "https://example.com/ref.png" } }],
				provider: { options: { reference_audios: [{ voice_id: "eve" }] } },
			},
			{ apiKey: "xai-secret", fetch },
		);
		expect(job).toEqual({ id: "req-1", status: "pending" });
		expect(calls).toEqual([
			{
				url: "https://api.x.ai/v1/videos/generations",
				method: "POST",
				authorization: "Bearer xai-secret",
				body: {
					reference_audios: [{ voice_id: "eve" }],
					model: "grok-imagine-video-1.5",
					prompt: "<IMAGE_1> speaks with <AUDIO_0>",
					duration: 6,
					resolution: "720p",
					aspect_ratio: "9:16",
					image: { url: "https://example.com/first.png" },
					last_frame: { url: "https://example.com/last.png" },
					reference_images: [{ url: "https://example.com/ref.png" }],
				},
			},
		]);
	});

	it("rejects canonical fields the xAI wire cannot carry before dispatch", async () => {
		const { fetch, calls } = upstream({});
		await expect(
			submitXaiVideo(
				model("https://api.x.ai/v1"),
				{ prompt: "x", seed: 7, generateAudio: true },
				{ apiKey: "k", fetch },
			),
		).rejects.toThrow("xai-video does not support generateAudio, seed");
		expect(calls).toHaveLength(0);
	});

	it("maps done to completed, converts cost ticks to USD, and resolves relay-relative content URLs", async () => {
		const { fetch } = upstream({
			"GET http://relay.test:8080/v1/videos/req-1": doneJob("/v1/videos/req-1/content"),
		});
		const job = await pollXaiVideo(model("http://relay.test:8080/v1"), "req-1", { apiKey: "k", fetch });
		expect(job).toEqual({
			id: "req-1",
			status: "completed",
			contentUrls: ["http://relay.test:8080/v1/videos/req-1/content"],
			usage: expect.objectContaining({ cost: expect.objectContaining({ total: 0.16 }) }),
		});
	});

	it("sends the bearer to a same-origin relay content URL", async () => {
		const { fetch, calls } = upstream({
			"GET http://relay.test:8080/v1/videos/req-1": doneJob("/v1/videos/req-1/content"),
			"GET http://relay.test:8080/v1/videos/req-1/content": videoResponse,
		});
		const content = await downloadXaiVideo(model("http://relay.test:8080/v1"), "req-1", {
			apiKey: "relay-key",
			fetch,
		});
		expect(new Uint8Array(await new Response(content.body).arrayBuffer())).toEqual(VIDEO_BYTES);
		expect(content.contentType).toBe("video/mp4");
		expect(calls.at(-1)).toMatchObject({
			url: "http://relay.test:8080/v1/videos/req-1/content",
			authorization: "Bearer relay-key",
		});
	});

	it("never sends the bearer to a cross-origin presigned content URL", async () => {
		const presigned = "https://vidgen.x.ai/xai-vidgen-bucket/req-1.mp4";
		const { fetch, calls } = upstream({
			"GET https://api.x.ai/v1/videos/req-1": doneJob(presigned),
			[`GET ${presigned}`]: videoResponse,
		});
		await downloadXaiVideo(model("https://api.x.ai/v1"), "req-1", { apiKey: "xai-secret", fetch });
		expect(calls.at(-1)).toMatchObject({ url: presigned, authorization: null });
	});

	it("refuses to download an unfinished job", async () => {
		const { fetch, calls } = upstream({
			"GET https://api.x.ai/v1/videos/req-1": () => Response.json({ status: "pending", progress: 10 }),
		});
		const error = await downloadXaiVideo(model("https://api.x.ai/v1"), "req-1", { apiKey: "k", fetch }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(VideoApiError);
		expect((error as VideoApiError).status).toBe(409);
		expect(calls).toHaveLength(1);
	});
});
