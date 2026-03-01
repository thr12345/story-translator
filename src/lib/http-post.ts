import http from "http";
import https from "https";
import { URL } from "url";

export interface HttpPostOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpPostResponse {
  status: number;
  statusText: string;
  ok: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

/**
 * Minimal HTTP/HTTPS POST helper built on Node's `http`/`https` modules.
 *
 * Exists solely to work around Bun's hard 5-minute cap on `fetch` timeouts:
 * https://github.com/oven-sh/bun/issues/16682
 */
export async function httpPost(
  url: string,
  body: unknown,
  options: HttpPostOptions = {},
): Promise<HttpPostResponse> {
  const { headers = {}, timeoutMs = 5 * 60 * 1000 } = options;

  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const bodyStr = JSON.stringify(body);

  const requestOptions: http.RequestOptions = {
    method: "POST",
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
      ...headers,
    },
  };

  return new Promise<HttpPostResponse>((resolve, reject) => {
    // Guard against resolve/reject being called more than once (e.g. timeout
    // fires at the same time as an error event).
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => chunks.push(chunk));

      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        const statusText = res.statusMessage ?? "";

        const response: HttpPostResponse = {
          status,
          statusText,
          ok: status >= 200 && status < 300,
          text: () => Promise.resolve(rawBody),
          json: <T>() => {
            try {
              return Promise.resolve(JSON.parse(rawBody) as T);
            } catch {
              return Promise.reject(
                new Error(`Failed to parse JSON response: ${rawBody}`),
              );
            }
          },
        };

        settle(() => resolve(response));
      });

      res.on("error", (err) => settle(() => reject(err)));
    });

    req.setTimeout(timeoutMs, () => {
      // Destroy the socket to free resources, then reject directly — do NOT
      // rely on destroy() emitting an error event, which is unreliable in
      // Bun's Node compatibility layer.
      req.destroy();
      settle(() =>
        reject(
          Object.assign(
            new Error(
              `LLM API request timed out after ${Math.round(timeoutMs / 1000)}s. Use --timeout to increase the limit.`,
            ),
            { name: "TimeoutError" },
          ),
        ),
      );
    });

    req.on("error", (err) => settle(() => reject(err)));

    req.write(bodyStr);
    req.end();
  });
}
