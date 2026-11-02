export const DASHBOARD_URL = "https://enrichlayer.com/dashboard";

export interface Credentials {
  authorization(): string;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      `ENRICHLAYER_API_KEY is not set. Create an API key at ${DASHBOARD_URL}, add it to the env of this MCP server and restart the server.`,
    );
    this.name = "MissingApiKeyError";
  }
}

export class InvalidApiKeyError extends Error {
  constructor() {
    super(
      `ENRICHLAYER_API_KEY contains a space, a line break or another character an API key cannot have. Paste the key again from ${DASHBOARD_URL} into the env of this MCP server and restart the server.`,
    );
    this.name = "InvalidApiKeyError";
  }
}

export function apiKeyCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  return {
    authorization() {
      const key = env.ENRICHLAYER_API_KEY?.trim();
      if (!key) throw new MissingApiKeyError();
      if (/[^\x21-\x7e]/.test(key)) throw new InvalidApiKeyError();
      return `Bearer ${key}`;
    },
  };
}
