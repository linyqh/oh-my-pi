import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { downloadOpenRouterVideo, pollOpenRouterVideo, submitOpenRouterVideo } from "./openrouter-video";
import type { VideoOptions } from "./transport";
import type { VideoContent, VideoGenerationRequest, VideoJob } from "./types";
import { downloadXaiVideo, pollXaiVideo, submitXaiVideo } from "./xai-video";

export * from "./openrouter-video";
export * from "./transport";
export * from "./types";
export * from "./xai-video";

/** Catalog APIs the video functions serve; the gateway gates on these. */
export const VIDEO_APIS = ["openrouter-video", "xai-video"] as const;
export type VideoApi = (typeof VIDEO_APIS)[number];

/** Whether a catalog API generates video through an asynchronous job transport. */
export function isVideoApi(api: Api): api is VideoApi {
	return api === "openrouter-video" || api === "xai-video";
}

/** Submit an asynchronous video generation job through the model's transport. */
export function submitVideo(
	model: Model<Api>,
	request: VideoGenerationRequest,
	options: VideoOptions,
): Promise<VideoJob> {
	switch (model.api) {
		case "openrouter-video":
			return submitOpenRouterVideo(model, request, options);
		case "xai-video":
			return submitXaiVideo(model, request, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
	}
}

/** Poll an asynchronous video generation job through the model's transport. */
export function pollVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoJob> {
	switch (model.api) {
		case "openrouter-video":
			return pollOpenRouterVideo(model, jobId, options);
		case "xai-video":
			return pollXaiVideo(model, jobId, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
	}
}

/** Stream generated video content through the model's transport. */
export function downloadVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoContent> {
	switch (model.api) {
		case "openrouter-video":
			return downloadOpenRouterVideo(model, jobId, options);
		case "xai-video":
			return downloadXaiVideo(model, jobId, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
	}
}
