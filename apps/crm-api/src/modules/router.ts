import { Router } from "express";
import { asyncHandler } from "../core/http/async-handler.js";
import { createAuthRouter } from "./auth/router.js";
import { createBanksRouter } from "./banks/router.js";
import { createBuyoutsRouter } from "./buyouts/router.js";
import { getProductSnapshot } from "./catalog.js";
import { createClientsRouter } from "./clients/router.js";
import { createDocumentsRouter } from "./documents/router.js";
import { createEquipmentRouter } from "./equipment/router.js";
import { createFleetRouter } from "./fleet/router.js";
import { createFinanceRouter } from "./finance/router.js";
import { createGpsRouter } from "./gps/router.js";
import { getImplementationProgress } from "./progress.js";
import { createImportsRouter } from "./imports/router.js";
import { createLegacyRouter } from "./legacy/router.js";
import { createNotificationsRouter } from "./notifications/router.js";
import { createOrdersRouter } from "./orders/router.js";
import { createRepairsRouter } from "./repairs/router.js";
import { createRentalsRouter } from "./rentals/router.js";
import { createTariffsRouter } from "./tariffs/router.js";
import { createUsersRouter } from "./users/router.js";

export function createApiRouter() {
  const router = Router();

  router.get("/system/health", asyncHandler(async (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "crm-api",
      timestamp: new Date().toISOString()
    });
  }));

  router.get("/meta/product", asyncHandler(async (_req, res) => {
    res.status(200).json(getProductSnapshot().product);
  }));

  router.get("/meta/modules", asyncHandler(async (_req, res) => {
    res.status(200).json({
      rows: getProductSnapshot().modules
    });
  }));

  router.get("/meta/navigation", asyncHandler(async (_req, res) => {
    res.status(200).json({
      rows: getProductSnapshot().navigation
    });
  }));

  router.get("/meta/schema", asyncHandler(async (_req, res) => {
    res.status(200).json({
      rows: getProductSnapshot().dataModel
    });
  }));

  router.get("/meta/roadmap", asyncHandler(async (_req, res) => {
    const snapshot = getProductSnapshot();
    res.status(200).json({
      mvp: snapshot.mvp,
      phaseTwo: snapshot.phaseTwo,
      references: snapshot.references
    });
  }));

  router.get("/meta/progress", asyncHandler(async (_req, res) => {
    res.status(200).json(getImplementationProgress());
  }));

  router.use("/auth", createAuthRouter());
  router.use("/legacy", createLegacyRouter());
  router.use("/orders", createOrdersRouter());
  router.use("/tariffs", createTariffsRouter());
  router.use("/clients", createClientsRouter());
  router.use("/bikes", createFleetRouter());
  router.use("/repairs", createRepairsRouter());
  router.use("/rentals", createRentalsRouter());
  router.use("/buyouts", createBuyoutsRouter());
  router.use("/banks", createBanksRouter());
  router.use("/finance", createFinanceRouter());
  router.use("/gps", createGpsRouter());
  router.use("/imports", createImportsRouter());
  router.use("/documents", createDocumentsRouter());
  router.use("/equipment", createEquipmentRouter());
  router.use("/notifications", createNotificationsRouter());
  router.use("/users", createUsersRouter());

  return router;
}
