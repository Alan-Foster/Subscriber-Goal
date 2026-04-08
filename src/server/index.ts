import express from 'express';
import { createServer, getServerPort } from '@devvit/web/server';
import { registerInternalSystemRoutes } from './routes/internalSystem';
import { registerInternalUiRoutes } from './routes/internalUi';
import { registerPublicApiRoutes } from './routes/publicApi';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());

const router = express.Router();

registerPublicApiRoutes(router);
registerInternalSystemRoutes(router);
registerInternalUiRoutes(router);

app.use(router);

const port = getServerPort();

const server = createServer(app);
server.on('error', (err) => console.error(`server error; ${err.stack}`));
server.listen(port);
