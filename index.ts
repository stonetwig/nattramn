import {
  serve,
  extname,
  ServerRequest,
  Server,
  brotliEncode,
  gzipEncode,
  Sha1
} from './deps.ts';

interface PageData {
  head: string;
  body: string;
  headers?: HeadersInit;
};

interface PageHandlerCallback {
  (req: ServerRequest, params: Record<string, string>): Promise<PageData>;
}

interface Page {
  route: string;
  template: string;
  handler: PageHandlerCallback;
}

interface RouterConfig {
  pages: Page[];
}

export enum CompressionMethod {
  Gzip = 'gzip',
  Brotli = 'br',
  None = 'none',
}

interface ServerConfig {
  compression?: CompressionMethod;
  serveStatic?: string;
}

interface Config {
  server: ServerConfig;
  router: RouterConfig;
}

const MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".js": "application/javascript",
  ".jsx": "text/jsx",
  ".gz": "application/gzip",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "mage/svg+xml",
};

function getContentType(path: string): string | undefined {
  return MEDIA_TYPES[extname(path)];
}

/**
 * Function to decide wether or not we include the part
 * of the template before the <nattramn-router> tag or not.
 *
 * If answerWithPartialContent if true, then anything
 * before <nattramn-router> will not be sent in the request.
 */
function generatePreContent (template: string, answerWithPartialContent: boolean) {
  return answerWithPartialContent ?
    null :
    template.indexOf('<nattramn-router>') !== -1 ? template.split('<nattramn-router>')[0] : template;
}

/**
 * Function to decide wether or not we include the part
 * of the template after the <nattramn-router> tag or not.
 *
 * If answerWithPartialContent if true, then anything
 * after </nattramn-router> will not be sent in the request.
 */
function generatePostContent (template: string, answerWithPartialContent: boolean) {
  return answerWithPartialContent ?
    null :
    template.indexOf('</nattramn-router>') !== -1 ? template.split('</nattramn-router>')[1] : template;
}

function reqToURL (req: ServerRequest) {
  const base = req.conn.localAddr.transport === 'tcp' ? req.conn.localAddr.hostname : 'localhost';

  return new URL(req.url, 'http://' + base);
}

function canHandleRoute (req: ServerRequest, route: string) {
  const reqUrl = reqToURL(req).pathname;
  const requestURL = reqUrl.split('/');
  const routeURL = route.split('/');

  const matches = routeURL
    .map((value, index) => {
      if (value.includes(':')) {
        return true;
      }

      return value === requestURL[index];
    })
    .filter(Boolean);

  return matches.length === routeURL.length && matches.length === requestURL.length;
}

function routeParams (req: ServerRequest, route: string) {
  const requestURL = reqToURL(req).pathname.split('/');
  const routeURL = route.split('/');

  return routeURL.reduce((acc, curr, i) => {
    const keyname = curr.includes(':') ? curr.split(':')[1] : undefined;

    if (keyname) {
      return {
        ...acc,
        [keyname]: requestURL[i],
      };
    }

    return acc;
  }, {});
}

async function proxy (req: ServerRequest, page: Page, config: Config): Promise<PartialResponse> {
  const partialContent = Boolean(req.headers.get('x-partial-content') || reqToURL(req).searchParams.get('partialContent'));
  const pageData = await page.handler(req, routeParams(req, page.route));
  const responseBody = [];

  if (!pageData) {
    throw new Error('Could not create PageData from handler.');
  }

  const { body, head, headers: pageDataHeaders } = pageData;

  const preContent = generatePreContent(page.template, partialContent);

  const headers = new Headers(pageDataHeaders);

  headers.set('Content-Type', 'text/html');

  /*
    If we don't send preConent we still want to update the title in the header on client side navigations.
    Send new title in X-Header-Updates.
  */
   if (!preContent && head) {
    const match = head.match(/<title>(.+)<\/title>/i);

    if (match) {
      const title = match ? match[1] : '';
      const json = JSON.stringify({ title });
      const base64JSON = btoa(unescape(encodeURIComponent(json)));

      headers.set('X-Header-Updates', base64JSON);
    }
  }

  if (preContent) {
    if (head) {
      const preSplit = preContent.split(/<head>/);

      responseBody.push(preSplit[0]);

      // const headMarkup = '<head>' + (config.server.minifyHTML ? minifyHTML(head) : head);
      const headMarkup = '<head>' + head;

      responseBody.push(headMarkup);
      responseBody.push(preSplit[1]);
    } else {
      await req.respond({ body: preContent });
    }
  }

  // const mainBody = config.server.minifyHTML ? minifyHTML(body) : body;
  const mainBody = body;

  responseBody.push(partialContent ? mainBody : `<nattramn-router>${mainBody}</nattramn-router>`);

  const postContent = generatePostContent(page.template, partialContent);

  if (postContent) {
    await responseBody.push(postContent);
  }

  const finalBody =  new TextEncoder().encode(responseBody.join('\n'));

  return { headers, body: finalBody, status: 200 };
}

