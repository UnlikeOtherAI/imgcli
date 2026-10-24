import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { latestModel, modelChoices, validateOptions, openaiGenerate, geminiGenerate, writeOutputs } from "../lib/images.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = path.join(root, "out", "test");
const image = Buffer.from("tiny image fixture");
const encoded = image.toString("base64");
const googleResponse = { candidates: [{ content: { parts: [{ text: "Done" }, { inlineData: { data: encoded, mimeType: "image/png" } }] } }] };
const basic = { provider: "openai", model: latestModel("openai"), count: 1 };

test("current choices include snapshots and preserve custom saved preferences", () => {
  assert.equal(latestModel("openai"), "gpt-image-2.5-sunburst");
  assert.equal(latestModel("gemini"), "gemini-nano-banana-2.1");
  assert(modelChoices("openai").some((m) => m.value === "gpt-image-2.5-flare-2026-09-08"));
  assert(modelChoices("gemini").some((m) => m.value === "gemini-3.1-flash-lite-image"));
  assert.equal(modelChoices("gemini", "private-image-alias")[0].value, "private-image-alias");
  assert(!modelChoices("openai").some((m) => m.value === "dall-e-3"));
  assert(!modelChoices("openai").some((m) => m.value === "gpt-image-1"));
  assert.equal(modelChoices("openai", "gpt-image-1")[0].value, "gpt-image-1");
});

test("encoding inference, alpha compatibility and invalid arguments fail before a request", () => {
  assert.equal(validateOptions({ ...basic, out: "logo.WEBP", background: "transparent" }).format, "webp");
  assert.equal(validateOptions({ ...basic, out: "photo.jpg" }).format, "jpeg");
  for (const count of [0, -1, 1.2, NaN, 11]) assert.throws(() => validateOptions({ ...basic, count }), /integer/);
  assert.throws(() => validateOptions({ ...basic, background: "transparent", out: "logo.jpg" }), /alpha/);
  assert.throws(() => validateOptions({ ...basic, format: "jpeg", out: "logo.png" }), /extension/);
  assert.throws(() => validateOptions({ ...basic, format: "gif" }), /Format/);
  assert.throws(() => validateOptions({ ...basic, background: "clear" }), /Background/);
  assert.throws(() => validateOptions({ ...basic, provider: "gemini", background: "transparent" }), /require OpenAI/);
  assert.throws(() => validateOptions({ ...basic, model: "gpt-image-1.5", quality: "max" }), /require gpt-image-2.5/);
  assert.throws(() => validateOptions({ ...basic, baseUrl: "https://proxy.example" }), /only for Gemini/);
});

test("OpenAI sends explicit alpha, encoding, quality, snapshot, size and image count", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received = { url, ...init, body: JSON.parse(init.body) };
    return Response.json({ data: [{ b64_json: encoded }, { b64_json: encoded }] });
  });
  const buffers = await openaiGenerate({ apiKey: "fixture-key", prompt: "logo", size: "1536x1024", n: 2, model: "gpt-image-2.5-sunburst-2026-09-08", background: "transparent", format: "webp", quality: "high" });
  assert.equal(received.url, "https://api.openai.com/v1/images/generations");
  assert.equal(received.headers.Authorization, "Bearer fixture-key");
  assert.deepEqual(received.body, { model: "gpt-image-2.5-sunburst-2026-09-08", prompt: "logo", size: "1536x1024", n: 2, background: "transparent", output_format: "webp", quality: "high" });
  assert.deepEqual(buffers, [image, image]);
});

test("direct Gemini forwards aspect and current model without placing the API key in URL", async (t) => {
  const received = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received.push({ url, ...init, body: JSON.parse(init.body) });
    return Response.json(googleResponse);
  });
  const buffers = await geminiGenerate({ apiKey: "fixture-key", prompt: "island", aspectRatio: "16:9", n: 2, model: latestModel("gemini") });
  assert.equal(received.length, 2);
  assert.match(received[0].url, /models\/gemini-nano-banana-2.1:generateContent$/);
  assert.equal(received[0].headers["x-goog-api-key"], "fixture-key");
  assert.equal(received[0].body.generationConfig.imageConfig.aspectRatio, "16:9");
  assert.deepEqual(buffers, [image, image]);
});

test("gateway routing keeps bearer authentication and custom model while forwarding aspect", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received = { url, ...init, body: JSON.parse(init.body) };
    return Response.json(googleResponse);
  });
  await geminiGenerate({ apiKey: "fixture-token", prompt: "island", aspectRatio: "3:2", n: 1, model: "custom-image", baseUrl: "https://proxy.example///" });
  assert.equal(received.url, "https://proxy.example/v1/gemini/generateContent");
  assert.equal(received.headers.Authorization, "Bearer fixture-token");
  assert.equal(received.headers["x-goog-api-key"], undefined);
  assert.equal(received.body.model, "custom-image");
  assert.equal(received.body.generationConfig.imageConfig.aspectRatio, "3:2");
});

test("API failures and empty image responses remain failures", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("model unavailable", { status: 404 }));
  await assert.rejects(openaiGenerate({}), /OpenAI API error \(404\)/);
  mock.mock.mockImplementation(async () => Response.json({ data: [] }));
  await assert.rejects(openaiGenerate({}), /no images/);
  mock.mock.mockImplementation(async () => Response.json({ candidates: [] }));
  await assert.rejects(geminiGenerate({ model: "custom-image", n: 1 }), /no images/);
});

