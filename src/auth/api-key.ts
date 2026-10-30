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

export function apiKeyCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  return {
    authorization() {
      const key = env.ENRICHLAYER_API_KEY?.trim();
      if (!key) throw new MissingApiKeyError();
      return `Bearer ${key}`;
    },
  };
}
