import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "web.json");
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CONTENT_CHARS = 20000;
const SEARCH_RESULT_CONTENT_CHARS = 2000;
const MAX_RESULTS_HARD_LIMIT = 20;
const MAX_CONTENT_CHARS_HARD_LIMIT = 100000;
const REQUEST_TIMEOUT_MS = 30000;

const WEB_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: { type: "string", minLength: 1 },
		provider: { type: "string", enum: ["auto", "firecrawl", "exa", "tavily", "native"] },
		limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS_HARD_LIMIT },
		includeDomains: { type: "array", items: { type: "string", minLength: 1 } },
		excludeDomains: { type: "array", items: { type: "string", minLength: 1 } },
		recencyDays: { type: "integer", minimum: 1 },
		includeContent: { type: "boolean" },
	},
	required: ["query"],
	additionalProperties: false,
} as const;

const FETCH_CONTENT_PARAMETERS = {
	type: "object",
	properties: {
		url: { type: "string", minLength: 1 },
		provider: { type: "string", enum: ["auto", "firecrawl", "exa", "tavily", "native"] },
		maxChars: { type: "integer", minimum: 1, maximum: MAX_CONTENT_CHARS_HARD_LIMIT },
		format: { type: "string", enum: ["markdown", "text", "html", "json"] },
		query: { type: "string", minLength: 1 },
	},
	required: ["url"],
	additionalProperties: false,
} as const;

type Provider = "auto" | "firecrawl" | "exa" | "tavily" | "native";
type ContentFormat = "markdown" | "text" | "html" | "json";
interface SearchParams {
	query: string;
	provider?: Provider;
	limit?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	recencyDays?: number;
	includeContent?: boolean;
}
interface FetchContentParams {
	url: string;
	provider?: Provider;
	maxChars?: number;
	format?: ContentFormat;
	query?: string;
}
type ActualProvider = Exclude<Provider, "auto">;

type ApiKeyedProvider = "firecrawl" | "exa" | "tavily";

interface ProviderConfig {
	apiKey?: string;
	baseUrl?: string;
}

interface NativeConfig {
	searchUrl?: string;
}

interface WebConfig {
	defaultSearchProvider?: Provider;
	defaultFetchProvider?: Provider;
	searchProviders?: Provider[];
	fetchProviders?: Provider[];
	fallbackOnProviderError?: boolean;
	fallbackOnEmptySearchResults?: boolean;
	maxResults?: number;
	maxContentChars?: number;
	firecrawl?: ProviderConfig;
	exa?: ProviderConfig;
	tavily?: ProviderConfig;
	native?: NativeConfig;
}

interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	provider: ActualProvider;
	content?: string;
}

interface FetchContentResult {
	url: string;
	title?: string;
	contentType?: string;
	content: string;
	provider: ActualProvider;
	truncated: boolean;
	chars: number;
}

interface SearchDetails {
	query: string;
	provider: ActualProvider;
	results: SearchResult[];
	attempts?: string[];
}

interface FetchDetails extends FetchContentResult {
}

type JsonRecord = Record<string, unknown>;

function readConfig(): WebConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	const raw = readFileSync(CONFIG_PATH, "utf8");
	const data = JSON.parse(raw) as unknown;
	if (!isRecord(data)) {
		throw new Error(`${CONFIG_PATH} must contain a JSON object.`);
	}
	return data as WebConfig;
}

function providerConfig(config: WebConfig, provider: ApiKeyedProvider): ProviderConfig {
	const local = config[provider] ?? {};
	const envName = `${provider.toUpperCase()}_API_KEY`;
	return {
		...local,
		apiKey: process.env[envName] ?? local.apiKey,
	};
}

function resolveSearchProviders(requested: Provider | undefined, config: WebConfig): ActualProvider[] {
	return resolveProviders(requested, config.searchProviders, config.defaultSearchProvider, "firecrawl", "searchProviders");
}

function resolveFetchProviders(requested: Provider | undefined, config: WebConfig): ActualProvider[] {
	return resolveProviders(requested, config.fetchProviders, config.defaultFetchProvider, "firecrawl", "fetchProviders");
}

