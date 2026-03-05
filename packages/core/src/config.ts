import * as v from "valibot";
import { ConfigurationError } from "./errors.js";

export interface CardDavConfig {
  url: string;
  username: string;
  password: string;
}

const CardDavEnvSchema = v.object({
  CARDDAV_URL: v.pipe(v.string("CARDDAV_URL is required"), v.url("CARDDAV_URL must be a valid URL")),
  CARDDAV_USER: v.pipe(v.string("CARDDAV_USER is required"), v.minLength(1, "CARDDAV_USER cannot be empty")),
  CARDDAV_PASS: v.pipe(v.string("CARDDAV_PASS is required"), v.minLength(1, "CARDDAV_PASS cannot be empty")),
});

export function loadCardDavConfig(): CardDavConfig {
  const env = {
    CARDDAV_URL: process.env.CARDDAV_URL,
    CARDDAV_USER: process.env.CARDDAV_USER,
    CARDDAV_PASS: process.env.CARDDAV_PASS,
  };

  try {
    const validated = v.parse(CardDavEnvSchema, env);
    return {
      url: validated.CARDDAV_URL,
      username: validated.CARDDAV_USER,
      password: validated.CARDDAV_PASS,
    };
  } catch (error) {
    if (v.isValiError(error)) {
      const messages = error.issues.map((issue) => {
        const path = issue.path?.map((p) => p.key).join(".") ?? "unknown";
        return `${path}: ${issue.message}`;
      });
      throw new ConfigurationError(`Config validation failed: ${messages.join("; ")}`);
    }
    throw error;
  }
}
