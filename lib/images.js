import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OPENAI_MODELS = [
  { id: "gpt-image-2.5-sunburst", label: "gpt-image-2.5-sunburst (default)" },
  { id: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare" },
  { id: "gpt-image-2.5-sunburst-2026-09-08", label: "gpt-image-2.5-sunburst-2026-09-08 (snapshot)" },
  { id: "gpt-image-2.5-flare-2026-09-08", label: "gpt-image-2.5-flare-2026-09-08 (snapshot)" },
  { id: "gpt-image-2", label: "gpt-image-2" },
  { id: "gpt-image-2-2026-04-21", label: "gpt-image-2-2026-04-21 (snapshot)" },
  { id: "gpt-image-1.5", label: "gpt-image-1.5 (legacy; retires 2026-12-01)" },
  { id: "gpt-image-1-mini", label: "gpt-image-1-mini (legacy; retires 2026-12-01)" },
  { id: "chatgpt-image-latest", label: "chatgpt-image-latest (legacy; retires 2026-12-01)" }
];
const GEMINI_MODELS = [
  { id: "gemini-nano-banana-2.1", label: "gemini-nano-banana-2.1 (default)" },
  { id: "gemini-3.1-flash-image", label: "gemini-3.1-flash-image" },
  { id: "gemini-3.1-flash-lite-image", label: "gemini-3.1-flash-lite-image" },
  { id: "gemini-3-pro-image", label: "gemini-3-pro-image" },
  { id: "gemini-2.5-flash-image", label: "gemini-2.5-flash-image" }
];

const EXTENSIONS = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };

export function validateOptions({ provider, model, count = 1, background, format, quality, out, baseUrl, image = [] }) {
  if (!["openai", "gemini"].includes(provider)) throw new Error("Unsupported provider. Use openai or gemini.");
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Count must be an integer between 1 and 10.");
  if (image.length > 16) throw new Error("At most 16 reference images are supported.");
  if (image.length && provider !== "openai") throw new Error("Reference images currently require OpenAI.");
  const extensionFormat = EXTENSIONS[path.extname(out || "").toLowerCase()];
  const outputFormat = format || extensionFormat || "png";
  if (!["png", "jpeg", "webp"].includes(outputFormat)) throw new Error("Format must be png, jpeg or webp.");
  if (format && extensionFormat && format !== extensionFormat) throw new Error("Output filename extension must match --format.");
  if (background && !["auto", "opaque", "transparent"].includes(background)) throw new Error("Background must be auto, opaque or transparent.");
  if (background === "transparent" && outputFormat === "jpeg") throw new Error("Transparent backgrounds require png or webp; JPEG has no alpha channel.");
  if (quality && !["auto", "low", "medium", "high", "xhigh", "max"].includes(quality)) throw new Error("Invalid quality. Use auto, low, medium, high, xhigh or max.");
  if (provider === "gemini" && (background || quality || outputFormat !== "png")) {
    throw new Error("Background, quality and non-PNG format options require OpenAI. Gemini returns its native PNG output.");
  }
  if (provider === "openai" && baseUrl) throw new Error("--base-url is supported only for Gemini gateways.");
  // Explicit custom model IDs remain supported, including gateway aliases.
  if (["xhigh", "max"].includes(quality) && OPENAI_MODELS.some((m) => m.id === model) && !model.startsWith("gpt-image-2.5-")) {
    throw new Error("xhigh and max quality require gpt-image-2.5-sunburst or gpt-image-2.5-flare.");
  }
  return { format: outputFormat, ...(background ? { background } : {}), ...(quality ? { quality } : {}), ...(image.length ? { images: image } : {}) };
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function randomSlug() {
  return crypto.randomBytes(4).toString("hex");
}

export function inferAspectRatio(size) {
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

export function latestModel(provider) {
  if (provider === "openai") return OPENAI_MODELS[0].id;
  if (provider === "gemini") return GEMINI_MODELS[0].id;
  return undefined;
}

export function modelChoices(provider, savedModel) {
  const models = provider === "openai" ? OPENAI_MODELS : provider === "gemini" ? GEMINI_MODELS : [];
  const choices = models.map((m) => ({ name: m.label, value: m.id }));
  if (savedModel && !choices.some((m) => m.value === savedModel)) choices.unshift({ name: `${savedModel} (saved preference)`, value: savedModel });
  return choices;
}

export async function writeOutputs(buffers, outPath, provider, format = "png") {
  const extension = path.extname(outPath || "");
  const outIsFile = Boolean(EXTENSIONS[extension.toLowerCase()]);
  const dir = outIsFile ? path.dirname(outPath) : (outPath || "out");
  await fs.mkdir(dir, { recursive: true });

  const outputs = [];
  for (let i = 0; i < buffers.length; i += 1) {
    let filePath;
    if (outIsFile) {
      const base = path.basename(outPath, extension);
      const name = buffers.length === 1 ? `${base}${extension}` : `${base}-${i + 1}${extension}`;
      filePath = path.join(dir, name);
    } else {
      filePath = path.join(
        dir,
        `${provider}-${nowStamp()}-${i + 1}-${randomSlug()}.${format}`
      );
    }
    await fs.writeFile(filePath, buffers[i]);
    outputs.push(filePath);
  }
  return outputs;
}

export async function openaiGenerate({ apiKey, prompt, size, n, model, background, format = "png", quality, images = [] }) {
  if (images.length > 16) throw new Error("At most 16 reference images are supported.");
  const parameters = { model, prompt, size, n, output_format: format,
    ...(background ? { background } : {}), ...(quality ? { quality } : {}) };
  const headers = { Authorization: "Bearer " + apiKey };
  let body, endpoint = "generations";
  if (images.length) {
    endpoint = "edits";
    body = new FormData();
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined) body.set(key, String(value));
    for (const filename of images) {
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(filename).toLowerCase()];
      if (!mime) throw new Error("Reference images must be PNG, JPEG or WebP files.");
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Each reference must be a file smaller than 50 MiB.");
      body.append("image[]", new Blob([await fs.readFile(filename)], { type: mime }), path.basename(filename));
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(parameters);
  }
  const res = await fetch("https://api.openai.com/v1/images/" + endpoint, { method: "POST", headers, body });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const resultImages = data.data || [];
  if (!resultImages.length) {
    throw new Error("OpenAI API returned no images");
  }

  const buffers = [];
  for (const img of resultImages) {
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

// Gateways such as Ledger expose one Gemini endpoint, take the model in the
// request body and authenticate with a bearer token rather than an API key.
export async function proxyGeminiGenerate({ apiKey, prompt, n, model, baseUrl, aspectRatio }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/gemini/generateContent`;
  const buffers = [];

  for (let i = 0; i < n; i += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Proxy error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const images = parts.filter((part) => part.inlineData?.data).map((part) => part.inlineData.data);
    if (!images.length) {
      throw new Error("Proxy returned no images");
    }
    images.forEach((img) => buffers.push(Buffer.from(img, "base64")));
  }

  return buffers;
}

export async function geminiGenerate({ apiKey, prompt, aspectRatio, n, model, baseUrl }) {
  if (baseUrl) {
    return proxyGeminiGenerate({ apiKey, prompt, n, model, baseUrl, aspectRatio });
  }

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
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } }
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