function resolveProviders(
	requested: Provider | undefined,
	configuredProviders: Provider[] | undefined,
	legacyDefaultProvider: Provider | undefined,
	defaultProvider: ActualProvider,
	configKey: string,
): ActualProvider[] {
	if (requested && requested !== "auto") return [requested];
	const configured = configuredProviders ?? (legacyDefaultProvider && legacyDefaultProvider !== "auto" ? [legacyDefaultProvider] : [defaultProvider]);
	const providers = configured.filter((provider): provider is ActualProvider => isActualProvider(provider));
	if (providers.length === 0 || providers.length !== configured.length) {
		throw new Error(`${CONFIG_PATH}: ${configKey} must contain one or more of: firecrawl, exa, tavily, native.`);
	}
	return providers;
}

function isActualProvider(provider: unknown): provider is ActualProvider {
	return provider === "firecrawl" || provider === "exa" || provider === "tavily" || provider === "native";
}

function clampLimit(limit: number | undefined, config: WebConfig): number {
	const configured = integerOrDefault(config.maxResults, DEFAULT_MAX_RESULTS);
	return Math.min(limit ?? configured, configured, MAX_RESULTS_HARD_LIMIT);
}

function clampMaxChars(maxChars: number | undefined, config: WebConfig): number {
	const configured = integerOrDefault(config.maxContentChars, DEFAULT_MAX_CONTENT_CHARS);
	return Math.min(maxChars ?? configured, configured, MAX_CONTENT_CHARS_HARD_LIMIT);
}

function integerOrDefault(value: unknown, fallback: number): number {
	return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function assertHttpUrl(input: string): string {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only http and https URLs are supported: ${input}`);
	}
	return parsed.toString();
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<unknown> {
	const response = await fetchWithTimeout(url, init, signal);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}: ${truncateForError(text)}`);
	}
	if (!text.trim()) return {};
	return JSON.parse(text) as unknown;
}

