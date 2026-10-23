# imgcli

Generate images from the command line using OpenAI or Gemini. Includes interactive login, persistent API key storage, and a non-interactive CI mode.

## Requirements

- Node.js 18+
- An OpenAI or Gemini API key

## Install

From npm (global):

```bash
npm install -g imgcli
```

Run once with npx:

```bash
npx imgcli
```

Local install for development:

```bash
npm install
npm link
```

## Quickstart

Login (store API key):

```bash
imgcli login
```

Generate an image:

```bash
imgcli generate --provider openai --prompt "a retro robot in watercolor" --out out
```

## Usage

Interactive (default):

```bash
imgcli
```

Logout (remove API key):

```bash
imgcli logout --provider openai
```

Generate (interactive prompts for missing values):

```bash
imgcli generate --provider openai --prompt "a retro robot in watercolor" --out out
```

Generate (non-interactive / CI):

```bash
imgcli generate --non-interactive --provider gemini --prompt "foggy mountain temple at dawn" --aspect 16:9 --out out
```

Help:

```bash
imgcli --help
```

## Generate options

```
imgcli generate [options]

  -p, --provider <provider>   openai or gemini
  --prompt <prompt>           prompt for the image
  -o, --out <path>            output directory or .png/.jpg/.jpeg/.webp file
  -n, --count <number>        integer from 1 to 10 (default: 1)
  --size <size>               size like 1024x1024 (OpenAI) or aspect ratio inference (Gemini)
  --aspect <ratio>            aspect ratio like 1:1, 4:3, 16:9 (Gemini)
  --model <model>             explicit model override
  --background <mode>         OpenAI: auto, opaque, transparent
  --format <format>           OpenAI: png, jpeg, webp
  --quality <quality>         OpenAI: auto, low, medium, high, xhigh, max
  --base-url <url>            Gemini gateway URL
  --non-interactive           fail if required inputs are missing (CI mode)
```

## CI / non-interactive

- Requires `--prompt`; `--provider` can be omitted if exactly one provider has a stored key.
- API key must already be stored via `imgcli login`.

## Models

The choices below were checked against the official API documentation on 23 October 2026.
An explicit `--model` wins over a saved `providers.<provider>.model` preference;
otherwise the provider default applies. Existing keys, saved model preferences
and gateway URLs are not rewritten by generation. Custom model IDs and gateway
aliases remain available through `--model`.

OpenAI:

- `gpt-image-2.5-sunburst` (default)
- `gpt-image-2.5-flare`
- `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare-2026-09-08` (snapshots)
- `gpt-image-2`, `gpt-image-2-2026-04-21` (snapshot)
- `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest` (legacy; retire 1 December 2026)

DALL-E models and `gpt-image-1` (retired 23 October 2026) no longer appear in the
menu. Explicit or saved model IDs are preserved, so an unavailable model will
return the provider error rather than silently switching models. Model access
depends on the provider account. See the [OpenAI image API reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
and [image prompting lifecycle notes](https://developers.openai.com/api/docs/guides/image-prompting).

Gemini:

- `gemini-nano-banana-2.1` (default)
- `gemini-3.1-flash-image`
- `gemini-3.1-flash-lite-image`
- `gemini-3-pro-image`
- `gemini-2.5-flash-image`

The current stable image models replace the old preview/Imagen menu entries.
The CLI keeps the existing `generateContent` endpoint, which supports these
models; direct calls and gateways receive the selected aspect ratio.
See Google's [model guide](https://ai.google.dev/gemini-api/docs/image-generation)
and [generateContent image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation).

## Transparent backgrounds and output formats

```bash
imgcli generate --non-interactive --provider openai \
  --model gpt-image-2.5-sunburst --background transparent --format png \
  --size 1536x1024 --quality high \
  --prompt "A small clay tree, isolated with real transparent alpha pixels" \
  --out tree.png
```

`--background transparent` sends an explicit API parameter; mentioning
transparency only in the prompt is insufficient. PNG and WebP support alpha.
JPEG with transparency is rejected before generation. The format defaults to
the filename extension, or PNG for a directory. An explicit format must match
the filename extension; `.jpg` and `.jpeg` both select JPEG. Multiple images
use numbered filenames. Directory outputs use the requested format extension.

OpenAI defaults to `1024x1024`. Standard sizes include `1536x1024` and
`1024x1536`; newer models also accept other supported sizes. The API validates
model-specific dimensions. `xhigh` and `max` quality are supported by Sunburst
and Flare, including their snapshots. Gemini uses its native PNG response;
explicit background, quality and non-PNG output requests require OpenAI.

## Proxy / gateway support

Gemini calls can be routed through a gateway such as Ledger instead of Google
directly. Store the gateway token and base URL at login:

```bash
imgcli login --provider gemini --base-url https://ledger.unlikeotherai.com
```

Or override per call:

```bash
imgcli generate --provider gemini --base-url https://ledger.unlikeotherai.com \
  --prompt "a retro robot in watercolor" --out out
```

In proxy mode the request goes to `<base-url>/v1/gemini/generateContent`, the
model travels in the request body and the token is sent as a bearer token.

## Configuration

API keys are stored in `~/.imgcli/config.json` (plaintext), alongside the
optional `baseUrl` and `model` for each provider. Generation does not modify
this file. Keep it private; do not commit it.

## Notes

- OpenAI sizes use the format `1024x1024`.
- Gemini uses `aspectRatio` such as `1:1`, `4:3`, `16:9`.

## Development

```bash
npm install
npm test
npm run check
node bin/imgcli.js
```

Tests mock provider HTTP responses and exercise CLI argument handling with
temporary fixture configuration. They make no paid API requests and do not
read your real credentials.
