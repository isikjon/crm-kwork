import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4200),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  FILE_STORAGE_ROOT: z.string().min(1).default("./storage"),
  JWT_SECRET: z.string().min(8, "JWT_SECRET must be at least 8 characters"),
  LEGACY_CRM_DATA_DIR: z
    .string()
    .min(1)
    .default("/Users/Thompson/Documents/codex project/New project/apps/backend/data"),
  LEGACY_MOYSKLAD_CONNECTION_FILE: z
    .string()
    .min(1)
    .default("/Users/Thompson/Documents/codex project/New project/apps/backend/data/connection.json")
});

export const env = envSchema.parse(process.env);
