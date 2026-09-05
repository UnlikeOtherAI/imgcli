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
  -o, --out <path>            output directory or .png file
  -n, --count <number>        number of images (default: 1)
  --size <size>               size like 1024x1024 (OpenAI) or aspect ratio inference (Gemini)
  --aspect <ratio>            aspect ratio like 1:1, 4:3, 16:9 (Gemini)
  --model <model>             model override (default is latest for provider)
  --non-interactive           fail if required inputs are missing (CI mode)
```

## CI / non-interactive

- Requires `--provider` and `--prompt`.
- API key must already be stored via `imgcli login`.

## Models

The CLI prompts you to select a model when running interactively. Defaults to the latest model for the chosen provider.
Use `--model` to override.

OpenAI:

- gpt-image-1 (latest)
- dall-e-3

Gemini:

- gemini-3-pro-image-preview (latest)
- gemini-2.5-flash-image
- imagen-3.0-generate-001 (legacy)

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
optional `baseUrl` for each provider.

## Notes

- OpenAI sizes use the format `1024x1024`.
- Gemini uses `aspectRatio` such as `1:1`, `4:3`, `16:9`.

## Development

```bash
npm install
node bin/imgcli.js
```
