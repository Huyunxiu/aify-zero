import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

dotenv.config();

export function createDb() {
  const client = createClient({
    url: process.env.DATABASE_URL ?? "",
  });

  return drizzle({ client, schema });
}

export const db = createDb();

export * from "./schema";
