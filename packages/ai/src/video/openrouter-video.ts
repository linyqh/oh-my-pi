import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import { authenticatedVideoFetch, type VideoOptions, videoBaseUrl, videoContent, videoCostUsage } from "./transport";
import type {
	VideoAudioReference,
	VideoContent,
	VideoFrameImage,
	VideoGenerationRequest,
	VideoImageReference,
	VideoInputReference,
	VideoJob,
	VideoVideoReference,
} from "./types";

const videoJobSchema = type({
	id: "string > 0",
	status: "'queued' | 'processing' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired'",
	"polling_url?": "string",
	"generation_id?": "string",
	"unsigned_urls?": "string[]",
	"error?": "string",
	"usage?": "object",
});

function imageReference(reference: VideoImageReference): Record<string, unknown> {
	return { type: reference.type, image_url: reference.imageUrl };
}

function frameImage(reference: VideoFrameImage): Record<string, unknown> {
	return { ...imageReference(reference), frame_type: reference.frameType };
}

function inputReference(reference: VideoInputReference): Record<string, unknown> {
	switch (reference.type) {
		case "image_url":
			return imageReference(reference);
		case "audio_url":
			return { type: reference.type, audio_url: (reference as VideoAudioReference).audioUrl };
		case "video_url":
			return { type: reference.type, video_url: (reference as VideoVideoReference).videoUrl };
	}
}

function encodeRequest(model: Model<Api>, request: VideoGenerationRequest): Record<string, unknown> {
	return {
		model: model.requestModelId ?? model.id,
		...(request.prompt !== undefined && { prompt: request.prompt }),
		...(request.duration !== undefined && { duration: request.duration }),
		...(request.resolution !== undefined && { resolution: request.resolution }),
		...(request.aspectRatio !== undefined && { aspect_ratio: request.aspectRatio }),
		...(request.size !== undefined && { size: request.size }),
		...(request.frameImages !== undefined && { frame_images: request.frameImages.map(frameImage) }),
		...(request.inputReferences !== undefined && {
			input_references: request.inputReferences.map(inputReference),
		}),
		...(request.generateAudio !== undefined && { generate_audio: request.generateAudio }),
		...(request.seed !== undefined && { seed: request.seed }),
		...(request.callbackUrl !== undefined && { callback_url: request.callbackUrl }),
		...(request.provider !== undefined && { provider: request.provider }),
		...(request.previousJobId !== undefined && { previous_job_id: request.previousJobId }),
		...(request.sessionId !== undefined && { session_id: request.sessionId }),
		...(request.trace !== undefined && { trace: request.trace }),
		...(request.user !== undefined && { user: request.user }),
		...(request.creativity !== undefined && { creativity: request.creativity }),
		...(request.upscaleFactor !== undefined && { upscale_factor: request.upscaleFactor }),
	};
}

function decodeUsage(raw: unknown): Usage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const cost = "cost" in raw && typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : undefined;
	return cost === undefined ? undefined : videoCostUsage(cost);
}

async function decodeJob(response: Response, model: Model<Api>): Promise<VideoJob> {
	const body: unknown = await response.json();
	const parsed = videoJobSchema(body);
	if (parsed instanceof type.errors) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} video response is malformed: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	const usage = decodeUsage(parsed.usage);
	return {
		id: parsed.id,
		status: parsed.status,
		...(parsed.polling_url !== undefined && { pollingUrl: parsed.polling_url }),
		...(parsed.generation_id !== undefined && { generationId: parsed.generation_id }),
		...(parsed.unsigned_urls !== undefined && { contentUrls: parsed.unsigned_urls }),
		...(parsed.error !== undefined && { error: parsed.error }),
		...(usage !== undefined && { usage }),
	};
}

/** Submit an asynchronous OpenRouter video generation job. */
export async function submitOpenRouterVideo(
	model: Model<Api>,
	request: VideoGenerationRequest,
	options: VideoOptions,
): Promise<VideoJob> {
	const response = await authenticatedVideoFetch(model, `${videoBaseUrl(model)}/videos`, options, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(encodeRequest(model, request)),
	});
	return decodeJob(response, model);
}

/** Poll an asynchronous OpenRouter video generation job. */
export async function pollOpenRouterVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoJob> {
	const response = await authenticatedVideoFetch(
		model,
		`${videoBaseUrl(model)}/videos/${encodeURIComponent(jobId)}`,
		options,
	);
	return decodeJob(response, model);
}

/** Stream generated video bytes from OpenRouter without buffering them in memory. */
export async function downloadOpenRouterVideo(
	model: Model<Api>,
	jobId: string,
	options: VideoOptions,
): Promise<VideoContent> {
	const response = await authenticatedVideoFetch(
		model,
		`${videoBaseUrl(model)}/videos/${encodeURIComponent(jobId)}/content`,
		options,
		{ headers: { Accept: "video/*" } },
	);
	return videoContent(response, model);
}