test("file outputs retain proper extension for single and multiple images", async () => {
  await fs.mkdir(scratch, { recursive: true });
  const target = await fs.mkdtemp(path.join(scratch, "files-"));
  const outputs = await writeOutputs([image, image], path.join(target, "logo.WEBP"), "openai", "webp");
  assert.deepEqual(outputs.map((p) => path.basename(p)), ["logo-1.WEBP", "logo-2.WEBP"]);
  assert.deepEqual(await fs.readFile(outputs[0]), image);
  const jpeg = await writeOutputs([image], path.join(target, "photo.jpg"), "openai", "jpeg");
  assert.equal(path.basename(jpeg[0]), "photo.jpg");
  const generated = await writeOutputs([image], target, "openai", "webp");
  assert.equal(path.extname(generated[0]), ".webp");
});

test("actual CLI uses saved preference, explicit override and leaves configuration unchanged", async () => {
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "cli-"));
  await fs.mkdir(path.join(dir, ".imgcli"));
  const config = JSON.stringify({ providers: { openai: { apiKey: "fixture-key", model: "gpt-image-1.5" } } });
  await fs.writeFile(path.join(dir, ".imgcli", "config.json"), config);
  const hook = path.join(dir, "fetch.mjs");
  await fs.writeFile(hook, `import fs from 'node:fs';\nglobalThis.fetch = async (url, init) => { fs.writeFileSync(process.env.REQUEST_PATH, init.body); return Response.json({data:[{b64_json:'${encoded}'}]}); };`);
  const request = path.join(dir, "request.json");
  const args = ["--import", pathToFileURL(hook).href, "bin/imgcli.js", "generate", "--non-interactive", "--prompt", "test logo", "--out", path.join(dir, "logo.png"), "--background", "transparent"];
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, REQUEST_PATH: request };
  let result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fs.readFile(request)).model, "gpt-image-1.5");
  result = spawnSync(process.execPath, [...args, "--model", "gpt-image-2.5-sunburst"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(await fs.readFile(request));
  assert.equal(body.model, "gpt-image-2.5-sunburst");
  assert.equal(body.background, "transparent");
  assert.equal(body.output_format, "png");
  assert.equal(await fs.readFile(path.join(dir, ".imgcli", "config.json"), "utf8"), config);
  result = spawnSync(process.execPath, [...args, "--format", "jpeg"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extension/);
});


test("OpenAI reference editing sends actual file bytes with explicit transparent output", async (t) => {
  await fs.mkdir(scratch, { recursive: true });
  const target = await fs.mkdtemp(path.join(scratch, "references-"));
  const refs = [path.join(target, "button.png"), path.join(target, "style.webp")];
  for (const filename of refs) await fs.writeFile(filename, image);
  let received;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    received = {url, ...init};
    return Response.json({data:[{b64_json:encoded}]});
  });
  const buffers = await openaiGenerate({apiKey:"fixture-key",prompt:"smooth button",size:"1024x1024",n:1,model:"gpt-image-2.5-sunburst",background:"transparent",format:"png",quality:"high",images:refs});
  assert.equal(received.url,"https://api.openai.com/v1/images/edits");
  assert.equal(received.headers["Content-Type"],undefined);
  assert.equal(received.body.get("model"),"gpt-image-2.5-sunburst");
  assert.equal(received.body.get("background"),"transparent");
  assert.equal(received.body.get("output_format"),"png");
  assert.equal(received.body.get("quality"),"high");
  const files=received.body.getAll("image[]");
  assert.equal(files.length,2);
  assert.equal(files[0].name,"button.png");
  assert.equal(files[1].type,"image/webp");
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()),image);
  assert.deepEqual(buffers,[image]);
});

test("invalid references fail before a network request", async (t) => {
  const fetch=t.mock.method(globalThis,"fetch",async()=>{throw Error("Unexpected request")});
  assert.throws(()=>validateOptions({...basic,image:Array(17).fill("button.png")}),/At most 16/);
  assert.throws(()=>validateOptions({...basic,provider:"gemini",image:["button.png"]}),/require OpenAI/);
  await assert.rejects(openaiGenerate({images:["bad.svg"]}),/PNG, JPEG or WebP/);
  await assert.rejects(openaiGenerate({images:[path.join(scratch,"missing.png")]}),/ENOENT/);
  assert.equal(fetch.mock.callCount(),0);
});

test("actual CLI forwards reference flags without exposing or changing stored credentials", async () => {
  await fs.mkdir(scratch,{recursive:true});
  const dir=await fs.mkdtemp(path.join(scratch,"reference-cli-"));
  await fs.mkdir(path.join(dir,".imgcli"));
  const config=JSON.stringify({providers:{openai:{apiKey:"fixture-key"}}});
  await fs.writeFile(path.join(dir,".imgcli/config.json"),config);
  const ref=path.join(dir,"button.png");await fs.writeFile(ref,image);
  const request=path.join(dir,"request.json"),hook=path.join(dir,"fetch.mjs");
  await fs.writeFile(hook,'import fs from "node:fs"; globalThis.fetch=async(url,init)=>{fs.writeFileSync(process.env.REQUEST_PATH,JSON.stringify({url,referenceCount:init.body.getAll("image[]").length,background:init.body.get("background")}));return Response.json({data:[{b64_json:"'+encoded+'"}]});};');
  const args=["--import",pathToFileURL(hook).href,"bin/imgcli.js","generate","--non-interactive","--provider","openai","--model","gpt-image-2.5-sunburst","--image",ref,"--prompt","same smooth button","--background","transparent","--out",path.join(dir,"result.png")];
  const result=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,HOME:dir,USERPROFILE:dir,REQUEST_PATH:request},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(request)),{url:"https://api.openai.com/v1/images/edits",referenceCount:1,background:"transparent"});
  assert.equal(await fs.readFile(path.join(dir,".imgcli/config.json"),"utf8"),config);
  assert(!result.stdout.includes("fixture-key"));
});
