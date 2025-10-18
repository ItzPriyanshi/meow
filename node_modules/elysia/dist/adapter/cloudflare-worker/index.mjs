import { WebStandardAdapter } from "../web-standard/index.mjs";
function isCloudflareWorker() {
  try {
    if (
      // @ts-ignore
      typeof caches < "u" && // @ts-ignore
      typeof caches.default < "u" || typeof WebSocketPair < "u"
    ) return !0;
  } catch {
    return !1;
  }
  return !1;
}
const CloudflareAdapter = {
  ...WebStandardAdapter,
  name: "cloudflare-worker",
  composeGeneralHandler: {
    ...WebStandardAdapter.composeGeneralHandler,
    error404(hasEventHook, hasErrorHook, afterHandle) {
      const { code } = WebStandardAdapter.composeGeneralHandler.error404(
        hasEventHook,
        hasErrorHook,
        afterHandle
      );
      return {
        code,
        declare: hasErrorHook ? "" : (
          // This only work because Elysia only clone the Response via .clone()
          `const error404Message=notFound.message.toString()
const error404={clone:()=>new Response(error404Message,{status:404})}
`
        )
      };
    }
  },
  beforeCompile(app) {
    for (const route of app.routes) route.compile();
  },
  listen(app) {
    return (options, callback) => {
      console.warn(
        "Cloudflare Worker does not support listen method. Please export default Elysia instance instead."
      ), app.compile();
    };
  }
};
export {
  CloudflareAdapter,
  isCloudflareWorker
};
