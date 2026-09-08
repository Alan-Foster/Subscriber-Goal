import express from "express";
import { createTelemetryRouter } from "@devvit/analytics/server/reddit";
import { createServer, getServerPort } from "@devvit/web/server";
import { registerInternalSystemRoutes } from "./routes/internalSystem";
import { registerInternalUiRoutes } from "./routes/internalUi";
import { registerPublicApiRoutes } from "./routes/publicApi";
import { unhandledRequestErrorHandler } from "./utils/requestErrorBoundary";
import { logDiagnostic } from "../shared/diagnostics";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());
app.use(createTelemetryRouter());

const router = express.Router();

registerPublicApiRoutes(router);
registerInternalSystemRoutes(router);
registerInternalUiRoutes(router);

app.use(router);
app.use(unhandledRequestErrorHandler);

const port = getServerPort();

const server = createServer(app);
server.on("error", (error) =>
  logDiagnostic("error", "server_error", { workflow: "server" }, error),
);
server.listen(port);