async function fetchText(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<{ text: string; contentType: string | undefined; finalUrl: string }> {
	const response = await fetchWithTimeout(url, init, signal);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}: ${truncateForError(text)}`);
	}
	return {
		text,
		contentType: response.headers.get("content-type") ?? undefined,
		finalUrl: response.url || url,
	};
}

async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

async function firecrawlSearch(params: SearchParams, config: WebConfig, limit: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const provider = providerConfig(config, "firecrawl");
	if (!provider.apiKey) throw new Error("FIRECRAWL_API_KEY or firecrawl.apiKey is required.");
	const baseUrl = trimTrailingSlash(provider.baseUrl ?? "https://api.firecrawl.dev");
	const body: JsonRecord = {
		query: params.query,
		limit,
	};
	if (params.includeContent) {
		body.scrapeOptions = {
			formats: ["markdown"],
		};
	}
	if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
	if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
	if (params.recencyDays) body.tbs = `qdr:d${params.recencyDays}`;

	const data = await fetchJson(`${baseUrl}/v2/search`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${provider.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	}, signal);
	const items = firecrawlSearchItems(data);
	return items.slice(0, limit).map((item) => {
		const record = requireRecord(item, "Firecrawl search result");
		return {
			title: stringField(record, "title") ?? stringField(record, "url") ?? "Untitled",
			url: requireStringField(record, "url", "Firecrawl search result"),
			snippet: stringField(record, "description"),
			publishedDate: stringField(record, "publishedDate"),
			provider: "firecrawl",
			content: truncateOptional(stringField(record, "markdown"), SEARCH_RESULT_CONTENT_CHARS),
		};
	});
}

function firecrawlSearchItems(data: unknown): unknown[] {
	const webItems = arrayFromPath(data, ["data", "web"]);
	if (webItems.length > 0) return webItems;
	return arrayFromPath(data, ["data"]);
}

async function firecrawlFetch(params: FetchContentParams, config: WebConfig, maxChars: number, signal: AbortSignal | undefined): Promise<FetchContentResult> {
	const provider = providerConfig(config, "firecrawl");
	if (!provider.apiKey) throw new Error("FIRECRAWL_API_KEY or firecrawl.apiKey is required.");
	const url = assertHttpUrl(params.url);
	const baseUrl = trimTrailingSlash(provider.baseUrl ?? "https://api.firecrawl.dev");
	const format = params.format ?? "markdown";
	const formats = format === "html" ? ["html"] : ["markdown"];
	const data = await fetchJson(`${baseUrl}/v2/scrape`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${provider.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ url, formats }),
	}, signal);
	const payload = objectFromPath(data, ["data"]);
	const metadata = recordField(payload, "metadata") ?? {};
	const raw = format === "html"
		? stringField(payload, "html") ?? ""
		: stringField(payload, "markdown") ?? stringField(payload, "html") ?? "";
	const normalized = normalizeContent(raw, format);
	const clipped = truncateContent(normalized, maxChars);
	return {
		url: stringField(metadata, "sourceURL") ?? stringField(payload, "url") ?? url,
		title: stringField(metadata, "title") ?? stringField(payload, "title"),
		contentType: format === "html" ? "text/html" : "text/markdown",
		content: clipped.content,
		provider: "firecrawl",
		truncated: clipped.truncated,
		chars: clipped.originalLength,
	};
}

async function exaSearch(params: SearchParams, config: WebConfig, limit: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const provider = providerConfig(config, "exa");
	if (!provider.apiKey) throw new Error("EXA_API_KEY or exa.apiKey is required.");
	const baseUrl = trimTrailingSlash(provider.baseUrl ?? "https://api.exa.ai");
	const body: JsonRecord = {
		query: params.query,
		numResults: limit,
	};
	if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
	if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
	if (params.recencyDays) body.startPublishedDate = daysAgoIsoDate(params.recencyDays);
	if (params.includeContent) {
		body.contents = {
			text: { maxCharacters: 2000 },
			highlights: { query: params.query, numSentences: 3 },
		};
	}

	const data = await fetchJson(`${baseUrl}/search`, {
		method: "POST",
		headers: {
			"x-api-key": provider.apiKey,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	}, signal);
	const items = arrayFromPath(data, ["results"]);
	return items.slice(0, limit).map((item) => {
		const record = requireRecord(item, "Exa search result");
		return {
			title: stringField(record, "title") ?? stringField(record, "url") ?? "Untitled",
			url: requireStringField(record, "url", "Exa search result"),
			snippet: firstStringFromArray(arrayField(record, "highlights")) ?? stringField(record, "summary"),
			publishedDate: stringField(record, "publishedDate"),
			provider: "exa",
			content: truncateOptional(stringField(record, "text"), SEARCH_RESULT_CONTENT_CHARS),
		};
	});
}

async function exaFetch(params: FetchContentParams, config: WebConfig, maxChars: number, signal: AbortSignal | undefined): Promise<FetchContentResult> {
	const provider = providerConfig(config, "exa");
	if (!provider.apiKey) throw new Error("EXA_API_KEY or exa.apiKey is required.");
	const url = assertHttpUrl(params.url);
	const baseUrl = trimTrailingSlash(provider.baseUrl ?? "https://api.exa.ai");
	const body: JsonRecord = {
		ids: [url],
		text: { maxCharacters: maxChars },
	};
	if (params.query) {
		body.highlights = { query: params.query, numSentences: 5 };
	}
	const data = await fetchJson(`${baseUrl}/contents`, {
		method: "POST",
		headers: {
			"x-api-key": provider.apiKey,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	}, signal);
	const statusError = firstStatusError(data);
	if (statusError) throw new Error(statusError);
	const result = requireRecord(arrayFromPath(data, ["results"])[0], "Exa content result");
	const content = params.query
		? firstStringFromArray(arrayField(result, "highlights")) ?? stringField(result, "text") ?? ""
		: stringField(result, "text") ?? "";
	const normalized = normalizeContent(content, params.format ?? "text");
	const clipped = truncateContent(normalized, maxChars);
	return {
		url: stringField(result, "url") ?? url,
		title: stringField(result, "title"),
		contentType: "text/plain",
		content: clipped.content,
		provider: "exa",
		truncated: clipped.truncated,
		chars: clipped.originalLength,
	};
}

async function tavilySearch(params: SearchParams, config: WebConfig, limit: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const provider = providerConfig(config, "tavily");
	if (!provider.apiKey) throw new Error("TAVILY_API_KEY or tavily.apiKey is required.");
	const baseUrl = trimTrailingSlash(provider.baseUrl ?? "https://api.tavily.com");
	const isNews = typeof params.recencyDays === "number" && params.recencyDays > 0;
	const body: JsonRecord = {
		query: params.query,
		max_results: limit,
		search_depth: params.includeContent ? "advanced" : "basic",
		topic: isNews ? "news" : "general",
		include_answer: false,
		include_raw_content: !!params.includeContent,
	};
	if (params.includeDomains?.length) body.include_domains = params.includeDomains;
	if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains;
	if (isNews) body.days = params.recencyDays;

	const data = await fetchJson(`${baseUrl}/search`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${provider.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	}, signal);
	const items = arrayFromPath(data, ["results"]);
	return items.slice(0, limit).map((item) => {
		const record = requireRecord(item, "Tavily search result");
		return {
			title: stringField(record, "title") ?? stringField(record, "url") ?? "Untitled",
			url: requireStringField(record, "url", "Tavily search result"),
			snippet: stringField(record, "content"),
			publishedDate: stringField(record, "published_date"),
			provider: "tavily",
			content: truncateOptional(stringField(record, "raw_content"), SEARCH_RESULT_CONTENT_CHARS),
		};
	});
}

async function tavilyFetch(params: FetchContentParams, config: WebConfig, maxChars: number, signal: AbortSignal | undefined): Promise<FetchContentResult> {
	const provider = providerConfig(config, "tavily");
	if (!provider.apiKey) throw new Error("TAVILY_API_KEY or tavily.apiKey is required.");
	const url = assertHttpUrl(params.url);
	const baseUrl = trimTrailingSlash(provider.baseUrl ?? "https://api.tavily.com");
	const format: ContentFormat = params.format ?? "markdown";
	const body: JsonRecord = {
		urls: [url],
		extract_depth: "advanced",
		format: format === "json" ? "json" : "markdown",
	};

	const data = await fetchJson(`${baseUrl}/extract`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${provider.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	}, signal);
	const failures = arrayFromPath(data, ["failed_results"]);
	const results = arrayFromPath(data, ["results"]);
	if (results.length === 0) {
		if (failures.length > 0) {
			const failed = requireRecord(failures[0], "Tavily extract failure");
			throw new Error(stringField(failed, "error") ?? "Tavily extract failed for the requested URL.");
		}
		throw new Error("Tavily extract returned no results.");
	}
	const result = requireRecord(results[0], "Tavily extract result");
	const raw = stringField(result, "raw_content") ?? "";
	const normalized = format === "html" ? raw : normalizeContent(raw, format);
	const clipped = truncateContent(normalized, maxChars);
	return {
		url: stringField(result, "url") ?? url,
		title: stringField(result, "title"),
		contentType: format === "html" ? "text/html" : (format === "json" ? "application/json" : "text/markdown"),
		content: clipped.content,
		provider: "tavily",
		truncated: clipped.truncated,
		chars: clipped.originalLength,
	};
}

async function nativeSearch(params: SearchParams, config: WebConfig, limit: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const endpoint = config.native?.searchUrl ?? "https://html.duckduckgo.com/html/";
	const url = `${endpoint}?${new URLSearchParams({ q: params.query }).toString()}`;
	const response = await fetchText(url, {
		headers: {
			"accept": "text/html,application/xhtml+xml",
			"user-agent": "Mozilla/5.0 PiWebExtension/1.0",
		},
	}, signal);
	const results = parseDuckDuckGoResults(response.text).slice(0, limit);
	return results.map((result) => ({
		...result,
		provider: "native",
	}));
}

async function nativeFetch(params: FetchContentParams, _config: WebConfig, maxChars: number, signal: AbortSignal | undefined): Promise<FetchContentResult> {
	const url = assertHttpUrl(params.url);
	const response = await fetchText(url, {
		headers: {
			"accept": "text/html,application/json,text/plain,*/*",
			"user-agent": "Mozilla/5.0 PiWebExtension/1.0",
		},
	}, signal);
	const format = params.format ?? inferFormat(response.contentType);
	const title = format === "html" || response.contentType?.includes("html") ? extractTitle(response.text) : undefined;
	const content = contentFromRaw(response.text, response.contentType, format);
	const clipped = truncateContent(content, maxChars);
	return {
		url: response.finalUrl,
		title,
		contentType: response.contentType,
		content: clipped.content,
		provider: "native",
		truncated: clipped.truncated,
		chars: clipped.originalLength,
	};
}

function contentFromRaw(raw: string, contentType: string | undefined, format: ContentFormat): string {
	if (format === "html") return raw;
	if (format === "json") {
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}
	if (contentType?.includes("html")) return htmlToText(raw);
	return normalizeContent(raw, format);
}

function normalizeContent(content: string, format: ContentFormat): string {
	if (format === "html" || format === "json") return content.trim();
	return collapseWhitespace(content);
}

function parseDuckDuckGoResults(html: string): Array<Omit<SearchResult, "provider">> {
	const results: Array<Omit<SearchResult, "provider">> = [];
	const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
	let match: RegExpExecArray | null;
	while ((match = resultPattern.exec(html)) !== null) {
		const href = decodeHtml(match[1]);
		const url = normalizeDuckDuckGoUrl(href);
		if (!url) continue;
		results.push({
			title: htmlToText(match[2]),
			url,
			snippet: htmlToText(match[3] ?? match[4] ?? ""),
		});
	}
	return results;
}

function normalizeDuckDuckGoUrl(href: string): string | undefined {
	try {
		const parsed = new URL(href, "https://duckduckgo.com");
		const redirected = parsed.searchParams.get("uddg");
		const url = redirected ?? parsed.toString();
		const target = new URL(url);
		if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
		return target.toString();
	} catch {
		return undefined;
	}
}

function htmlToText(html: string): string {
	const withoutBlocks = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	const withBreaks = withoutBlocks
		.replace(/<\/(p|div|section|article|header|footer|main|aside|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n");
	return collapseWhitespace(decodeHtml(withBreaks.replace(/<[^>]+>/g, " ")));
}

function extractTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = htmlToText(match[1]);
	return title || undefined;
}

function decodeHtml(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: "\"",
		apos: "'",
		nbsp: " ",
	};
	return value
		.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function collapseWhitespace(value: string): string {
	return value.replace(/\r/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean; originalLength: number } {
	if (content.length <= maxChars) {
		return { content, truncated: false, originalLength: content.length };
	}
	return {
		content: `${content.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]`,
		truncated: true,
		originalLength: content.length,
	};
}

function truncateOptional(content: string | undefined, maxChars: number): string | undefined {
	if (!content) return undefined;
	return truncateContent(content, maxChars).content;
}

function formatSearchResult(details: SearchDetails): string {
	if (details.results.length === 0) {
		const attempts = details.attempts?.length ? ` Attempts: ${details.attempts.join(" | ")}.` : "";
		return `No web search results for "${details.query}" via ${details.provider}.${attempts}`;
	}
	return [
		`Web search results for "${details.query}" via ${details.provider}:`,
		...details.results.map((result, index) => {
			const lines = [
				`${index + 1}. ${result.title}`,
				`   URL: ${result.url}`,
			];
			if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
			if (result.publishedDate) lines.push(`   Published: ${result.publishedDate}`);
			if (result.content) lines.push(`   Content: ${result.content}`);
			return lines.join("\n");
		}),
	].join("\n");
}

function formatFetchResult(result: FetchContentResult): string {
	const header = [
		`Fetched ${result.url} via ${result.provider}`,
		result.title ? `Title: ${result.title}` : undefined,
		result.contentType ? `Content-Type: ${result.contentType}` : undefined,
		`Characters: ${result.chars}${result.truncated ? " (truncated)" : ""}`,
	].filter((line): line is string => typeof line === "string");
	return `${header.join("\n")}\n\n${result.content}`;
}

function inferFormat(contentType: string | undefined): ContentFormat {
	if (contentType?.includes("json")) return "json";
	if (contentType?.includes("html")) return "text";
	return "text";
}

function firstStatusError(data: unknown): string | undefined {
	const statuses = arrayFromPath(data, ["statuses"]);
	for (const item of statuses) {
		const record = isRecord(item) ? item : undefined;
		if (!record) continue;
		const status = stringField(record, "status");
		if (status && status !== "success") {
			return stringField(record, "error") ?? `Exa content status: ${status}`;
		}
	}
	return undefined;
}

function arrayFromPath(data: unknown, path: string[]): unknown[] {
	let current = data;
	for (const key of path) {
		if (!isRecord(current)) return [];
		current = current[key];
	}
	return Array.isArray(current) ? current : [];
}

function objectFromPath(data: unknown, path: string[]): JsonRecord {
	let current = data;
	for (const key of path) {
		if (!isRecord(current)) return {};
		current = current[key];
	}
	return isRecord(current) ? current : {};
}

function recordField(record: JsonRecord, key: string): JsonRecord | undefined {
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function arrayField(record: JsonRecord, key: string): unknown[] {
	const value = record[key];
	return Array.isArray(value) ? value : [];
}

function stringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireStringField(record: JsonRecord, key: string, label: string): string {
	const value = stringField(record, key);
	if (!value) throw new Error(`${label} missing required string field: ${key}`);
	return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
	if (isRecord(value)) return value;
	throw new Error(`${label} must be an object.`);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstStringFromArray(values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function daysAgoIsoDate(days: number): string {
	const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	return date.toISOString();
}

function truncateForError(text: string): string {
	const cleaned = collapseWhitespace(text);
	return cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned;
}

async function trySearchProvider(provider: ActualProvider, params: SearchParams, config: WebConfig, limit: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	switch (provider) {
		case "firecrawl":
			return firecrawlSearch(params, config, limit, signal);
		case "exa":
			return exaSearch(params, config, limit, signal);
		case "tavily":
			return tavilySearch(params, config, limit, signal);
		case "native":
			return nativeSearch(params, config, limit, signal);
	}
}

async function tryFetchProvider(provider: ActualProvider, params: FetchContentParams, config: WebConfig, maxChars: number, signal: AbortSignal | undefined): Promise<FetchContentResult> {
	switch (provider) {
		case "firecrawl":
			return firecrawlFetch(params, config, maxChars, signal);
		case "exa":
			return exaFetch(params, config, maxChars, signal);
		case "tavily":
			return tavilyFetch(params, config, maxChars, signal);
		case "native":
			return nativeFetch(params, config, maxChars, signal);
	}
}

export default function webExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web with configured providers. Supports Firecrawl, Exa, Tavily, and native search.",
		promptSnippet: "Search the web for current information using the configured Firecrawl, Exa, Tavily, or native provider list.",
		promptGuidelines: [
			"Use web_search when current external information is needed.",
			"Prefer provider auto unless the user asks for a specific provider.",
			"Keep limit small and fetch individual pages with fetch_content when details are needed.",
		],
		parameters: WEB_SEARCH_PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, params: SearchParams, signal) {
			const config = readConfig();
			const limit = clampLimit(params.limit, config);
			const providers = resolveSearchProviders(params.provider, config);
			const attempts: string[] = [];
			let lastEmptyDetails: SearchDetails | undefined;
			const explicitProvider = params.provider !== undefined && params.provider !== "auto";
			const fallbackOnError = !explicitProvider && config.fallbackOnProviderError === true;
			const fallbackOnEmpty = !explicitProvider && config.fallbackOnEmptySearchResults === true;
			for (const [index, provider] of providers.entries()) {
				const hasNextProvider = index < providers.length - 1;
				try {
					const results = await trySearchProvider(provider, params, config, limit, signal);
					const details: SearchDetails = { query: params.query, provider, results, attempts };
					if (results.length === 0 && fallbackOnEmpty && hasNextProvider) {
						attempts.push(`${provider}: 0 results`);
						lastEmptyDetails = details;
						continue;
					}
					return {
						content: [{ type: "text", text: formatSearchResult(details) }],
						details,
					};
				} catch (error) {
					attempts.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
					if (!fallbackOnError || !hasNextProvider) break;
				}
			}
			if (lastEmptyDetails) {
				return {
					content: [{ type: "text", text: formatSearchResult(lastEmptyDetails) }],
					details: lastEmptyDetails,
				};
			}
			throw new Error(`web_search failed. Attempts: ${attempts.join(" | ")}`);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch and extract content from a URL with configured providers. Supports Firecrawl, Exa, Tavily, and native fetch.",
		promptSnippet: "Fetch page content from a URL using Firecrawl, Exa, Tavily, or native fetch.",
		promptGuidelines: [
			"Use fetch_content after web_search when source details are needed.",
			"Only fetch http or https URLs.",
			"Use maxChars to keep retrieved content bounded.",
		],
		parameters: FETCH_CONTENT_PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, params: FetchContentParams, signal) {
			const config = readConfig();
			const maxChars = clampMaxChars(params.maxChars, config);
			const providers = resolveFetchProviders(params.provider, config);
			const attempts: string[] = [];
			const explicitProvider = params.provider !== undefined && params.provider !== "auto";
			const fallbackOnError = !explicitProvider && config.fallbackOnProviderError === true;
			for (const [index, provider] of providers.entries()) {
				const hasNextProvider = index < providers.length - 1;
				try {
					const result = await tryFetchProvider(provider, params, config, maxChars, signal);
					return {
						content: [{ type: "text", text: formatFetchResult(result) }],
						details: result,
					};
				} catch (error) {
					attempts.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
					if (!fallbackOnError || !hasNextProvider) break;
				}
			}
			throw new Error(`fetch_content failed. Attempts: ${attempts.join(" | ")}`);
		},
	});
}
