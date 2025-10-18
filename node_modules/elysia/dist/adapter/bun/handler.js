"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: !0 });
}, __copyProps = (to, from, except, desc) => {
  if (from && typeof from == "object" || typeof from == "function")
    for (let key of __getOwnPropNames(from))
      !__hasOwnProp.call(to, key) && key !== except && __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: !0 }), mod);
var handler_exports = {};
__export(handler_exports, {
  createStaticHandler: () => createStaticHandler,
  errorToResponse: () => errorToResponse,
  mapCompactResponse: () => mapCompactResponse,
  mapEarlyResponse: () => mapEarlyResponse,
  mapResponse: () => mapResponse
});
module.exports = __toCommonJS(handler_exports);
var import_utils = require('../utils.js'), import_utils2 = require('../../utils.js'), import_cookies = require('../../cookies.js'), import_error = require('../../error.js');
const mapResponse = (response, set2, request) => {
  if ((0, import_utils2.isNotEmpty)(set2.headers) || set2.status !== 200 || set2.cookie)
    switch ((0, import_utils.handleSet)(set2), response?.constructor?.name) {
      case "String":
        return new Response(response, set2);
      case "Array":
      case "Object":
        return set2.headers["content-type"] = "application/json", new Response(JSON.stringify(response), set2);
      case "ElysiaFile":
        return (0, import_utils.handleFile)(
          response.value,
          set2
        );
      case "File":
        return (0, import_utils.handleFile)(response, set2);
      case "Blob":
        return (0, import_utils.handleFile)(response, set2);
      case "ElysiaCustomStatusResponse":
        return set2.status = response.code, mapResponse(
          response.response,
          set2,
          request
        );
      case void 0:
        return response ? new Response(JSON.stringify(response), set2) : new Response("", set2);
      case "Response":
        return handleResponse(response, set2, request);
      case "Error":
        return errorToResponse(response, set2);
      case "Promise":
        return response.then(
          (x) => mapResponse(x, set2, request)
        );
      case "Function":
        return mapResponse(response(), set2, request);
      case "Number":
      case "Boolean":
        return new Response(
          response.toString(),
          set2
        );
      case "Cookie":
        return response instanceof import_cookies.Cookie ? new Response(response.value, set2) : new Response(response?.toString(), set2);
      case "FormData":
        return new Response(response, set2);
      default:
        if (response instanceof Response)
          return handleResponse(response, set2, request);
        if (response instanceof Promise)
          return response.then((x) => mapResponse(x, set2));
        if (response instanceof Error)
          return errorToResponse(response, set2);
        if (response instanceof import_error.ElysiaCustomStatusResponse)
          return set2.status = response.code, mapResponse(
            response.response,
            set2,
            request
          );
        if (
          // @ts-expect-error
          typeof response?.next == "function" || response instanceof ReadableStream
        )
          return handleStream(response, set2, request);
        if (typeof response?.then == "function")
          return response.then((x) => mapResponse(x, set2));
        if (typeof response?.toResponse == "function")
          return mapResponse(response.toResponse(), set2);
        if ("charCodeAt" in response) {
          const code = response.charCodeAt(0);
          if (code === 123 || code === 91)
            return set2.headers["Content-Type"] || (set2.headers["Content-Type"] = "application/json"), new Response(
              JSON.stringify(response),
              set2
            );
        }
        return new Response(response, set2);
    }
  return (
    // @ts-expect-error
    typeof response?.next == "function" || response instanceof ReadableStream ? handleStream(response, set2, request) : mapCompactResponse(response, request)
  );
}, mapEarlyResponse = (response, set2, request) => {
  if (response != null)
    if ((0, import_utils2.isNotEmpty)(set2.headers) || set2.status !== 200 || set2.cookie)
      switch ((0, import_utils.handleSet)(set2), response?.constructor?.name) {
        case "String":
          return new Response(response, set2);
        case "Array":
        case "Object":
          return set2.headers["content-type"] = "application/json", new Response(JSON.stringify(response), set2);
        case "ElysiaFile":
          return (0, import_utils.handleFile)(response.value, set2);
        case "File":
          return (0, import_utils.handleFile)(response, set2);
        case "Blob":
          return (0, import_utils.handleFile)(response, set2);
        case "ElysiaCustomStatusResponse":
          return set2.status = response.code, mapEarlyResponse(
            response.response,
            set2,
            request
          );
        case void 0:
          return response ? new Response(JSON.stringify(response), set2) : void 0;
        case "Response":
          return handleResponse(response, set2, request);
        case "Promise":
          return response.then(
            (x) => mapEarlyResponse(x, set2)
          );
        case "Error":
          return errorToResponse(response, set2);
        case "Function":
          return mapEarlyResponse(response(), set2);
        case "Number":
        case "Boolean":
          return new Response(
            response.toString(),
            set2
          );
        case "FormData":
          return new Response(response);
        case "Cookie":
          return response instanceof import_cookies.Cookie ? new Response(response.value, set2) : new Response(response?.toString(), set2);
        default:
          if (response instanceof Response)
            return handleResponse(response, set2, request);
          if (response instanceof Promise)
            return response.then((x) => mapEarlyResponse(x, set2));
          if (response instanceof Error)
            return errorToResponse(response, set2);
          if (response instanceof import_error.ElysiaCustomStatusResponse)
            return set2.status = response.code, mapEarlyResponse(
              response.response,
              set2,
              request
            );
          if (
            // @ts-expect-error
            typeof response?.next == "function" || response instanceof ReadableStream
          )
            return handleStream(response, set2, request);
          if (typeof response?.then == "function")
            return response.then((x) => mapEarlyResponse(x, set2));
          if (typeof response?.toResponse == "function")
            return mapEarlyResponse(response.toResponse(), set2);
          if ("charCodeAt" in response) {
            const code = response.charCodeAt(0);
            if (code === 123 || code === 91)
              return set2.headers["Content-Type"] || (set2.headers["Content-Type"] = "application/json"), new Response(
                JSON.stringify(response),
                set2
              );
          }
          return new Response(response, set2);
      }
    else
      switch (response?.constructor?.name) {
        case "String":
          return new Response(response);
        case "Array":
        case "Object":
          return set2.headers["content-type"] = "application/json", new Response(JSON.stringify(response), set2);
        case "ElysiaFile":
          return (0, import_utils.handleFile)(response.value, set2);
        case "File":
          return (0, import_utils.handleFile)(response, set2);
        case "Blob":
          return (0, import_utils.handleFile)(response, set2);
        case "ElysiaCustomStatusResponse":
          return set2.status = response.code, mapEarlyResponse(
            response.response,
            set2,
            request
          );
        case void 0:
          return response ? new Response(JSON.stringify(response), {
            headers: {
              "content-type": "application/json"
            }
          }) : new Response("");
        case "Response":
          return response;
        case "Promise":
          return response.then((x) => {
            const r = mapEarlyResponse(x, set2);
            if (r !== void 0) return r;
          });
        case "Error":
          return errorToResponse(response, set2);
        case "Function":
          return mapCompactResponse(response(), request);
        case "Number":
        case "Boolean":
          return new Response(response.toString());
        case "Cookie":
          return response instanceof import_cookies.Cookie ? new Response(response.value, set2) : new Response(response?.toString(), set2);
        case "FormData":
          return new Response(response);
        default:
          if (response instanceof Response) return response;
          if (response instanceof Promise)
            return response.then((x) => mapEarlyResponse(x, set2));
          if (response instanceof Error)
            return errorToResponse(response, set2);
          if (response instanceof import_error.ElysiaCustomStatusResponse)
            return set2.status = response.code, mapEarlyResponse(
              response.response,
              set2,
              request
            );
          if (
            // @ts-expect-error
            typeof response?.next == "function" || response instanceof ReadableStream
          )
            return handleStream(response, set2, request);
          if (typeof response?.then == "function")
            return response.then((x) => mapEarlyResponse(x, set2));
          if (typeof response?.toResponse == "function")
            return mapEarlyResponse(response.toResponse(), set2);
          if ("charCodeAt" in response) {
            const code = response.charCodeAt(0);
            if (code === 123 || code === 91)
              return set2.headers["Content-Type"] || (set2.headers["Content-Type"] = "application/json"), new Response(
                JSON.stringify(response),
                set2
              );
          }
          return new Response(response);
      }
}, mapCompactResponse = (response, request) => {
  switch (response?.constructor?.name) {
    case "String":
      return new Response(response);
    case "Object":
    case "Array":
      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json"
        }
      });
    case "ElysiaFile":
      return (0, import_utils.handleFile)(response.value);
    case "File":
      return (0, import_utils.handleFile)(response);
    case "Blob":
      return (0, import_utils.handleFile)(response);
    case "ElysiaCustomStatusResponse":
      return mapResponse(
        response.response,
        {
          status: response.code,
          headers: {}
        }
      );
    case void 0:
      return response ? new Response(JSON.stringify(response), {
        headers: {
          "content-type": "application/json"
        }
      }) : new Response("");
    case "Response":
      return response;
    case "Error":
      return errorToResponse(response);
    case "Promise":
      return response.then(
        (x) => mapCompactResponse(x, request)
      );
    // ? Maybe response or Blob
    case "Function":
      return mapCompactResponse(response(), request);
    case "Number":
    case "Boolean":
      return new Response(response.toString());
    case "FormData":
      return new Response(response);
    default:
      if (response instanceof Response) return response;
      if (response instanceof Promise)
        return response.then(
          (x) => mapCompactResponse(x, request)
        );
      if (response instanceof Error)
        return errorToResponse(response);
      if (response instanceof import_error.ElysiaCustomStatusResponse)
        return mapResponse(
          response.response,
          {
            status: response.code,
            headers: {}
          }
        );
      if (
        // @ts-expect-error
        typeof response?.next == "function" || response instanceof ReadableStream
      )
        return handleStream(response, void 0, request);
      if (typeof response?.then == "function")
        return response.then((x) => mapResponse(x, set));
      if (typeof response?.toResponse == "function")
        return mapCompactResponse(response.toResponse());
      if ("charCodeAt" in response) {
        const code = response.charCodeAt(0);
        if (code === 123 || code === 91)
          return new Response(JSON.stringify(response), {
            headers: {
              "Content-Type": "application/json"
            }
          });
      }
      return new Response(response);
  }
}, errorToResponse = (error, set2) => new Response(
  JSON.stringify({
    name: error?.name,
    message: error?.message,
    cause: error?.cause
  }),
  {
    status: set2?.status !== 200 ? set2?.status ?? 500 : 500,
    headers: set2?.headers
  }
), createStaticHandler = (handle, hooks, setHeaders = {}) => {
  if (typeof handle == "function") return;
  const response = mapResponse(handle, {
    headers: setHeaders
  });
  if (!hooks.parse?.length && !hooks.transform?.length && !hooks.beforeHandle?.length && !hooks.afterHandle?.length)
    return () => response.clone();
}, handleResponse = (0, import_utils.createResponseHandler)({
  mapResponse,
  mapCompactResponse
}), handleStream = (0, import_utils.createStreamHandler)({
  mapResponse,
  mapCompactResponse
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createStaticHandler,
  errorToResponse,
  mapCompactResponse,
  mapEarlyResponse,
  mapResponse
});
