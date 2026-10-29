import type { Api, FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { VideoContent } from "./types";

export interface VideoOptions {
	apiKey: ApiKey;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

/** Non-2xx response from a video generation endpoint. */
export class VideoApiError extends AIError.ProviderHttpError {
	override readonly name = "VideoApiError";
}

export function videoBaseUrl(model: Model<Api>): string {
	return model.baseUrl.replace(/\/+$/, "");
}

export async function videoResponseError(response: Response, model: Model<Api>): Promise<VideoApiError> {
	const text = await response.text();
	let detail = text;
	let code: string | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			const error = parsed.error;
			if (typeof error === "string") detail = error;
			else if (error && typeof error === "object") {
				const envelope = error as { message?: unknown; code?: unknown; type?: unknown };
				if (typeof envelope.message === "string") detail = envelope.message;
				if (typeof envelope.code === "string") code = envelope.code;
				else if (typeof envelope.type === "string") code = envelope.type;
			}
		}
	} catch {}
	return new VideoApiError(
		`${model.provider}/${model.id} video API error (${response.status}): ${detail || response.statusText}`,
		response.status,
		{ headers: response.headers, code },
	);
}

/** Fetch `url` with the model's bearer credential, retrying through the key resolver. */
export function authenticatedVideoFetch(
	model: Model<Api>,
	url: string,
	options: VideoOptions,
	init?: Omit<RequestInit, "signal">,
): Promise<Response> {
	const fetchImpl = options.fetch ?? fetch;
	return withAuth(
		options.apiKey,
		async key => {
			const response = await fetchImpl(url, {
				...init,
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...init?.headers },
				signal: options.signal,
			});
			if (!response.ok) throw await videoResponseError(response, model);
			return response;
		},
		{ signal: options.signal },
	);
}

/** Wrap a successful content response without buffering the video bytes. */
export function videoContent(response: Response, model: Model<Api>): VideoContent {
	if (!response.body) {
		throw new AIError.ProviderResponseError(`${model.provider}/${model.id} video content response has no body`, {
			provider: model.provider,
			kind: "envelope",
		});
	}
	const contentLengthHeader = response.headers.get("content-length");
	const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
	return {
		body: response.body,
		contentType: response.headers.get("content-type") ?? "application/octet-stream",
		...(contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0
			? { contentLength }
			: {}),
	};
}

/** Usage carrying only a provider-reported USD total; video wires bill per output second, not per token. */
export function videoCostUsage(total: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}
