import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";

let cachedClient = null;
let cachedProvider = null;
let cachedKey = null;
let cachedProject = null;
let cachedRegion = null;
let cachedGeminiKey = null;

function getClient() {
  if (
    cachedClient &&
    cachedProvider === config.apiProvider &&
    cachedKey === config.apiKey &&
    cachedProject === config.vertex.projectId &&
    cachedRegion === config.vertex.region &&
    cachedGeminiKey === config.geminiApiKey
  ) {
    return cachedClient;
  }

  cachedProvider = config.apiProvider;
  cachedKey = config.apiKey;
  cachedProject = config.vertex.projectId;
  cachedRegion = config.vertex.region;
  cachedGeminiKey = config.geminiApiKey;

  if (config.apiProvider === "vertex") {
    cachedClient = new AnthropicVertex({
      projectId: config.vertex.projectId,
      region: config.vertex.region,
    });
  } else if (config.apiProvider === "gemini") {
    cachedClient = new GoogleGenerativeAI(config.geminiApiKey || "mock-key");
  } else {
    cachedClient = new Anthropic({ apiKey: config.apiKey || "mock-key" });
  }

  return cachedClient;
}

function mapModelName(model, provider) {
  if (provider === "vertex") {
    if (model === "claude-sonnet-4-6" || model.includes("sonnet")) {
      return "claude-3-5-sonnet@20241022";
    }
    if (model.includes("haiku")) {
      return "claude-3-5-haiku@20241022";
    }
    if (model.includes("opus")) {
      return "claude-3-opus@20240229";
    }
    return model;
  } else if (provider === "gemini") {
    if (model === "claude-sonnet-4-6" || model.includes("sonnet")) {
      return "gemini-1.5-pro";
    }
    if (model.includes("haiku")) {
      return "gemini-1.5-flash";
    }
    if (model.includes("opus")) {
      return "gemini-1.5-pro";
    }
    return model;
  } else {
    if (model === "claude-sonnet-4-6" || model.includes("sonnet")) {
      return "claude-3-5-sonnet-20241022";
    }
    if (model.includes("haiku")) {
      return "claude-3-5-haiku-20241022";
    }
    if (model.includes("opus")) {
      return "claude-3-opus-20240229";
    }
    return model;
  }
}

function convertSchemaToGemini(schema) {
  if (!schema) return undefined;
  const copy = JSON.parse(JSON.stringify(schema));
  
  function traverse(obj) {
    if (obj && typeof obj === "object") {
      if (typeof obj.type === "string") {
        obj.type = obj.type.toUpperCase();
      }
      for (const key in obj) {
        traverse(obj[key]);
      }
    }
  }
  traverse(copy);
  return copy;
}

function translateMessagesToGemini(messages) {
  const geminiHistory = [];
  
  for (const msg of messages) {
    let role = msg.role === "assistant" ? "model" : "user";
    const hasToolResult = Array.isArray(msg.content) && msg.content.some(item => item.type === "tool_result");
    if (hasToolResult) {
      role = "function";
    }
    const parts = [];
    
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === "text") {
          parts.push({ text: item.text });
        } else if (item.type === "tool_use") {
          const part = {
            functionCall: {
              name: item.name,
              args: item.input
            }
          };
          if (item.thoughtSignature) {
            part.thoughtSignature = item.thoughtSignature;
          }
          parts.push(part);
        } else if (item.type === "tool_result") {
          // Resolve tool name by scanning previous messages
          let toolName = "tool";
          for (const priorMsg of messages) {
            if (Array.isArray(priorMsg.content)) {
              const use = priorMsg.content.find(x => x.type === "tool_use" && x.id === item.tool_use_id);
              if (use) {
                toolName = use.name;
                break;
              }
            }
          }
          
          let parsedResponse = item.content;
          try {
            parsedResponse = JSON.parse(item.content);
          } catch {}

          parts.push({
            functionResponse: {
              name: toolName,
              response: { name: toolName, content: parsedResponse }
            }
          });
        }
      }
    }
    
    geminiHistory.push({ role, parts });
  }
  
  return geminiHistory;
}

