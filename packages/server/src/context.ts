// oxlint-disable
import dotenv from "dotenv";

dotenv.config({
  path: "../../packages/server/.env",
});

export type CreateContextOptions = {};

export async function createContext({}: CreateContextOptions) {
  return {
    env: {
      OPENAI_COMPATIBLE_API_URL: process.env.OPENAI_COMPATIBLE_API_URL!,
      OPENAI_COMPATIBLE_BASE_KEY: process.env.OPENAI_COMPATIBLE_BASE_KEY!,
      OPENAI_COMPATIBLE_MODEL: process.env.OPENAI_COMPATIBLE_MODEL!,
      OPENAI_COMPATIBLE_PROVIDER: process.env.OPENAI_COMPATIBLE_PROVIDER!,
    },
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
