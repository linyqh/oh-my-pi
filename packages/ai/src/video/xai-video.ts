import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import {
	authenticatedVideoFetch,
	type VideoOptions,
	VideoApiError,
	videoBaseUrl,
	videoContent,
	videoCostUsage,
	videoResponseError,
} from "./transport";
import type { VideoContent, VideoGenerationRequest, VideoJob, VideoJobStatus } from "./types";

/** xAI reports cost in integer ticks of 1e-10 USD. */
const USD_PER_TICK = 1e-10;

const submitResponseSchema = type({ request_id: "string > 0" });

const jobResponseSchema = type({
	status: "'pending' | 'done' | 'failed' | 'expired'",
	"video?": { "url?": "string" },
	"usage?": "object",
	"error?": "unknown",
});

const STATUS: Record<(typeof jobResponseSchema.infer)["status"], VideoJobStatus> = {
	pending: "pending",
	done: "completed",
	failed: "failed",
	expired: "expired",
};

const UNSUPPORTED_FIELDS = [
	"size",
	"generateAudio",
	"seed",
	"callbackUrl",
	"previousJobId",
	"sessionId",
	"trace",
	"user",
	"creativity",
	"upscaleFactor",
] as const satisfies readonly (keyof VideoGenerationRequest)[];

function encodeRequest(model: Model<Api>, request: VideoGenerationRequest): Record<string, unknown> {
	const unsupported = UNSUPPORTED_FIELDS.filter(field => request[field] !== undefined);
	if (unsupported.length > 0) {
		throw new AIError.ValidationError(`xai-video does not support ${unsupported.join(", ")}`);
	}
	let firstFrame: { url: string } | undefined;
	let lastFrame: { url: string } | undefined;
	for (const frame of request.frameImages ?? []) {
		if (frame.frameType === "first_frame") {
			if (firstFrame) throw new AIError.ValidationError("xai-video accepts one first_frame image");
			firstFrame = { url: frame.imageUrl.url };
		} else {
			if (lastFrame) throw new AIError.ValidationError("xai-video accepts one last_frame image");
			lastFrame = { url: frame.imageUrl.url };
		}
	}
	const referenceImages: { url: string }[] = [];
	const referenceAudios: { url: string }[] = [];
	for (const reference of request.inputReferences ?? []) {
		switch (reference.type) {
			case "image_url":
				referenceImages.push({ url: reference.imageUrl.url });
				break;
			case "audio_url":
				referenceAudios.push({ url: reference.audioUrl.url });
				break;
			case "video_url":
				throw new AIError.ValidationError("xai-video generation does not accept video references");
		}
	}
	return {
		// xAI-specific fields (e.g. preset `reference_audios: [{ voice_id }]`) ride provider options.
		...request.provider?.options,
		model: model.requestModelId ?? model.id,
		...(request.prompt !== undefined && { prompt: request.prompt }),
		...(request.duration !== undefined && { duration: request.duration }),
		...(request.resolution !== undefined && { resolution: request.resolution }),
		...(request.aspectRatio !== undefined && { aspect_ratio: request.aspectRatio }),
		...(firstFrame && { image: firstFrame }),
		...(lastFrame && { last_frame: lastFrame }),
		...(referenceImages.length > 0 && { reference_images: referenceImages }),
		...(referenceAudios.length > 0 && { reference_audios: referenceAudios }),
	};
}

function malformed(model: Model<Api>, summary: string): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError(`${model.provider}/${model.id} video response is malformed: ${summary}`, {
		provider: model.provider,
		kind: "envelope",
	});
}

function decodeUsage(raw: object | undefined): Usage | undefined {
	if (!raw || !("cost_in_usd_ticks" in raw)) return undefined;
	const ticks = raw.cost_in_usd_ticks;
	return typeof ticks === "number" && Number.isFinite(ticks) ? videoCostUsage(ticks * USD_PER_TICK) : undefined;
}

function decodeError(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") return raw;
	if (typeof raw === "object" && "message" in raw && typeof raw.message === "string") return raw.message;
	return JSON.stringify(raw);
}

/** Relays answer a path-relative content URL on their own origin; xAI answers an absolute presigned URL. */
function resolveContentUrl(model: Model<Api>, url: string): string {
	return new URL(url, `${videoBaseUrl(model)}/`).href;
}

async function fetchJob(
	model: Model<Api>,
	jobId: string,
	options: VideoOptions,
): Promise<{ job: VideoJob; contentUrl?: string }> {
	const response = await authenticatedVideoFetch(
		model,
		`${videoBaseUrl(model)}/videos/${encodeURIComponent(jobId)}`,
		options,
	);
	const parsed = jobResponseSchema(await response.json());
	if (parsed instanceof type.errors) throw malformed(model, parsed.summary);
	const status = STATUS[parsed.status];
	const contentUrl = parsed.video?.url ? resolveContentUrl(model, parsed.video.url) : undefined;
	if (status === "completed" && contentUrl === undefined) throw malformed(model, "completed job has no video.url");
	const usage = decodeUsage(parsed.usage);
	const error = decodeError(parsed.error);
	return {
		job: {
			id: jobId,
			status,
			...(contentUrl !== undefined && { contentUrls: [contentUrl] }),
			...(error !== undefined && { error }),
			...(usage !== undefined && { usage }),
		},
		contentUrl,
	};
}

/** Submit an asynchronous xAI video generation job (`POST /videos/generations`). */
export async function submitXaiVideo(
	model: Model<Api>,
	request: VideoGenerationRequest,
	options: VideoOptions,
): Promise<VideoJob> {
	const response = await authenticatedVideoFetch(model, `${videoBaseUrl(model)}/videos/generations`, options, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(encodeRequest(model, request)),
	});
	const parsed = submitResponseSchema(await response.json());
	if (parsed instanceof type.errors) throw malformed(model, parsed.summary);
	return { id: parsed.request_id, status: "pending" };
}

/** Poll an asynchronous xAI video generation job. */
export async function pollXaiVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoJob> {
	return (await fetchJob(model, jobId, options)).job;
}

/**
 * Stream a finished xAI video. The bearer credential is sent only when the
 * content URL shares the model base URL's origin, never to a presigned CDN host.
 */
export async function downloadXaiVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoContent> {
	const { job, contentUrl } = await fetchJob(model, jobId, options);
	if (job.status !== "completed" || contentUrl === undefined) {
		throw new VideoApiError(
			`${model.provider}/${model.id} video job ${jobId} is ${job.status}, not completed${job.error ? `: ${job.error}` : ""}`,
			409,
		);
	}
	const init = { headers: { Accept: "video/*" } };
	if (new URL(contentUrl).origin === new URL(videoBaseUrl(model)).origin) {
		return videoContent(await authenticatedVideoFetch(model, contentUrl, options, init), model);
	}
	const response = await (options.fetch ?? fetch)(contentUrl, { ...init, signal: options.signal });
	if (!response.ok) throw await videoResponseError(response, model);
	return videoContent(response, model);
}
