#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { latestModel, modelChoices, inferAspectRatio, validateOptions, openaiGenerate, geminiGenerate, writeOutputs } from "../lib/images.js";
import { createRequire } from "module";

const CONFIG_DIR = path.join(os.homedir(), ".imgcli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

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
  config.providers ||= {};
  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
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

const program = new Command();

program
  .name("imgcli")
  .description(pkg.description || "Generate images with OpenAI or Gemini")
  .version(pkg.version);

program
  .command("login")
  .description("Store API key for a provider")
  .option("-p, --provider <provider>", "openai or gemini")
  .option("--base-url <url>", "route Gemini calls through a proxy such as Ledger")
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
      },
      {
        type: "input",
        name: "baseUrl",
        message: "Proxy base URL (optional, blank for the provider directly)",
        when: (current) => !options.baseUrl && (options.provider || current.provider) === "gemini"
      }
    ]);

    const provider = options.provider || answers.provider;
    const apiKey = answers.apiKey.trim();
    const baseUrl = (options.baseUrl || answers.baseUrl || "").trim();

    ensureProvider(config, provider);
    config.providers[provider].apiKey = apiKey;
    if (baseUrl) {
      config.providers[provider].baseUrl = baseUrl;
    } else {
      delete config.providers[provider].baseUrl;
    }
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
  .option("-o, --out <path>", "output directory or .png/.jpg/.jpeg/.webp file")
  .option("-n, --count <number>", "number of images", (v) => Number(v), 1)
  .option("--size <size>", "size like 1024x1024 (OpenAI) or aspect ratio inference (Gemini)")
  .option("--aspect <ratio>", "aspect ratio like 1:1, 4:3, 16:9 (Gemini)")
  .option("--model <model>", "model override (saved preference or current provider default)")
  .option("--image <paths...>", "reference PNG, JPEG or WebP images for OpenAI editing (up to 16)")
  .option("--background <mode>", "OpenAI background: auto, opaque, transparent")
  .option("--format <format>", "OpenAI encoding: png, jpeg, webp (default: inferred from filename or png)")
  .option("--quality <quality>", "OpenAI quality: auto, low, medium, high, xhigh, max")
  .option("--base-url <url>", "route Gemini calls through a proxy such as Ledger")
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
    let model = options.model || config.providers?.[provider]?.model;
    const prompt = options.prompt || answers.prompt;
    const n = options.count;

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

    const apiKey = config.providers?.[provider]?.apiKey;
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
          choices: modelChoices(provider, config.providers[provider]?.model),
          default: config.providers[provider]?.model || latestModel(provider)
        }
      ]);
      model = modelAnswer.model;
    }

    model = model || latestModel(provider);

    let stopLoading;
    try {
      const generation = validateOptions({ ...options, provider, model, count: n });
      stopLoading = startLoadingBox();
      let buffers;
      if (provider === "openai") {
        const size = options.size || "1024x1024";
        buffers = await openaiGenerate({ apiKey, prompt, size, n, model, ...generation });
      } else if (provider === "gemini") {
        const aspectRatio = options.aspect || inferAspectRatio(options.size) || "1:1";
        const baseUrl = options.baseUrl || config.providers[provider]?.baseUrl;
        buffers = await geminiGenerate({ apiKey, prompt, aspectRatio, n, model, baseUrl });
      } else {
        console.error("Unsupported provider. Use openai or gemini.");
        process.exit(1);
      }

      stopLoading();
      const outputs = await writeOutputs(buffers, options.out, provider, generation.format);
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
        choices: (answers) => modelChoices(answers.provider || preselectedProvider, config.providers[answers.provider || preselectedProvider]?.model),
        default: (answers) => config.providers[answers.provider || preselectedProvider]?.model || latestModel(answers.provider || preselectedProvider)
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
        when: (answers) => (answers.provider || preselectedProvider) === "openai"
      },
      {
        type: "input",
        name: "aspect",
        message: "Aspect ratio (e.g. 1:1, 16:9) or leave blank",
        when: (answers) => (answers.provider || preselectedProvider) === "gemini"
      },
      {
        type: "list",
        name: "background",
        message: "Background",
        choices: ["auto", "opaque", "transparent"],
        when: (answers) => (answers.provider || preselectedProvider) === "openai"
      },
      {
        type: "list",
        name: "format",
        message: "Image format",
        choices: (answers) => answers.background === "transparent" ? ["png", "webp"] : ["png", "jpeg", "webp"],
        when: (answers) => (answers.provider || preselectedProvider) === "openai"
      },
      {
        type: "input",
        name: "out",
        message: "Output directory or .png/.jpg/.jpeg/.webp filename",
        default: "out"
      }
    ]);

    const provider = preselectedProvider || answers.provider;
    const prompt = answers.prompt;
    const n = answers.count;
    const out = answers.out;
    const model = answers.model || latestModel(provider);

    const apiKey = config.providers[provider]?.apiKey;
    if (!apiKey) {
      console.error(`No API key found for ${provider}. Run 'imgcli login'.`);
      process.exit(1);
    }

    let stopLoading;
    try {
      const generation = validateOptions({ ...answers, provider, model, count: n });
      stopLoading = startLoadingBox();
      let buffers;
      if (provider === "openai") {
        const size = answers.size || "1024x1024";
        buffers = await openaiGenerate({ apiKey, prompt, size, n, model, ...generation });
      } else {
        const aspectRatio = answers.aspect || "1:1";
        buffers = await geminiGenerate({ apiKey, prompt, aspectRatio, n, model, baseUrl: config.providers[provider]?.baseUrl });
      }

      stopLoading();
      const outputs = await writeOutputs(buffers, out, provider, generation.format);
      outputs.forEach((file) => console.log(`Saved ${file}`));
    } catch (err) {
      stopLoading?.();
      console.error(err.message || err);
      process.exit(1);
    }
  });

program.parseAsync();
