# imgcli

Generate images from the command line using OpenAI or Gemini. Includes interactive login, persistent API key storage, and a non-interactive CI mode.

## Requirements

- Node.js 18+

## Install

Local install for development:

```bash
npm install
npm link
```

Global install from the folder:

```bash
npm install -g .
```

## Usage

Interactive (default):

```bash
imgcli
```

Login (store API key):

```bash
imgcli login
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

## Configuration

API keys are stored in:

```
~/.imgcli/config.json
```

## Notes

- OpenAI sizes use the format `1024x1024`.
- Gemini uses `aspectRatio` such as `1:1`, `4:3`, `16:9`.

## Development

```bash
npm install
node bin/imgcli.js
```
