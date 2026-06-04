import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

dotenv.config();

export function createDb() {
  const client = createClient({
    url: process.env.DB_FILE_NAME ?? "",
  });

  return drizzle({ client, schema });
}

export const db = createDb();
