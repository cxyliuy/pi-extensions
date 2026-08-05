# Web Extension

Adds web search and URL content fetching tools for Pi agents.

## Tools

- `web_search` - searches the web with Firecrawl, Exa, or native search.
- `fetch_content` - fetches content from an `http` or `https` URL with Firecrawl, Exa, or native `fetch`.

Both tools bound their output so large pages do not flood the model context.

## Configuration

API keys can be provided through environment variables:

```bash
export FIRECRAWL_API_KEY=...
export EXA_API_KEY=...
```

Or through `~/.pi/agent/web.json`:

```json
{
	"searchProviders": ["firecrawl"],
	"fetchProviders": ["firecrawl"],
	"fallbackOnProviderError": false,
	"fallbackOnEmptySearchResults": false,
	"maxResults": 5,
	"maxContentChars": 20000,
	"firecrawl": {
		"apiKey": "...",
		"baseUrl": "https://api.firecrawl.dev"
	},
	"exa": {
		"apiKey": "...",
		"baseUrl": "https://api.exa.ai"
	}
}
```

Environment variables override keys from `web.json`.

## Providers

When a tool call uses `provider: "auto"` or omits `provider`, the extension uses:

- `searchProviders` for `web_search`.
- `fetchProviders` for `fetch_content`.

By default both lists are `["firecrawl"]`. To enable provider fallback explicitly:

```json
{
	"searchProviders": ["firecrawl", "exa"],
	"fetchProviders": ["firecrawl", "exa", "native"],
	"fallbackOnProviderError": true,
	"fallbackOnEmptySearchResults": false
}
```

Explicit tool calls with `provider: "firecrawl"`, `provider: "exa"`, or `provider: "native"` always use only that provider.

Native search uses DuckDuckGo HTML and may fail or change without notice. Native fetch does not run JavaScript, log in, manage cookies, bypass paywalls, or bypass anti-bot systems.

## Reloading

After editing this extension, reload Pi with:

```text
/reload
```
