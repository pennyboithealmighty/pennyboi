// The real LLM caller: Anthropic Messages API. Model, temperature and max
// tokens come from env so they can change without code edits (ANTHROPIC_MODEL).

import Anthropic from "@anthropic-ai/sdk";
import { envNum, envStr, requireEnv } from "@pennyboi/shared";
import type { CallLLM } from "./decide.js";

export interface AnthropicSettings {
  model: string;
  temperature: number;
  maxTokens: number;
}

export function anthropicSettings(): AnthropicSettings {
  return {
    model: envStr("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
    temperature: envNum("BRAIN_TEMPERATURE", 0.9),
    maxTokens: envNum("BRAIN_MAX_TOKENS", 1024),
  };
}

export function makeAnthropicCaller(): CallLLM {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const cfg = anthropicSettings();
  const client = new Anthropic({ apiKey });

  return async (system: string, user: string): Promise<string> => {
    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      system,
      messages: [{ role: "user", content: user }],
    });
    return resp.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  };
}
