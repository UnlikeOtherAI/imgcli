#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { createRequire } from "module";

const CONFIG_DIR = path.join(os.homedir(), ".imgcli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const OPENAI_MODELS = [
  { id: "gpt-image-1", label: "gpt-image-1 (latest)" },
  { id: "dall-e-3", label: "dall-e-3" }
];
const GEMINI_MODELS = [
  { id: "gemini-3-pro-image-preview", label: "gemini-3-pro-image-preview (latest)" },
  { id: "gemini-2.5-flash-image", label: "gemini-2.5-flash-image" },
  { id: "imagen-3.0-generate-001", label: "imagen-3.0-generate-001 (legacy)" }
];

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { providers: {} };
  }
}

async function saveConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function ensureProvider(config, provider) {
  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function randomSlug() {
  return crypto.randomBytes(4).toString("hex");
}

function inferAspectRatio(size) {
  if (!size) return undefined;
  const match = /^([0-9]+)x([0-9]+)$/i.exec(size);
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return undefined;
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function latestModel(provider) {
  if (provider === "openai") return OPENAI_MODELS[0].id;
  if (provider === "gemini") return GEMINI_MODELS[0].id;
  return undefined;
}

function modelChoices(provider) {
  if (provider === "openai") return OPENAI_MODELS.map((m) => ({ name: m.label, value: m.id }));
  if (provider === "gemini") return GEMINI_MODELS.map((m) => ({ name: m.label, value: m.id }));
  return [];
}

function startLoadingBox(label = "Generating") {
  if (!process.stdout.isTTY) {
    return () => {};
  }
  const frames = ["|", "/", "-", "\\"];
  let idx = 0;
  const interval = setInterval(() => {
    const frame = frames[idx % frames.length];
    idx += 1;
    const top = "+---------+";
    const mid = `|   ${frame}   |`;
    const bot = "+---------+";
    const text = `${label}...`;
    process.stdout.write(`\r${top}\n${mid}\n${bot}  ${text}\x1b[3A`);
  }, 120);
  return () => {
    clearInterval(interval);
    process.stdout.write("\r\x1b[3B\x1b[2K");
  };
}

async function writeOutputs(buffers, outPath, provider) {
  const outIsFile = outPath && outPath.endsWith(".png");
  const dir = outIsFile ? path.dirname(outPath) : (outPath || "out");
  await fs.mkdir(dir, { recursive: true });

  const outputs = [];
  for (let i = 0; i < buffers.length; i += 1) {
    let filePath;
    if (outIsFile) {
      const base = path.basename(outPath, ".png");
      const name = buffers.length === 1 ? `${base}.png` : `${base}-${i + 1}.png`;
      filePath = path.join(dir, name);
    } else {
      filePath = path.join(
        dir,
        `${provider}-${nowStamp()}-${i + 1}-${randomSlug()}.png`
      );
    }
    await fs.writeFile(filePath, buffers[i]);
    outputs.push(filePath);
  }
  return outputs;
}

async function promptIfMissing(options) {
  const questions = [];
  if (!options.provider) {
    questions.push({
      type: "list",
      name: "provider",
      message: "Choose a provider",
      choices: [
        { name: "OpenAI", value: "openai" },
        { name: "Gemini", value: "gemini" }
      ]
    });
  }
  if (!options.prompt) {
    questions.push({
      type: "input",
      name: "prompt",
      message: "Image prompt"
    });
  }
  return questions.length ? inquirer.prompt(questions) : {};
}

async function openaiGenerate({ apiKey, prompt, size, n, model }) {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      n
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const images = data.data || [];
  if (!images.length) {
    throw new Error("OpenAI API returned no images");
  }

  const buffers = [];
  for (const img of images) {
    if (img.b64_json) {
      buffers.push(Buffer.from(img.b64_json, "base64"));
      continue;
    }
    if (img.url) {
      const imageRes = await fetch(img.url);
      if (!imageRes.ok) {
        const text = await imageRes.text();
        throw new Error(`Failed to fetch OpenAI image (${imageRes.status}): ${text}`);
      }
      const arrayBuffer = await imageRes.arrayBuffer();
      buffers.push(Buffer.from(arrayBuffer));
      continue;
    }
    throw new Error("OpenAI API returned an unsupported image format");
  }

  return buffers;
}

async function geminiGenerate({ apiKey, prompt, aspectRatio, n, model }) {
  if (model.startsWith("imagen-")) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: n,
          ...(aspectRatio ? { aspectRatio } : {})
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const predictions = data.predictions || [];
    if (!predictions.length) {
      throw new Error("Gemini API returned no images");
    }

    return predictions.map((img) => Buffer.from(img.bytesBase64Encoded, "base64"));
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const buffers = [];
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const images = parts.filter((part) => part.inlineData?.data).map((part) => part.inlineData.data);
    if (!images.length) {
      throw new Error("Gemini API returned no images");
    }
    images.forEach((img) => buffers.push(Buffer.from(img, "base64")));
  }

  return buffers;
}

const program = new Command();

program
  .name("imgcli")
  .description(pkg.description || "Generate images with OpenAI or Gemini")
  .version(pkg.version);

program
  .command("login")
  .description("Store API key for a provider")
  .option("-p, --provider <provider>", "openai or gemini")
  .action(async (options) => {
    const config = await loadConfig();
    const answers = await inquirer.prompt([
      {
        type: "list",
        name: "provider",
        message: "Select provider",
        choices: [
          { name: "OpenAI", value: "openai" },
          { name: "Gemini", value: "gemini" }
        ],
        when: !options.provider
      },
      {
        type: "password",
        name: "apiKey",
        message: "API key",
        mask: "*",
        validate: (value) => (value ? true : "API key is required")
      }
    ]);

    const provider = options.provider || answers.provider;
    const apiKey = answers.apiKey.trim();

    ensureProvider(config, provider);
    config.providers[provider].apiKey = apiKey;
    await saveConfig(config);
    console.log(`Saved API key for ${provider}`);
  });

program
  .command("logout")
  .description("Remove stored API key")
  .option("-p, --provider <provider>", "openai or gemini")
  .action(async (options) => {
    const config = await loadConfig();
    const answers = await inquirer.prompt([
      {
        type: "list",
        name: "provider",
        message: "Select provider",
        choices: [
          { name: "OpenAI", value: "openai" },
          { name: "Gemini", value: "gemini" }
        ],
        when: !options.provider
      }
    ]);

    const provider = options.provider || answers.provider;
    if (config.providers[provider]) {
      delete config.providers[provider].apiKey;
      await saveConfig(config);
      console.log(`Removed API key for ${provider}`);
      return;
    }

    console.log(`No API key stored for ${provider}`);
  });

program
  .command("generate")
  .description("Generate images")
  .option("-p, --provider <provider>", "openai or gemini")
  .option("--prompt <prompt>", "prompt for the image")
  .option("-o, --out <path>", "output directory or .png file")
  .option("-n, --count <number>", "number of images", (v) => Number(v), 1)
  .option("--size <size>", "size like 1024x1024 (OpenAI) or aspect ratio inference (Gemini)")
  .option("--aspect <ratio>", "aspect ratio like 1:1, 4:3, 16:9 (Gemini)")
  .option("--model <model>", "model override (default is latest for provider)")
  .option("--non-interactive", "fail if required inputs are missing (CI mode)")
  .action(async (options) => {
    const config = await loadConfig();
    const storedProviders = Object.entries(config.providers || {})
      .filter(([, data]) => data && data.apiKey)
      .map(([name]) => name);
    const nonInteractive = Boolean(options.nonInteractive);
    const answers = nonInteractive ? {} : await promptIfMissing(options);

    const provider =
      (options.provider || answers.provider || (storedProviders.length === 1 ? storedProviders[0] : "openai"))
        .toLowerCase();
    let model = options.model;
    const prompt = options.prompt || answers.prompt;
    const n = Number.isFinite(options.count) && options.count > 0 ? options.count : 1;

    if (nonInteractive) {
      if (!options.provider && storedProviders.length !== 1) {
        console.error("Provider is required in non-interactive mode.");
        process.exit(1);
      }
      if (!prompt) {
        console.error("Prompt is required in non-interactive mode.");
        process.exit(1);
      }
    }

    if (!prompt) {
      console.error("Prompt is required");
      process.exit(1);
    }

    const apiKey = config.providers[provider]?.apiKey;
    if (!apiKey) {
      console.error(`No API key found for ${provider}. Run 'imgcli login'.`);
      process.exit(1);
    }

    if (!model && !nonInteractive) {
      const modelAnswer = await inquirer.prompt([
        {
          type: "list",
          name: "model",
          message: "Select a model",
          choices: modelChoices(provider),
          default: latestModel(provider)
        }
      ]);
      model = modelAnswer.model;
    }

    model = model || latestModel(provider);

    let stopLoading;
    try {
      stopLoading = startLoadingBox();
      let buffers;
      if (provider === "openai") {
        const size = options.size || "1024x1024";
        buffers = await openaiGenerate({ apiKey, prompt, size, n, model });
      } else if (provider === "gemini") {
        const aspectRatio = options.aspect || inferAspectRatio(options.size) || "1:1";
        buffers = await geminiGenerate({ apiKey, prompt, aspectRatio, n, model });
      } else {
        console.error("Unsupported provider. Use openai or gemini.");
        process.exit(1);
      }

      stopLoading();
      const outputs = await writeOutputs(buffers, options.out, provider);
      outputs.forEach((file) => console.log(`Saved ${file}`));
    } catch (err) {
      stopLoading?.();
      console.error(err.message || err);
      process.exit(1);
    }
  });

program
  .command("run", { isDefault: true })
  .description("Interactive image generation (default)")
  .action(async () => {
    const config = await loadConfig();
    const storedProviders = Object.entries(config.providers || {})
      .filter(([, data]) => data && data.apiKey)
      .map(([name]) => name);
    let preselectedProvider = storedProviders.length === 1 ? storedProviders[0] : undefined;
    if (storedProviders.length === 0) {
      const loginAnswers = await inquirer.prompt([
        {
          type: "list",
          name: "provider",
          message: "No API key found. Select provider to login",
          choices: [
            { name: "OpenAI", value: "openai" },
            { name: "Gemini", value: "gemini" }
          ]
        },
        {
          type: "password",
          name: "apiKey",
          message: "API key",
          mask: "*",
          validate: (value) => (value ? true : "API key is required")
        }
      ]);
      ensureProvider(config, loginAnswers.provider);
      config.providers[loginAnswers.provider].apiKey = loginAnswers.apiKey.trim();
      await saveConfig(config);
      storedProviders.push(loginAnswers.provider);
      preselectedProvider = loginAnswers.provider;
    }
    const answers = await inquirer.prompt([
      {
        type: "list",
        name: "provider",
        message: "Choose a provider",
        choices: [
          { name: "OpenAI", value: "openai" },
          { name: "Gemini", value: "gemini" }
        ],
        when: !preselectedProvider
      },
      {
        type: "input",
        name: "prompt",
        message: "Image prompt"
      },
      {
        type: "list",
        name: "model",
        message: "Select a model",
        choices: (answers) => modelChoices(answers.provider || preselectedProvider),
        default: (answers) => latestModel(answers.provider || preselectedProvider)
      },
      {
        type: "number",
        name: "count",
        message: "Number of images",
        default: 1
      },
      {
        type: "input",
        name: "size",
        message: "Size (e.g. 1024x1024) or leave blank",
        when: (answers) => answers.provider === "openai"
      },
      {
        type: "input",
        name: "aspect",
        message: "Aspect ratio (e.g. 1:1, 16:9) or leave blank",
        when: (answers) => answers.provider === "gemini"
      },
      {
        type: "input",
        name: "out",
        message: "Output directory or .png filename",
        default: "out"
      }
    ]);

    const provider = preselectedProvider || answers.provider;
    const prompt = answers.prompt;
    const n = Number.isFinite(answers.count) && answers.count > 0 ? answers.count : 1;
    const out = answers.out;
    const model = answers.model || latestModel(provider);

    const apiKey = config.providers[provider]?.apiKey;
    if (!apiKey) {
      console.error(`No API key found for ${provider}. Run 'imgcli login'.`);
      process.exit(1);
    }

    let stopLoading;
    try {
      stopLoading = startLoadingBox();
      let buffers;
      if (provider === "openai") {
        const size = answers.size || "1024x1024";
        buffers = await openaiGenerate({ apiKey, prompt, size, n, model });
      } else {
        const aspectRatio = answers.aspect || "1:1";
        buffers = await geminiGenerate({ apiKey, prompt, aspectRatio, n, model });
      }

      stopLoading();
      const outputs = await writeOutputs(buffers, out, provider);
      outputs.forEach((file) => console.log(`Saved ${file}`));
    } catch (err) {
      stopLoading?.();
      console.error(err.message || err);
      process.exit(1);
    }
  });

program.parse();