/**
 * One model turn. Returns { text, toolCalls, stopReason, raw }.
 * Callers own the conversation array and append results themselves —
 * the Foreman deliberately reconstructs context instead of growing
 * one giant transcript (see foreman.js#buildContext).
 */
export async function modelTurn({ model, system, messages, tools, maxTokens = 4096 }) {
  const mappedModel = mapModelName(model, config.apiProvider);

  if (config.apiProvider === "gemini") {
    const ai = getClient();
    
    const geminiTools = [];
    if (tools?.length) {
      const functionDeclarations = tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: convertSchemaToGemini(t.input_schema)
      }));
      geminiTools.push({ functionDeclarations });
    }

    const geminiHistory = translateMessagesToGemini(messages);
    const activeMsg = geminiHistory.pop();
    const activeParts = activeMsg ? activeMsg.parts : [];

    const modelInstance = ai.getGenerativeModel({
      model: mappedModel,
      ...(system ? { systemInstruction: system } : {}),
      ...(geminiTools.length ? { tools: geminiTools } : {})
    });

    const chat = modelInstance.startChat({
      history: geminiHistory
    });

    let attempts = 0;
    while (true) {
      try {
        const result = await chat.sendMessage(activeParts);
        const response = await result.response;
        const candidate = response.candidates?.[0];
        const resContent = candidate?.content;
        const parts = resContent?.parts || [];

        const text = parts.filter(p => p.text).map(p => p.text).join("\n");
        const toolCalls = parts
          .filter(p => p.functionCall)
          .map(p => ({
            id: p.functionCall.name + "_" + Math.random().toString(36).substring(2, 7),
            name: p.functionCall.name,
            input: p.functionCall.args,
            thoughtSignature: p.thoughtSignature
          }));

        const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

        const content = [];
        if (text) {
          content.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
            thoughtSignature: tc.thoughtSignature
          });
        }

        return { text, toolCalls, stopReason, raw: { content } };
      } catch (err) {
        attempts++;
        const errMsg = err.message || String(err);
        const isRateLimit = errMsg.includes("429") || errMsg.includes("Quota exceeded") || errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("overloaded");
        if (isRateLimit && attempts <= 15) {
          let delayMs = Math.pow(2, attempts) * 2000 + Math.random() * 1000;
          const match = errMsg.match(/retry in ([0-9.]+)\s*s/i);
          if (match) {
            const recommended = Math.ceil(parseFloat(match[1]) * 1000) + 5000;
            delayMs = Math.max(delayMs, recommended);
          } else {
            delayMs = Math.max(delayMs, 65000);
          }
          console.warn(`[LLM] Gemini rate-limit/high-demand hit (attempt ${attempts}/15). Sleeping for ${(delayMs/1000).toFixed(1)}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  let attempts = 0;
  while (true) {
    try {
      const res = await getClient().messages.create({
        model: mappedModel,
        max_tokens: maxTokens,
        system,
        messages,
        ...(tools?.length ? { tools } : {}),
      });

      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const toolCalls = res.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return { text, toolCalls, stopReason: res.stop_reason, raw: res };
    } catch (err) {
      attempts++;
      const errMsg = err.message || String(err);
      const isRateLimit = errMsg.includes("429") || errMsg.includes("503") || errMsg.includes("overloaded") || errMsg.includes("limit");
      if (isRateLimit && attempts <= 15) {
        const delayMs = Math.pow(2, attempts) * 2000 + Math.random() * 1000;
        console.warn(`[LLM] Anthropic/Vertex rate-limit/overloaded hit (attempt ${attempts}/15). Sleeping for ${(delayMs/1000).toFixed(1)}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/** Helper: format tool results back into a user message. */
export function toolResultsMessage(results) {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}
