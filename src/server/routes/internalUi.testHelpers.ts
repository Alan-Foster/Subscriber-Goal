import type { Request, Response, Router } from "express";

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

export function captureUiRoutes(
  register: (router: Router) => void,
): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();
  register({
    post: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
  } as unknown as Router);
  return routes;
}
