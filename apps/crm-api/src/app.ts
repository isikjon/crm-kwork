import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createCurrentActorMiddleware } from "./core/auth/current-actor.js";
import { errorMiddleware } from "./core/http/error-middleware.js";
import { createApiRouter } from "./modules/router.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => {
    res.status(200).json({
      product: "PROKOLESA CRM SaaS",
      apiBase: "/api/v1",
      message: "Separate CRM foundation is running"
    });
  });

  app.use("/api/v1", createCurrentActorMiddleware(), createApiRouter());
  app.use(errorMiddleware);

  return app;
}