async function serveStatic (req: ServerRequest, filePath: string, serverConfig: ServerConfig): Promise<PartialResponse> {
  filePath = '.' + filePath;
  const file = await Deno.open(filePath, { read: true });

  try {
    const headers = new Headers();

    const contentType = getContentType(filePath);

    if (contentType) {
      headers.set('content-type', contentType);
    }

    const body = await Deno.readAll(file);

    return { headers, body, status: 200 };
  } finally {
    Deno.close(file.rid);
  }
}

interface PartialResponse {
  status: number;
  body: Uint8Array;
  headers: Headers;
}

export default class Nattramn {
  config: Config;

  constructor (config: Config) {
    this.config = config;

    if (this.config.server.compression === undefined) {
      this.config.server.compression = CompressionMethod.Brotli;
    }

    Object.freeze(this.config);
  }

  async handleRequest (req: ServerRequest): Promise<PartialResponse> {
    const url = reqToURL(req);
    const staticPath = url.pathname.match(this.config.server.serveStatic ?? '');

    const hasExtention = extname(url.pathname) !== "";

    if (hasExtention) {
      if (url.pathname === '/nattramn-client.js') {
        const response = await fetch('https://unpkg.com/nattramn@latest/dist-web/index.bundled.js');
        const arrayBuffer = await response.arrayBuffer();
        let body = new Uint8Array(arrayBuffer);

        const checksum = new Sha1().update(body).hex();

        const headers = new Headers({
          'Content-Type': 'application/javascript'
        });

        return {
          headers,
          status: 200,
          body
        };
      }

      if (staticPath) {
        return serveStatic(req, url.pathname, this.config.server);
      }

      if (this.config.server.serveStatic) {
        return serveStatic(req, '/' + this.config.server.serveStatic + url.pathname, this.config.server);
      }

      throw new Error('Could not find file.');
    }

    const page = this.config.router.pages.find(page => canHandleRoute(req, page.route));

    if (page) {
      return proxy(req, page, this.config);
    } else {
      throw new Error('Could not find route.');
    }
  }

  async handleRequests (server: Server) {
    for await (const req of server) {
      try {
        let { body, status, headers } = await this.handleRequest(req);

        const checksum = new Sha1().update(body).hex();

        headers.set('ETag', checksum);

        if (headers.get('Cache-Control') === null) {
          headers.set('Cache-Control', 'public, max-age=3600');
        }

        const useGzip = this.config.server.compression === 'gzip' && req.headers.get('accept-encoding')?.includes('gzip');
        const useBrotli = this.config.server.compression === 'br' && req.headers.get('accept-encoding')?.includes('br');

        if (useGzip) {
          headers.set('Content-Encoding', 'gzip');
          body = gzipEncode(body);
        }

        if (useBrotli) {
          headers.set('Content-Encoding', 'br');
          body = brotliEncode(body);
        }

        headers.set('Content-Length', String(body.byteLength));

        await req.respond({ body, status, headers });
      } catch (e) {
        console.debug(`Nattramn was asked to answer for ${req.url} but did not find a suitable way to handle it.`);

        if (extname(req.url) === null) {
          console.debug('The route is missing.');
        }

        if (extname(req.url) !== null) {
          console.debug('The file is missing.');
        }

        console.debug(e);
        req.respond({ status: 404, body: 'Not Found' });
      }
    }
  }

  async startServer (port = 5000) {
    const server = serve({ port });

    console.log('Nattramn is running at: http://localhost:' + port);

    await this.handleRequests(server);
  }
}
